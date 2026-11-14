/** Session log chain behavior: read-side links over raw lines, write-path links at acceptance, torn-tail recovery, and closer extension. */

import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { interruptedTurnClosers, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SessionHandleClosedError } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logPath, generationLogPath, toHeaderLine } from '../src/format.ts'
import { compressZstdFrame, decompressZstdFrame, decompressZstdPrefix, scanZstdFrames } from '../src/zstd.ts'
import type { JsonlSessionHandle } from '../src/storage.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const roots: string[] = []
const contexts: Context[] = []

/** The chain tag, spelled here as a literal so the oracle cannot inherit the implementation's value. */
const CHAIN_TAG = 'dsh-session-chain/1'

afterEach(async () => {
  vi.restoreAllMocks()
  const results = await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  const failures = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) throw new AggregateError(failures, 'chain spec fixture cleanup failed')
})

async function freshRoot(prefix = 'dsh-jsonl-chain-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function mount(root: string, compression: 'none' | 'zstd', withStore = false): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  if (withStore) await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  return ctx
}

/** Create + append + close: persist one whole log through the write handle. */
async function writeLog(persistence: SessionPersistence, m: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
  const handle = await persistence.create(m)
  try {
    await handle.append(events)
  } finally {
    await handle.close()
  }
}

/**
 * Independent SHA-256 oracle over one stored plaintext: the first line seeds
 * the chain, each later line extends it with its raw bytes.
 */
function oracle(plaintext: Buffer): string[] {
  const lines: Buffer[] = []
  let start = 0
  for (let newline = plaintext.indexOf(0x0A); newline !== -1; newline = plaintext.indexOf(0x0A, start)) {
    lines.push(plaintext.subarray(start, newline))
    start = newline + 1
  }
  const header = lines[0]
  if (header === undefined) throw new Error('oracle plaintext has no header line')
  let previous = createHash('sha256').update(CHAIN_TAG, 'utf8').update(header).digest()
  const links: string[] = []
  for (const line of lines.slice(1)) {
    previous = createHash('sha256').update(previous).update(line).digest()
    links.push(previous.toString('hex'))
  }
  return links
}

/** Read every link off a chain, in seq order. */
function chainLinks(chain: { readonly length: number; linkAt(seq: number): string | undefined }): string[] {
  const links: string[] = []
  for (let seq = 0; seq < chain.length; seq++) {
    const link = chain.linkAt(seq)
    if (link === undefined) throw new Error(`chain has no link at seq ${String(seq)}`)
    links.push(link)
  }
  return links
}

/** Decode every complete frame of a frame list with no torn tail. */
async function decodeCompleteFrames(buffer: Buffer): Promise<Buffer> {
  const { frames, tornStart } = scanZstdFrames(buffer)
  expect(tornStart).toBeUndefined()
  const plaintext: Buffer[] = []
  for (const frame of frames) {
    plaintext.push(await decompressZstdFrame(buffer.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(plaintext)
}

/** Truncate one compressed frame so a scan reports it torn and the recovered plaintext satisfies `accepts`. */
async function tornFrame(plaintext: string, accepts: (decoded: string) => boolean = () => true): Promise<Buffer> {
  const frame = await compressZstdFrame(plaintext)
  const candidateEnds = [
    frame.length - 1,
    frame.length - 4,
    ...[0.9, 0.75, 0.6, 0.5, 0.4, 0.25].map(ratio => Math.floor(frame.length * ratio)),
  ]
  for (const end of candidateEnds) {
    const candidate = frame.subarray(0, end)
    if (scanZstdFrames(candidate).tornStart !== 0) continue
    try {
      const decoded = (await decompressZstdPrefix(candidate)).toString('utf8')
      if (accepts(decoded)) return candidate
    } catch {
      // Some early cuts precede the first decodable block; keep searching for
      // a cut that exercises partial-plaintext recovery.
    }
  }
  throw new Error('test fixture could not produce the requested torn Zstandard frame')
}

function deterministicNoise(length: number): string {
  let state = 0x12345678
  let output = ''
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    output += String.fromCharCode(33 + (state % 90))
  }
  return output
}

/** A retired event type the current encoder refuses, from the admission spec's obsolete vocabulary. */
function refusedEvent(seq: number): never {
  return {
    type: 'tool/code-dispatch-start',
    seq,
    time: 2,
    data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read', arguments: {} },
  } as never
}

/** Event rows whose stored bytes are deliberately not `JSON.stringify` output. */
function handWrittenLines(header: SessionHeader): { readonly headerText: string; readonly rows: string[] } {
  return {
    headerText: JSON.stringify(toHeaderLine(header)).replaceAll('":', '": '),
    rows: [
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }).replaceAll('":', '": '),
      JSON.stringify({
        type: 'user/message', seq: 1, time: 2, surfaceOp: 'append',
        data: createUserMessage({ content: [{ type: 'text', text: 'café' }], source: { kind: 'user' } }),
      }).replace('café', 'caf\\u00e9'),
    ],
  }
}

describe('JsonlSessionPersistence: the Session log chain', () => {
  it('links a hand-written plaintext log whose lines are not JSON.stringify output', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const header = meta('hand-written', '/proj')
    const { headerText, rows } = handWrittenLines(header)
    const path = logPath(root, header.cwd, header.id, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${headerText}\n${rows.join('\n')}\n`)

    const reader = await ctx.sessionPersistence.open(header.id, 'read')
    try {
      const read = await reader.read()
      expect(read.events.map(event => event.seq)).toEqual([0, 1])
      const chain = read.chain
      expect(chain).toBeDefined()
      expect(chain?.length).toBe(2)
      expect(chain ? chainLinks(chain) : []).toEqual(oracle(await readFile(path)))
      expect(chain?.linkAt(-1)).toBeUndefined()
      expect(chain?.linkAt(2)).toBeUndefined()
    } finally {
      await reader.close()
    }
  })

  it('links the same lines identically when the log is stored as Zstandard frames', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'zstd')
    const header = meta('hand-written', '/proj')
    const { headerText, rows } = handWrittenLines(header)
    const path = logPath(root, header.cwd, header.id, 'zstd')
    await mkdir(dirname(path), { recursive: true })
    const headerFrame = await compressZstdFrame(`${headerText}\n`)
    const bodyFrame = await compressZstdFrame(`${rows.join('\n')}\n`)
    await writeFile(path, Buffer.concat([headerFrame, bodyFrame]))

    const reader = await ctx.sessionPersistence.open(header.id, 'read')
    try {
      const read = await reader.read()
      expect(read.chain ? chainLinks(read.chain) : [])
        .toEqual(oracle(Buffer.from(`${headerText}\n${rows.join('\n')}\n`, 'utf8')))
    } finally {
      await reader.close()
    }
  })

  it('sends a follower-visible live link inside the batching window equal to the stored link', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none', true)
    const cwd = join(root, 'workspace')
    const session = ctx.sessions.create(undefined, { meta: { cwd } })
    const handle = await ctx.sessionPersistence.create(session.header)
    const texts = [
      'plain',
      'café \u{1F600} \u2028 line-sep',
      'quote " backslash \\ tab \t',
      'lone \uD800 surrogate',
      'x'.repeat(70_000),
    ]
    const recorded: string[] = []
    for (const text of texts) {
      const event = session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      const link = ctx.sessionPersistence.liveChain?.(session.id)?.linkAt(event.seq)
      if (link === undefined) throw new Error(`no live link for seq ${String(event.seq)} inside the batching window`)
      recorded.push(link)
    }
    await ctx.sessions.flush(session)
    await handle.close()

    const path = logPath(root, cwd, session.id, 'none')
    expect(oracle(await readFile(path))).toEqual(recorded)
    const reader = await ctx.sessionPersistence.open(session.id, 'read')
    try {
      const read = await reader.read()
      expect(read.chain ? chainLinks(read.chain) : []).toEqual(recorded)
    } finally {
      await reader.close()
    }
  })

  it('links an explicit append before its write resolves, and a reread agrees', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const header = meta('explicit-append', '/work')
    const handle = await ctx.sessionPersistence.create(header)
    const appended = handle.append(oneTurnLog())
    const live = ctx.sessionPersistence.liveChain?.(header.id)
    expect(live?.length).toBe(6)
    const accepted = live ? chainLinks(live) : []
    await appended
    await handle.close()

    const path = logPath(root, header.cwd, header.id, 'none')
    expect(accepted).toEqual(oracle(await readFile(path)))
    const reader = await ctx.sessionPersistence.open(header.id, 'read')
    try {
      const read = await reader.read()
      expect(read.chain ? chainLinks(read.chain) : []).toEqual(accepted)
    } finally {
      await reader.close()
    }
  })

  it('chains created sessions from the materialized header line, which an empty flush writes unchanged', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const header = meta('flush-first', '/work')
    let pendingFirstLink: string | undefined
    const handle = await ctx.sessionPersistence.create(header)
    await handle.flush()
    await handle.close()

    const path = logPath(root, header.cwd, header.id, 'none')
    const flushed = await readFile(path)
    // The explicit flush materialized exactly the header line.
    expect(flushed.subarray(0, flushed.length - 1).toString('utf8'))
      .toBe(JSON.stringify(toHeaderLine(header)))
    expect(oracle(flushed)).toEqual([])

    // The empty log's chain extends from the header link alone.
    const emptyReader = await ctx.sessionPersistence.open(header.id, 'read')
    try {
      const read = await emptyReader.read()
      expect(read.chain?.length).toBe(0)
      const unlinked = read.chain?.extend?.([oneTurnLog()[0]!])
      expect(unlinked?.length).toBe(1)
      if (unlinked === undefined) throw new Error('empty chain did not extend')
      pendingFirstLink = unlinked.linkAt(0)
    } finally {
      await emptyReader.close()
    }

    const writer = await ctx.sessionPersistence.open(header.id, 'write')
    try {
      await writer.append(oneTurnLog())
    } finally {
      await writer.close()
    }
    const appended = await readFile(path)
    // The appended log keeps the flushed header bytes as its prefix.
    expect(appended.subarray(0, flushed.length)).toEqual(flushed)
    const reader = await ctx.sessionPersistence.open(header.id, 'read')
    try {
      const read = await reader.read()
      const stored = oracle(appended)
      expect(read.chain ? chainLinks(read.chain) : []).toEqual(stored)
      expect(read.chain?.length).toBe(6)
      expect(pendingFirstLink).toBe(stored[0])
    } finally {
      await reader.close()
    }
  })

  it('links recovered torn-tail records and rewrites them byte for byte', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'zstd')
    const header = meta('chain-torn', '/proj')
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const committed = await readFile(path)
    const committedPlaintext = await decodeCompleteFrames(committed)

    const recovered: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(6), time: 7, data: { turn: 2 } },
      { type: 'step/start', seq: SessionSeq(7), time: 8, data: { turn: 2, step: 1 } },
      {
        type: 'assistant/attempt',
        seq: SessionSeq(8),
        time: 9,
        data: {
          turn: 2,
          step: 1,
          stream: [{ type: 'text-chunks', time0: 9, index: 0, dt: [], texts: [deterministicNoise(300_000)] }],
        },
      },
    ]
    const plaintext = recovered.map(event => JSON.stringify(event).replaceAll('":', '": ')).join('\n') + '\n'
    await appendFile(path, await tornFrame(plaintext, (decoded) => {
      const newlines = decoded.match(/\n/g)?.length ?? 0
      return newlines >= 2 && !decoded.endsWith('\n')
    }))

    const torn = await readFile(path)
    const tornStart = scanZstdFrames(torn).tornStart
    if (tornStart === undefined) throw new Error('torn frame marker missing after the fixture append')
    const recoveredPlaintext = await decompressZstdPrefix(torn.subarray(tornStart))
    const recoveredComplete = recoveredPlaintext.subarray(0, recoveredPlaintext.lastIndexOf(0x0A) + 1)
    const beforeRepair = Buffer.concat([committedPlaintext, recoveredComplete])

    const reader = await ctx.sessionPersistence.open(header.id, 'read')
    try {
      const read = await reader.read()
      expect(read.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      expect(read.chain ? chainLinks(read.chain) : []).toEqual(oracle(beforeRepair))
    } finally {
      await reader.close()
    }

    const writer = await ctx.sessionPersistence.open(header.id, 'write')
    try {
      await writer.append([
        { type: 'step/end', seq: SessionSeq(8), time: 10, data: { turn: 2, step: 1 } },
        { type: 'turn/end', seq: SessionSeq(9), time: 11, data: { turn: 2, reason: { kind: 'completed' } } },
      ])
    } finally {
      await writer.close()
    }

    const repaired = await readFile(path)
    expect(scanZstdFrames(repaired).tornStart).toBeUndefined()
    const repairedPlaintext = await decodeCompleteFrames(repaired)
    // The recovered records were rewritten with their original bytes.
    expect(repairedPlaintext.subarray(0, beforeRepair.length)).toEqual(beforeRepair)
    const reread = await ctx.sessionPersistence.open(header.id, 'read')
    try {
      const read = await reread.read()
      expect(read.chain ? chainLinks(read.chain) : []).toEqual(oracle(repairedPlaintext))
    } finally {
      await reread.close()
    }
  })

  it('stops the live chain on an event the encoder refuses and fails the next flush with that error', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const header = meta('encode-refused', '/work')
    const handle = await ctx.sessionPersistence.create(header) as JsonlSessionHandle
    try {
      handle.enqueueLive(refusedEvent(0), () => {})
      expect(ctx.sessionPersistence.liveChain?.(header.id)?.length).toBe(0)
      // A later live event cannot continue the stopped chain.
      handle.enqueueLive({ type: 'turn/start', seq: SessionSeq(1), time: 3, data: { turn: 1 } }, () => {})
      expect(ctx.sessionPersistence.liveChain?.(header.id)?.length).toBe(0)
      const failure = await ctx.sessionPersistence.flush().then(() => undefined, (error: unknown) => error)
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toHaveLength(1)
      expect(String((failure as AggregateError).errors[0]))
        .toContain('format v4 rejects retired event type tool/code-dispatch-start')
    } finally {
      await handle.close().then(() => undefined, () => undefined)
    }
  })

  it('truncates the live chain to its earlier length when an explicit append fails', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const header = meta('truncating-append', '/work')
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())
    const writer = await ctx.sessionPersistence.open(header.id, 'write')
    try {
      const live = ctx.sessionPersistence.liveChain?.(header.id)
      expect(live?.length).toBe(6)
      const failure = new Error('append refused')
      vi.spyOn(ctx.sessionPersistence as SessionPersistence & { persistBatch: () => Promise<void> }, 'persistBatch')
        .mockRejectedValueOnce(failure)
      const more: SessionEvent[] = [
        { type: 'turn/start', seq: SessionSeq(6), time: 7, data: { turn: 2 } },
        { type: 'turn/end', seq: SessionSeq(7), time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
      ]
      await expect(writer.append(more)).rejects.toBe(failure)
      expect(ctx.sessionPersistence.liveChain?.(header.id)?.length).toBe(6)
      expect(ctx.sessionPersistence.liveChain?.(header.id)?.linkAt(6)).toBeUndefined()
      await writer.append(more)
      expect(ctx.sessionPersistence.liveChain?.(header.id)?.length).toBe(8)
    } finally {
      await writer.close()
    }
    expect(ctx.sessionPersistence.liveChain?.(header.id)).toBeUndefined()
    const path = logPath(root, header.cwd, header.id, 'none')
    const reader = await ctx.sessionPersistence.open(header.id, 'read')
    try {
      const read = await reader.read()
      expect(read.chain ? chainLinks(read.chain) : []).toEqual(oracle(await readFile(path)))
      expect(read.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    } finally {
      await reader.close()
    }
  })

  it('removes the links of an append that close() refuses in the same tick', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const header = meta('closed-append', '/work')
    const handle = await ctx.sessionPersistence.create(header) as JsonlSessionHandle
    try {
      const appended = handle.append(oneTurnLog())
      const closing = handle.close()
      await expect(appended).rejects.toBeInstanceOf(SessionHandleClosedError)
      expect(handle.chain?.length).toBe(0)
      await closing
    } finally {
      await handle.close().then(() => undefined, () => undefined)
    }
    expect(ctx.sessionPersistence.liveChain?.(header.id)).toBeUndefined()
  })

  it('answers no live chain without a write handle, and reads never extend the shared chain', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const header = meta('shared-chain', '/work')
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())
    expect(ctx.sessionPersistence.liveChain?.(header.id)).toBeUndefined()

    const first = await ctx.sessionPersistence.open(header.id, 'read')
    const shared = (await first.read()).chain
    expect(shared?.length).toBe(6)
    const durable = shared ? chainLinks(shared) : []
    await first.close()
    expect(ctx.sessionPersistence.liveChain?.(header.id)).toBeUndefined()

    const second = await ctx.sessionPersistence.open(header.id, 'read')
    try {
      const reread = (await second.read()).chain
      expect(reread ? chainLinks(reread) : []).toEqual(durable)
      expect(shared?.length).toBe(6)
    } finally {
      await second.close()
    }

    const writer = await ctx.sessionPersistence.open(header.id, 'write')
    try {
      await writer.append([
        { type: 'turn/start', seq: SessionSeq(6), time: 7, data: { turn: 2 } },
        { type: 'turn/end', seq: SessionSeq(7), time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
      ])
    } finally {
      await writer.close()
    }
    const third = await ctx.sessionPersistence.open(header.id, 'read')
    try {
      const grown = (await third.read()).chain
      expect(grown).not.toBe(shared)
      expect(grown?.length).toBe(8)
      expect(shared?.length).toBe(6)
    } finally {
      await third.close()
    }
    expect(ctx.sessionPersistence.liveChain?.(header.id)).toBeUndefined()
  })

  it('extends a read chain with the interrupted-turn closers the writer would append', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const header = meta('open-tool-turn', '/work')
    const stored: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message',
        seq: SessionSeq(2),
        time: 3,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          stream: [],
          message: createMessage({
            role: 'assistant',
            source: { kind: 'model', provider: 'mock', model: 'mock' },
            content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'read', arguments: '{}' }],
          }),
        },
      },
      { type: 'tool/call', seq: SessionSeq(3), time: 4, data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'read', arguments: '{}' } },
    ]
    await writeLog(ctx.sessionPersistence, header, stored)

    const reader = await ctx.sessionPersistence.open(header.id, 'read')
    const read = await reader.read()
    await reader.close()
    expect(read.events.map(event => event.seq)).toEqual([0, 1, 2, 3])

    const closers = interruptedTurnClosers(read.events)
    expect(closers.map(event => event.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
    const chain = read.chain
    expect(chain?.extend?.([])).toBe(chain)
    const extended = chain?.extend?.(closers)
    expect(extended).toBeDefined()
    expect(chain?.length).toBe(4)

    const writer = await ctx.sessionPersistence.open(header.id, 'write')
    try {
      await writer.append(closers)
      await writer.flush()
    } finally {
      await writer.close()
    }
    const path = logPath(root, header.cwd, header.id, 'none')
    const durable = oracle(await readFile(path))
    expect(extended ? chainLinks(extended) : []).toEqual(durable)
    expect(extended ? chainLinks(extended).slice(0, 4) : []).toEqual(chain ? chainLinks(chain) : [])
    expect(chain?.length).toBe(4)
    expect(extended?.length).toBe(7)
    expect(extended?.linkAt(7)).toBeUndefined()

    expect(chain?.extend?.([
      { type: 'turn/end', seq: SessionSeq(9), time: 9, data: { turn: 1, reason: { kind: 'interrupted' } } },
    ])).toBeUndefined()
    expect(chain?.extend?.([refusedEvent(4)])).toBeUndefined()
  })

  it('grows the packed link buffer past its initial capacity', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const header = meta('growing-chain', '/work')
    const events: SessionEvent[] = []
    for (let index = 0; index < 70; index++) {
      events.push(index % 2 === 0
        ? { type: 'turn/start', seq: SessionSeq(index), time: index + 1, data: { turn: index / 2 + 1 } }
        : { type: 'turn/end', seq: SessionSeq(index), time: index + 1, data: { turn: (index - 1) / 2 + 1, reason: { kind: 'completed' } } })
    }
    const handle = await ctx.sessionPersistence.create(header)
    await handle.append(events)
    await handle.close()

    const path = logPath(root, header.cwd, header.id, 'none')
    const reader = await ctx.sessionPersistence.open(header.id, 'read')
    try {
      const read = await reader.read()
      expect(read.chain?.length).toBe(70)
      expect(read.chain ? chainLinks(read.chain) : []).toEqual(oracle(await readFile(path)))
    } finally {
      await reader.close()
    }
  })
})

/** Rows that are exactly the encoder's own bytes: one canonical hand-written log. */
function canonicalLines(header: SessionHeader): { readonly headerText: string; readonly rows: string[] } {
  return {
    headerText: JSON.stringify(toHeaderLine(header)),
    rows: [
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
      JSON.stringify({
        type: 'user/message', seq: 1, time: 2, surfaceOp: 'append',
        data: createUserMessage({ content: [{ type: 'text', text: 'hand written' }], source: { kind: 'user' } }),
      }),
      JSON.stringify({ type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } }),
      JSON.stringify({ type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } }),
      JSON.stringify({ type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } }),
    ],
  }
}

/** The committed lines of a plaintext log, without their newlines. */
function plaintextLines(plaintext: Buffer): Buffer[] {
  const lines: Buffer[] = []
  let start = 0
  for (let newline = plaintext.indexOf(0x0A); newline !== -1; newline = plaintext.indexOf(0x0A, start)) {
    lines.push(plaintext.subarray(start, newline))
    start = newline + 1
  }
  return lines
}

/**
 * One stored v3 generation: an interrupted first turn, an inbox splice, and a
 * completed second turn, as the migration tests' restart fixture writes it.
 */
async function writeV3Log(root: string, id: SessionId, compression: 'none' | 'zstd'): Promise<string> {
  const path = generationLogPath(root, undefined, id, 3, compression)
  const message = { id: 'next', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }
  const rows = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [message] } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: message, surfaceOp: 'append' },
    { type: 'session/title', data: { title: 'continue', source: { kind: 'fallback' }, messageSeqs: [5] } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq, time: seq + 10 }))
  const header = { type: 'session', version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }
  const first = `${JSON.stringify(header)}\n`
  const body = rows.map(row => `${JSON.stringify(row)}\n`).join('')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, compression === 'none' ? first + body
    : Buffer.concat([await compressZstdFrame(first), await compressZstdFrame(body)]))
  return path
}

describe('JsonlSessionPersistence: stored lines served from the chain', () => {
  it('keeps the stored header line and answers every stored line of a hand-written plaintext log', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const header = meta('stored-line-plain', '/proj')
    const { headerText, rows } = canonicalLines(header)
    const path = logPath(root, header.cwd, header.id, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${headerText}\n${rows.join('\n')}\n`)

    const reader = await ctx.sessionPersistence.open(header.id, 'read')
    try {
      const read = await reader.read()
      const chain = read.chain
      if (chain === undefined) throw new Error('stored chain missing')
      const storedLines = plaintextLines(await readFile(path))
      expect(chain.headerLine).toBeDefined()
      expect(Array.from(chain.headerLine ?? [])).toEqual(Array.from(storedLines[0] as Buffer))
      for (const event of read.events) {
        expect(Array.from(chain.storedLine?.(event) ?? [])).toEqual(Array.from(storedLines[event.seq + 1] as Buffer))
      }
      const refused: SessionEvent = { type: 'turn/start', seq: SessionSeq(4), time: 9, data: { turn: 9 } }
      expect(chain.storedLine?.({ ...refused, seq: -1 as SessionSeq })).toBeUndefined()
      expect(chain.storedLine?.({ ...refused, seq: SessionSeq(5) })).toBeUndefined()
      expect(chain.storedLine?.(refusedEvent(4))).toBeUndefined()
    } finally {
      await reader.close()
    }
  })

  it('answers the same stored lines when the log is stored as Zstandard frames', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'zstd')
    const header = meta('stored-line-zstd', '/proj')
    const { headerText, rows } = canonicalLines(header)
    const path = logPath(root, header.cwd, header.id, 'zstd')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, Buffer.concat([
      await compressZstdFrame(`${headerText}\n`),
      await compressZstdFrame(`${rows.join('\n')}\n`),
    ]))

    const reader = await ctx.sessionPersistence.open(header.id, 'read')
    try {
      const read = await reader.read()
      const chain = read.chain
      if (chain === undefined) throw new Error('stored chain missing')
      const storedLines = plaintextLines(await decodeCompleteFrames(await readFile(path)))
      expect(Array.from(chain.headerLine ?? [])).toEqual(Array.from(storedLines[0] as Buffer))
      for (const event of read.events) {
        expect(Array.from(chain.storedLine?.(event) ?? [])).toEqual(Array.from(storedLines[event.seq + 1] as Buffer))
      }
    } finally {
      await reader.close()
    }
  })

  it('refuses only the stored line whose bytes are not the encoder output', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const header = meta('stored-line-spaced', '/proj')
    const { headerText, rows } = canonicalLines(header)
    const spaced = rows.map((row, index) => index === 2 ? row.replaceAll('":', '": ') : row)
    const path = logPath(root, header.cwd, header.id, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${headerText}\n${spaced.join('\n')}\n`)

    const reader = await ctx.sessionPersistence.open(header.id, 'read')
    try {
      const read = await reader.read()
      const chain = read.chain
      if (chain === undefined) throw new Error('stored chain missing')
      const storedLines = plaintextLines(await readFile(path))
      for (const event of read.events) {
        const line = chain.storedLine?.(event)
        if (event.seq === 2) {
          expect(line).toBeUndefined()
          expect(chain.linkAt(2)).toBeDefined()
        } else {
          expect(Array.from(line ?? [])).toEqual(Array.from(storedLines[event.seq + 1] as Buffer))
        }
      }
    } finally {
      await reader.close()
    }
  })

  it('answers the interrupted closers\' encoded lines on an extended chain from a cold read', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const header = meta('stored-closers', '/work')
    const stored: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message',
        seq: SessionSeq(2),
        time: 3,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          stream: [],
          message: createMessage({
            role: 'assistant',
            source: { kind: 'model', provider: 'mock', model: 'mock' },
            content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'read', arguments: '{}' }],
          }),
        },
      },
      { type: 'tool/call', seq: SessionSeq(3), time: 4, data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'read', arguments: '{}' } },
    ]
    await writeLog(ctx.sessionPersistence, header, stored)

    const reader = await ctx.sessionPersistence.open(header.id, 'read')
    const read = await reader.read()
    await reader.close()
    const closers = interruptedTurnClosers(read.events)
    const chain = read.chain
    if (chain === undefined) throw new Error('stored chain missing')
    const extended = chain.extend?.(closers)
    if (extended === undefined) throw new Error('cold chain did not extend')

    const writer = await ctx.sessionPersistence.open(header.id, 'write')
    try {
      await writer.append(closers)
      await writer.flush()
    } finally {
      await writer.close()
    }
    const path = logPath(root, header.cwd, header.id, 'none')
    const storedLines = plaintextLines(await readFile(path))
    const baseCount = storedLines.length - closers.length
    for (const [index, closer] of closers.entries()) {
      expect(Array.from(extended.storedLine?.(closer) ?? [])).toEqual(Array.from(storedLines[baseCount + index] as Buffer))
    }
    for (const event of read.events) {
      expect(Array.from(extended.storedLine?.(event) ?? [])).toEqual(Array.from(storedLines[event.seq + 1] as Buffer))
    }
    expect(extended.storedLine?.(refusedEvent(closers.length))).toBeUndefined()
    expect(extended.storedLine?.(refusedEvent(closers.length + 2))).toBeUndefined()
    expect(extended.storedLine?.({ ...(read.events[0] as SessionEvent), seq: SessionSeq(99) })).toBeUndefined()
    expect(extended.storedLine?.({ ...(closers[0] as SessionEvent), time: 999 })).toBeUndefined()
  })

  it('chains the read-migrated log and its published successor link for link', async () => {
    const root = await freshRoot()
    const id = SessionId('chain-v3')
    await writeV3Log(root, id, 'none')

    const preparedCtx = await mount(root, 'none')
    const preparedReader = await preparedCtx.sessionPersistence.open(id, 'read')
    let preparedChain: { readonly length: number; linkAt(seq: number): string | undefined; readonly headerLine?: Uint8Array } | undefined
    let preparedCount = 0
    try {
      const read = await preparedReader.read()
      if (read.chain === undefined) throw new Error('migrated read has no chain')
      preparedCount = read.events.length
      expect(read.chain.length).toBe(preparedCount)
      preparedChain = read.chain
    } finally {
      await preparedReader.close()
    }

    const writer = await preparedCtx.sessionPersistence.open(id, 'write')
    try {
      expect((await writer.read()).events).toHaveLength(preparedCount)
    } finally {
      await writer.close()
    }

    const successorPath = generationLogPath(root, undefined, id, 4, 'none')
    const successor = await readFile(successorPath)
    const storedLines = plaintextLines(successor)
    const durable = oracle(successor)
    if (preparedChain === undefined) throw new Error('prepared chain missing')
    expect(chainLinks(preparedChain)).toEqual(durable)

    const freshCtx = await mount(root, 'none')
    const freshReader = await freshCtx.sessionPersistence.open(id, 'read')
    try {
      const read = await freshReader.read()
      if (read.chain === undefined) throw new Error('published read has no chain')
      expect(chainLinks(read.chain)).toEqual(durable)
      expect(Array.from(read.chain.headerLine ?? [])).toEqual(Array.from(storedLines[0] as Buffer))
      expect(Array.from(read.chain.headerLine ?? [])).toEqual(Array.from(preparedChain.headerLine ?? []))
      for (const event of read.events) {
        expect(Array.from(read.chain.storedLine?.(event) ?? [])).toEqual(Array.from(storedLines[event.seq + 1] as Buffer))
      }
    } finally {
      await freshReader.close()
    }
  })
})

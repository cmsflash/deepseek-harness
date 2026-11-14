/** Copy-backed page reads equal the Host's history over the same log (§2.8 equality). */

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LocalHistoryPage } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { assistantStreamFirstTokenTime } from '@deepseek-ai/dsh-llm/assistant-stream'
import {
  DEFAULT_MAX_MESSAGES, detailPage, elidedEventsOfTurn, historyTurnUsage, pageRecords, paginate,
} from '@deepseek-ai/dsh-api-session-controller/history-shared'
import { headerLinkOf, linkOf, nextLink } from '../src/client/worker/chain.ts'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { buildChunkInputs, LocalCopyStore } from '../src/client/worker/store.ts'
import { localElided, localInterval, localOpening, localPage, type PagesStore } from '../src/client/worker/pages.ts'
import { collapseCorpus } from './collapse-corpus.client.ts'

const sessionId = brandString<SessionId>('session-pages')
const encoder = new TextEncoder()

/** One scripted log fixture with its stored lines and chain links. */
interface Fixture {
  readonly header: string
  readonly events: readonly SessionEvent[]
  readonly lines: readonly string[]
  readonly headerLink: Uint8Array<ArrayBuffer>
  readonly links: readonly Uint8Array<ArrayBuffer>[]
}

/** Build an event quickly, giving it a seq and time slot. */
function at(type: string, data: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, data, time: 1_700_000_000_000, ...extra }
}

/** A stepped-turn script with assistant messages that carry compact streams. */
function scriptLog(): readonly Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  let seq = 0
  const push = (type: string, data: unknown, extra: Record<string, unknown> = {}) => {
    events.push({ ...at(type, data, extra), seq })
    seq += 1
  }
  push('request/header', { header: { config: { model: 'fk-1' } }, reason: 'initial' })
  for (const turn of [1, 2, 3]) {
    push('turn/start', { turn })
    for (const step of [1, 2, 3]) {
      push('step/start', { turn, step })
      push('user/message', { source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: `t${String(turn)}s${String(step)}` }] } }, { surfaceOp: 'append' })
      push('tool/call', { turn, step, callId: `c${String(turn)}${String(step)}`, name: 'write', arguments: '{}' })
      push('tool/result', { turn, step, message: { callId: `c${String(turn)}${String(step)}`, content: [{ type: 'text', text: 'ok' }] } }, { surfaceOp: 'append' })
      push('assistant/message', {
        turn,
        step,
        message: { role: 'assistant', content: [{ type: 'text', text: 'work' }], source: { kind: 'model', provider: 'fake', model: 'fk-1' } },
        stream: [
          { type: 'text-chunks', time0: 1_700_000_000_100, index: 0, dt: [1], texts: ['a'] },
          { type: 'chunk', time: 1_700_000_000_200, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
          { type: 'chunk', time: 1_700_000_000_300, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'work' } } },
        ],
      }, { surfaceOp: 'append' })
      push('step/end', { turn, step })
    }
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return events
}

async function buildFixture(events: readonly Record<string, unknown>[], header = '{"version":4,"id":"pages"}'): Promise<Fixture> {
  const headerLink = await headerLinkOf(encoder.encode(header))
  const lines: string[] = []
  const links: Uint8Array<ArrayBuffer>[] = []
  let previous = headerLink
  for (const event of events) {
    const line = JSON.stringify(event)
    previous = await nextLink(previous, encoder.encode(line))
    lines.push(line)
    links.push(previous)
  }
  return { header, events: events as readonly SessionEvent[], lines, headerLink, links }
}

/** Fill a fresh store with one whole fixture; the small default chunk budget stores one line per chunk. */
async function filledStore(fixture: Fixture, chunkBytes = 128): Promise<LocalCopyStore> {
  const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
  const stored = fixture.events.map((_event, index) => ({
    seq: index,
    bytes: encoder.encode(fixture.lines[index] ?? ''),
    link: fixture.links[index] ?? new Uint8Array(32),
  }))
  await store.replaceThread(sessionId, fixture.header, linkOf(fixture.headerLink), buildChunkInputs(sessionId, stored, chunkBytes), {
    state: 'complete',
    complete: true,
    cursorSeen: fixture.events.length - 1,
  })
  return store
}

/** Chunk budget that stores a whole long fixture in one chunk, so a read decodes its lines without a long cursor walk. */
const ONE_CHUNK = 1 << 20

/** One long turn: `turn/start` at 0, user messages at 1..599, `turn/end` at 600, longer than the first page read of 512 events. */
function longTurn(): Record<string, unknown>[] {
  return [
    { ...at('turn/start', { turn: 1 }), seq: 0 },
    ...Array.from({ length: 599 }, (_value, index) => ({
      ...at('user/message', { source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: `m${String(index + 1)}` }] } }, { surfaceOp: 'append' }),
      seq: index + 1,
    })),
    { ...at('turn/end', { turn: 1, reason: { kind: 'completed' } }), seq: 600 },
  ]
}

type CroppedPage = { hasMore: boolean; digests?: readonly unknown[]; records: unknown[] }

interface PageRequest {
  readonly beforeSeq?: number
  readonly maxMessages?: number
  readonly throughSeq: number
  readonly turnWindow?: { readonly minMessages: number; readonly minTurns: number }
  readonly stepDetail?: 'full' | 'collapsed'
}

/** The Host's own page, from the shared functions over the whole log. */
function hostPage(fixture: Fixture, request: PageRequest): CroppedPage {
  const before = request.beforeSeq === undefined ? undefined : SessionLogOffset(request.beforeSeq)
  const page = paginate(
    fixture.events, before,
    request.maxMessages ?? DEFAULT_MAX_MESSAGES, SessionSeq(request.throughSeq), request.turnWindow, 0,
  )
  const usage = historyTurnUsage(page.events, fixture.events)
  const detail = detailPage(
    page.events, fixture.events, request.stepDetail, usage.byEnd,
    seq => linkOf(fixture.links[seq] ?? new Uint8Array(32)),
  )
  const host: CroppedPage = { hasMore: page.hasMore, records: detail.records }
  if (detail.digests !== undefined) host.digests = detail.digests
  return host
}

/** The copy's page, cropped to the fields both sides share. */
function cropPage(page: LocalHistoryPage | undefined): CroppedPage | undefined {
  if (page === undefined) return undefined
  return {
    hasMore: page.hasMore,
    ...(page.digests === undefined ? {} : { digests: page.digests }),
    records: page.records.map(record => ({
      type: 'event',
      event: record.event,
      ...(record.turnUsage === undefined ? {} : { turnUsage: record.turnUsage }),
      ...(record.covers === undefined ? {} : { covers: record.covers }),
      ...(record.link === undefined ? {} : { link: record.link }),
    })),
  }
}

/** The Host's interval records, with usage over the whole log. */
function hostInterval(fixture: Fixture, fromSeq: number, throughSeq: number): unknown[] {
  const events = (fixture.events as SessionEvent[]).slice(fromSeq, throughSeq + 1)
  const usage = historyTurnUsage(events, (fixture.events as SessionEvent[]).slice(0, throughSeq + 1))
  return pageRecords(events, usage.byEnd)
}

/** Open the local-copy database directly on a factory the store already created. */
function rawDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('dsh-local-copy')
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('fixture: database open failed')) }
  })
}

/** Events that live at seqs 3..12 of a log, a three-step turn inside a copy that starts mid-log. */
function holedEvents(): readonly Record<string, unknown>[] {
  return [
    { ...at('turn/start', { turn: 1 }), seq: 3 },
    { ...at('step/start', { turn: 1, step: 1 }), seq: 4 },
    { ...at('tool/call', { turn: 1, step: 1, callId: 'hole-1', name: 'write', arguments: '{}' }), seq: 5 },
    { ...at('step/end', { turn: 1, step: 1 }), seq: 6 },
    { ...at('step/start', { turn: 1, step: 2 }), seq: 7 },
    { ...at('tool/call', { turn: 1, step: 2, callId: 'hole-2', name: 'write', arguments: '{}' }), seq: 8 },
    { ...at('step/end', { turn: 1, step: 2 }), seq: 9 },
    { ...at('step/start', { turn: 1, step: 3 }), seq: 10 },
    { ...at('step/end', { turn: 1, step: 3 }), seq: 11 },
    { ...at('turn/end', { turn: 1, reason: { kind: 'completed' } }), seq: 12 },
  ]
}

/** One raw-seeded copy whose only stored chunk covers seqs 3..5 with head 5. */
async function holedStore(events: readonly Record<string, unknown>[]): Promise<{ store: LocalCopyStore; factory: IDBFactory }> {
  const fixture = await buildFixture(events)
  const factory = new IDBFactory()
  const store = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
  await store.ensureThread(sessionId, 1)
  const stored: { seq: number; bytes: Uint8Array<ArrayBuffer>; link: Uint8Array<ArrayBuffer> }[] = []
  for (const [index, text] of fixture.lines.entries()) {
    const seq = events[index]?.['seq']
    if (typeof seq === 'number') stored.push({ seq, bytes: encoder.encode(text), link: fixture.links[index] ?? new Uint8Array(32) })
  }
  const chunks = buildChunkInputs(sessionId, stored, 128)
  if (chunks.length === 0) throw new Error('fixture: holed events produced no chunks')
  const connection = await rawDatabase(factory)
  await new Promise<void>((resolve, reject) => {
    const tx = connection.transaction(['threads', 'chunks'], 'readwrite')
    for (const chunk of chunks) tx.objectStore('chunks').put(chunk, [sessionId, chunk.first])
    tx.objectStore('threads').put({
      sessionId, chainTag: 'dsh-session-chain/1', header: fixture.header,
      headerLink: toHexOf(fixture.headerLink), head: events.at(-1)?.['seq'] as number,
      headLink: toHexOf(fixture.links.at(-1) ?? new Uint8Array(32)),
      lineBytes: fixture.lines.reduce((total, line) => total + line.length + 1, 0) - 1,
      chunkCount: chunks.length, cursorSeen: events.at(-1)?.['seq'] as number, complete: true, state: 'complete',
      openedAt: 1, syncedAt: 1, activityAt: 0, activitySeq: -1, activityRunning: false,
    }, sessionId)
    tx.oncomplete = () => { connection.close(); resolve() }
    tx.onerror = () => { reject(tx.error ?? new Error('fixture: holed seed failed')) }
  })
  return { store, factory }
}

/** Hex of link bytes for the raw rows. */
function toHexOf(bytes: Uint8Array): string {
  return linkOf(bytes)
}

describe('local copy pages, holes and limits', () => {
  it('answers nothing for a thread with no copy or an unverifiable one', async () => {
    const fixture = await buildFixture(scriptLog())
    const missing = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    const window = { maxMessages: 5, throughSeq: 2, full: false }
    expect(await localOpening(missing, sessionId, window, false)).toBeUndefined()
    expect(await localPage(missing, sessionId, window)).toBeUndefined()
    expect(await localInterval(missing, sessionId, { fromSeq: 0, throughSeq: 2, full: false })).toBeUndefined()
    expect(await localElided(missing, sessionId, { turn: 1, throughSeq: 2, full: false })).toBeUndefined()
    const store = await filledStore(fixture)
    const complete = await localOpening(store, sessionId, { maxMessages: 5, full: false }, false)
    expect(complete).not.toBeUndefined()
    expect(complete).not.toHaveProperty('partial')
    await store.markThread(sessionId, { state: 'unverifiable', problem: { code: 'chain-mismatch', at: 1 } })
    expect(await localOpening(store, sessionId, { maxMessages: 5, full: false }, false)).toBeUndefined()
    expect(await localPage(store, sessionId, window)).toBeUndefined()
  })

  it('drops a copy that does not start at seq 0 and answers no read from it', async () => {
    const { store } = await holedStore(holedEvents())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await localInterval(store, sessionId, { fromSeq: 3, throughSeq: 12, full: true })).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
    expect(await store.readThread(sessionId)).toBeUndefined()
    expect(await localPage(store, sessionId, { beforeSeq: 13, maxMessages: 5, throughSeq: 12, full: true })).toBeUndefined()
  })

  it('serves an elided turn that closed at or below the head when the cut sits above it', async () => {
    const filler = [0, 1, 2].map(seq => ({ ...at('feedback/record', {}), seq }))
    const store = await filledStore(await buildFixture([...filler, ...holedEvents()]))
    expect(await localInterval(store, sessionId, { fromSeq: 5, throughSeq: 4, full: true })).toEqual([])
    const elided = await localElided(store, sessionId, { turn: 1, throughSeq: 14, full: true })
    expect(elided?.map(record => record.event.seq)).toEqual([5, 8])
    expect(await localElided(store, sessionId, { turn: 2, throughSeq: 14, full: true })).toBeUndefined()
    const fromSeven = await localElided(store, sessionId, { turn: 1, fromSeq: 7, throughSeq: 14, full: true })
    expect(fromSeven?.map(record => record.event.seq)).toEqual([8])
  })

  it('answers nothing when the wanted turn never starts below the cut', async () => {
    const events = Array.from({ length: 4 }, (_value, index) => ({
      ...at('user/message', { source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: `t${String(index)}` }] } }, { surfaceOp: 'append' }),
      seq: index,
    }))
    const fixture = await buildFixture(events)
    const store = await filledStore(fixture)
    expect(await localElided(store, sessionId, { turn: 1, throughSeq: 3, full: true })).toBeUndefined()
  })

  it('answers nothing for a turn that a later turn superseded without an end', async () => {
    const events = [
      { ...at('turn/start', { turn: 1 }), seq: 0 },
      { ...at('user/message', { source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: 'first' }] } }, { surfaceOp: 'append' }), seq: 1 },
      { ...at('turn/start', { turn: 2 }), seq: 2 },
      { ...at('user/message', { source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: 'second' }] } }, { surfaceOp: 'append' }), seq: 3 },
    ]
    const fixture = await buildFixture(events)
    const store = await filledStore(fixture)
    expect(await localElided(store, sessionId, { turn: 1, throughSeq: 9, full: true })).toBeUndefined()
  })

  it('looks one scan block below a long single turn and grows its first read', async () => {
    const store = await filledStore(await buildFixture(longTurn()), ONE_CHUNK)
    const page = await localPage(store, sessionId, {
      beforeSeq: 600, maxMessages: 600, turnWindow: { minMessages: 2, minTurns: 2 }, throughSeq: 600, full: true,
    })
    expect(page?.records.map(record => record.event.seq)).toContain(0)
  })

  it('leaves a stream that already ends at its first token unstripped', async () => {
    const events: Record<string, unknown>[] = [
      { ...at('turn/start', { turn: 1 }), seq: 0 },
      {
        ...at('assistant/message', {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'fake', model: 'fk-1' } },
          stream: [{ type: 'text-chunks', time0: 1_700_000_000_100, index: 0, dt: [1], texts: ['ok'] }],
        }, { surfaceOp: 'append' }),
        seq: 1,
      },
      { ...at('turn/end', { turn: 1, reason: { kind: 'completed' } }), seq: 2 },
    ]
    const fixture = await buildFixture(events)
    const store = await filledStore(fixture)
    const page = await localPage(store, sessionId, { maxMessages: 5, throughSeq: 2, full: false })
    const assistant = page?.records.find(record => record.event.type === 'assistant/message')
    expect(assistant?.stripped).toBeUndefined()
    expect((assistant?.event.data as { stream?: unknown[] }).stream).toHaveLength(1)
  })

  it('serves a window whose only budget is the default message count', async () => {
    const fixture = await buildFixture(scriptLog())
    const store = await filledStore(fixture)
    const page = await localPage(store, sessionId, { throughSeq: 12, full: true })
    const host = hostPage(fixture, { throughSeq: 12 })
    expect(page?.hasMore).toBe(host.hasMore)
    expect(page?.records.length).toBe(host.records.length)
  })

  it('stops at the first missing line of a hole when a window or interval scans below it', async () => {
    const events: readonly Record<string, unknown>[] = [
      {
        ...at('user/message', { source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: 'open' }] } }, { surfaceOp: 'append' }),
        seq: 3,
      },
      { ...at('turn/end', { turn: 1, reason: { kind: 'completed' } }), seq: 4 },
      { ...at('turn/start', { turn: 2 }), seq: 5 },
      {
        ...at('user/message', { source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: 'next' }] } }, { surfaceOp: 'append' }),
        seq: 6,
      },
    ]
    const { store } = await holedStore(events)
    expect(await localPage(store, sessionId, { beforeSeq: 7, maxMessages: 5, throughSeq: 6, full: true })).toBeUndefined()
    expect(await localInterval(store, sessionId, { fromSeq: 3, throughSeq: 6, full: true })).toBeUndefined()
  })

  it('drops a copy whose chunk data runs past its last line', async () => {
    const events: readonly Record<string, unknown>[] = holedEvents()
    const { store, factory } = await holedStore(events)
    const connection = await rawDatabase(factory)
    await new Promise<void>((resolve, reject) => {
      const tx = connection.transaction('chunks', 'readwrite')
      const cursor = tx.objectStore('chunks').openCursor()
      cursor.onsuccess = () => {
        const current = cursor.result
        if (current === null) return
        const chunk = current.value as { data: Uint8Array }
        const padded = new Uint8Array(chunk.data.byteLength + 1)
        padded.set(chunk.data)
        padded[chunk.data.byteLength] = 0x0a
        current.update({ ...chunk, data: padded })
        current.continue()
      }
      tx.oncomplete = () => { connection.close(); resolve() }
      tx.onerror = () => { reject(tx.error ?? new Error('fixture: pad failed')) }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await localInterval(store, sessionId, { fromSeq: 3, throughSeq: 12, full: true })).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })

  it('scans more than one block below a long single turn for a small window', async () => {
    const store = await filledStore(await buildFixture(longTurn()), ONE_CHUNK)
    const page = await localPage(store, sessionId, { beforeSeq: 600, maxMessages: 3, throughSeq: 600, full: true })
    expect(page?.records.map(record => record.event.seq)).toEqual([597, 598, 599])
  })

  it('stops a scope search whose block walk reaches a missing line', async () => {
    const fixture = await buildFixture(longTurn())
    const factory = new IDBFactory()
    const store = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    const stored = fixture.events.map((_event, index) => ({
      seq: index,
      bytes: encoder.encode(fixture.lines[index] ?? ''),
      link: fixture.links[index] ?? new Uint8Array(32),
    }))
    await store.replaceThread(sessionId, fixture.header, linkOf(fixture.headerLink), buildChunkInputs(sessionId, stored, 128), {
      state: 'complete',
      complete: true,
      cursorSeen: fixture.events.length - 1,
    })
    const connection = await rawDatabase(factory)
    await new Promise<void>((resolve, reject) => {
      const tx = connection.transaction('chunks', 'readwrite')
      const cursor = tx.objectStore('chunks').openCursor()
      cursor.onsuccess = () => {
        const current = cursor.result
        if (current === null) return
        const chunk = current.value as { first: number; last: number }
        if (chunk.first < 50) current.delete()
        current.continue()
      }
      tx.oncomplete = () => { connection.close(); resolve() }
      tx.onerror = () => { reject(tx.error ?? new Error('fixture: hole delete failed')) }
    })
    expect(await localPage(store, sessionId, { beforeSeq: 600, maxMessages: 3, throughSeq: 600, full: true })).toBeUndefined()
  })

  it('answers nothing when another tab deletes the copy between the reads of one answer', async () => {
    /** A view of one store whose copy disappears after its first chunk read. */
    const vanishing = (store: LocalCopyStore): PagesStore => {
      let reads = 0
      return {
        readThread: async id => await store.readThread(id),
        readChunks: async (id, fromSeq, throughSeq) => (reads += 1) === 1 ? await store.readChunks(id, fromSeq, throughSeq) : [],
      }
    }
    const script = await buildFixture(scriptLog())
    expect(await localInterval(vanishing(await filledStore(script)), sessionId, { fromSeq: 3, throughSeq: 9, full: true })).toBeUndefined()
    const long = await filledStore(await buildFixture(longTurn()))
    expect(await localPage(vanishing(long), sessionId, { beforeSeq: 600, maxMessages: 3, throughSeq: 600, full: true })).toBeUndefined()
  })

  it('answers nothing for an expansion whose turn is still open with no later start', async () => {
    const events: Record<string, unknown>[] = [
      { ...at('turn/start', { turn: 1 }), seq: 0 },
      {
        ...at('user/message', { source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: 'stalled' }] } }, { surfaceOp: 'append' }),
        seq: 1,
      },
    ]
    const fixture = await buildFixture(events)
    const store = await filledStore(fixture)
    expect(await localElided(store, sessionId, { turn: 1, throughSeq: 9, full: true })).toBeUndefined()
  })
})

describe('local copy pages', () => {
  it('opens the newest window a Host page would serve, then walks every older page to the start', async () => {
    const fixture = await buildFixture(scriptLog())
    const store = await filledStore(fixture)
    for (const stepDetail of ['full', 'collapsed'] as const) {
      const window = { maxMessages: 5, turnWindow: { minMessages: 2, minTurns: 1 }, stepDetail, full: true }
      let page: LocalHistoryPage | undefined
      let beforeSeq: number | undefined
      let rounds = 0
      for (;;) {
        page = beforeSeq === undefined
          ? await localOpening(store, sessionId, window, false)
          : await localPage(store, sessionId, { ...window, beforeSeq, throughSeq: fixture.events.length - 1 })
        if (page === undefined || rounds > 100) throw new Error(`page flow stalled at round ${String(rounds)}`)
        const host = hostPage(fixture, {
          ...window, ...(beforeSeq === undefined ? {} : { beforeSeq }),
          throughSeq: fixture.events.length - 1,
        })
        expect(cropPage(page)).toEqual(host)
        if (!page.hasMore) break
        rounds += 1
        const next = (host.records[0] as { event: { seq: number } } | undefined)?.event.seq
        if (next === undefined) throw new Error('codegen: host page started empty')
        beforeSeq = next
      }
      expect(page?.hasMore).toBe(false)
    }
  })

  it('answers every beforeSeq cut with the Host page for full and collapsed detail', async () => {
    const fixture = await buildFixture(scriptLog())
    const store = await filledStore(fixture)
    const cuts = [0, 1, 2, 3, 7, 13, 20, 25, fixture.events.length - 1, fixture.events.length]
    for (const stepDetail of ['full', 'collapsed'] as const) {
      for (const cut of cuts) {
        for (const maxMessages of [3, 8]) {
          const request: PageRequest = { beforeSeq: cut, maxMessages, throughSeq: fixture.events.length - 1, stepDetail }
          expect(cropPage(await localPage(store, sessionId, { ...request, full: true }))).toEqual(hostPage(fixture, request))
        }
      }
    }
  })

  it('serves intervals exactly as the Host pages them', async () => {
    const fixture = await buildFixture(scriptLog())
    const store = await filledStore(fixture)
    for (const [fromSeq, throughSeq] of [[0, 5], [3, 9], [10, fixture.events.length - 1]] as const) {
      const local = await localInterval(store, sessionId, { fromSeq, throughSeq, full: true })
      const host = hostInterval(fixture, fromSeq, throughSeq)
      const shaped = (record: unknown): { type: string; event: unknown } => {
        const asRecord = record as { event?: unknown }
        return { type: 'event', event: asRecord.event ?? record }
      }
      expect(local?.map(shaped)).toEqual(host.map(shaped))
    }
    expect(await localInterval(store, sessionId, { fromSeq: 3, throughSeq: fixture.events.length, full: false })).toBeUndefined()
  })

  it('expands a collapsed turn exactly as the Host expands it', async () => {
    const fixture = await buildFixture(scriptLog())
    const store = await filledStore(fixture)
    const cursor = fixture.events.length - 1
    for (const turn of [1, 2, 3]) {
      for (const fromSeq of [undefined, 5, 12] as const) {
        const local = await localElided(store, sessionId, {
          turn, ...(fromSeq === undefined ? {} : { fromSeq }), throughSeq: cursor, full: true,
        })
        const host = pageRecords(elidedEventsOfTurn(fixture.events, turn, fromSeq))
        const shaped = (record: unknown): { type: string; event: unknown } => ({ type: 'event', event: record })
        expect(local?.map(shaped)).toEqual(host.map(shaped))
      }
    }
  })

  it('strips recorded streams to their first-token prefix without moving the first-token time', async () => {
    const fixture = await buildFixture(scriptLog())
    const store = await filledStore(fixture)
    const page = await localPage(store, sessionId, { maxMessages: 50, throughSeq: fixture.events.length - 1, stepDetail: 'full', full: false })
    const localStreams = page?.records
      .filter(record => record.event.type === 'assistant/message')
      .map(record => (record.event.data as { stream?: unknown[] }).stream) ?? []
    const hostStreams = fixture.events
      .filter((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')
      .map(event => event.data.stream)
    expect(localStreams.length).toBe(hostStreams.length)
    for (const [index, localStream] of localStreams.entries()) {
      const hostStream = hostStreams[index]
      if (hostStream === undefined || !Array.isArray(localStream)) throw new Error('codegen: stream mismatch')
      expect(assistantStreamFirstTokenTime(localStream as never)).toBe(assistantStreamFirstTokenTime(hostStream as never))
    }
    expect(page?.records.some(record => record.stripped === true)).toBe(true)
  })

  it('shares one headerKey between identical request headers inside an answer', async () => {
    const shared = { config: { model: 'same-1' } }
    const events: Record<string, unknown>[] = [
      { ...at('request/header', { header: shared, reason: 'initial' }), seq: 0 },
      { ...at('turn/start', { turn: 1 }), seq: 1 },
      { ...at('user/message', { source: { kind: 'user' } }, { surfaceOp: 'append' }), seq: 2 },
      { ...at('request/header', { header: shared, reason: 'change' }), seq: 3 },
      { ...at('assistant/message', { turn: 1, step: 1 }, { surfaceOp: 'append' }), seq: 4 },
      { ...at('request/header', { header: { config: { model: 'other-2' } }, reason: 'change' }), seq: 5 },
      { ...at('turn/end', { turn: 1, reason: { kind: 'completed' } }), seq: 6 },
    ]
    const fixture = await buildFixture(events)
    const store = await filledStore(fixture)
    const page = await localPage(store, sessionId, { maxMessages: 50, throughSeq: fixture.events.length - 1, full: false })
    const keys = page?.records.map(record => record.headerKey).filter(key => key !== undefined) ?? []
    expect(keys).toHaveLength(3)
    expect(new Set(keys).size).toBe(2)
  })

  it('reports older history when a page stops exactly on the first read floor', async () => {
    // The first read covers the 512 events below each request's top: the message request
    // (top 519) reads from seq 7, the user message there, and the turn request (top 518)
    // reads from seq 6, the second turn's start; both stops land exactly on that floor.
    const total = 520
    const message = (seq: number) => ({
      ...at('user/message', { source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: `m${String(seq)}` }] } }, { surfaceOp: 'append' }),
      seq,
    })
    const events = Array.from({ length: total }, (_value, seq) => {
      if (seq === 0 || seq === 6) return { ...at('turn/start', { turn: seq === 0 ? 1 : 2 }), seq }
      if (seq === 4) return { ...at('turn/end', { turn: 1, reason: { kind: 'completed' } }), seq }
      if (seq === 1 || seq === 7 || seq === 300) return message(seq)
      return { ...at('feedback/record', {}), seq }
    })
    const fixture = await buildFixture(events)
    const store = await filledStore(fixture, ONE_CHUNK)
    const messageStop: PageRequest = { beforeSeq: 519, maxMessages: 2, throughSeq: total - 1, stepDetail: 'full' }
    const turnStop: PageRequest = { beforeSeq: 518, maxMessages: 500, turnWindow: { minMessages: 2, minTurns: 1 }, throughSeq: total - 1, stepDetail: 'full' }
    const messagePage = cropPage(await localPage(store, sessionId, { ...messageStop, full: true }))
    const turnPage = cropPage(await localPage(store, sessionId, { ...turnStop, full: true }))
    expect((messagePage?.records[0] as { event: { seq: number } } | undefined)?.event.seq).toBe(519 - 512)
    expect((turnPage?.records[0] as { event: { seq: number } } | undefined)?.event.seq).toBe(518 - 512)
    expect(messagePage).toEqual(hostPage(fixture, messageStop))
    expect(turnPage).toEqual(hostPage(fixture, turnStop))
    expect(messagePage?.hasMore).toBe(true)
    expect(turnPage?.hasMore).toBe(true)
  })

  it('serves a page cut above the head only when its last turn closed at or below the head', async () => {
    const events: Record<string, unknown>[] = []
    const push = (type: string, data: unknown, extra: Record<string, unknown> = {}) => {
      events.push({ ...at(type, data, extra), seq: events.length })
    }
    for (const turn of [1, 2]) {
      push('turn/start', { turn })
      push('user/message', { source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: `go ${String(turn)}` }] } }, { surfaceOp: 'append' })
      for (const step of [1, 2, 3, 4]) {
        push('step/start', { turn, step })
        push('tool/call', { turn, step, callId: `c${String(turn)}${String(step)}`, name: 'write', arguments: '{}' })
        // Steps 2 and 4 carry assistant text, so whether step 2 stays whole depends on step 4.
        push('assistant/message', {
          turn, step,
          message: { role: 'assistant', content: [{ type: 'text', text: step % 2 === 0 ? `text ${String(step)}` : '' }], source: { kind: 'model', provider: 'fake', model: 'fk-1' } },
          stream: [],
        }, { surfaceOp: 'append' })
        push('step/end', { turn, step })
      }
      push('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const fixture = await buildFixture(events)
    const cursor = fixture.events.length - 1
    /** A complete-looking copy of the log's first `head + 1` lines. */
    const copyThrough = async (head: number, chunkBytes = 1 << 20): Promise<LocalCopyStore> => {
      const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
      const stored = fixture.lines.slice(0, head + 1)
        .map((line, seq) => ({ seq, bytes: encoder.encode(line), link: fixture.links[seq] ?? new Uint8Array(32) }))
      await store.replaceThread(sessionId, fixture.header, linkOf(fixture.headerLink), buildChunkInputs(sessionId, stored, chunkBytes), { state: 'complete', complete: true, cursorSeen: head })
      return store
    }
    const step3 = events.findIndex(event => event['type'] === 'step/start' && (event['data'] as { step: number }).step === 3)
    const turnEnd = events.findIndex(event => event['type'] === 'turn/end')
    const request: PageRequest = { beforeSeq: step3, maxMessages: 50, throughSeq: cursor, stepDetail: 'collapsed' }
    expect(await localPage(await copyThrough(step3 + 2), sessionId, { ...request, full: true })).toBeUndefined()
    // A page that ends on the open turn's own start is not closed by that start.
    expect(await localPage(await copyThrough(turnEnd + 3), sessionId, { ...request, beforeSeq: turnEnd + 2, full: true })).toBeUndefined()
    for (const head of [turnEnd, turnEnd + 1]) {
      expect(cropPage(await localPage(await copyThrough(head), sessionId, { ...request, full: true })), `head ${String(head)}`).toEqual(hostPage(fixture, request))
    }
    // A copy deleted by another tab before the closing turn end is read answers nothing as well.
    const closed = await copyThrough(turnEnd, 128)
    let reads = 0
    const vanishing: PagesStore = {
      readThread: async id => await closed.readThread(id),
      readChunks: async (id, fromSeq, throughSeq) => (reads += 1) === 1 ? await closed.readChunks(id, fromSeq, throughSeq) : [],
    }
    expect(await localPage(vanishing, sessionId, { ...request, full: true })).toBeUndefined()
  })

  it('refuses to open an incomplete copy while reachable, marks its offline opening partial and answers cuts it covers', async () => {
    const fixture = await buildFixture(scriptLog())
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    const stored = fixture.events.slice(0, 10).map((_event, index) => ({
      seq: index,
      bytes: encoder.encode(fixture.lines[index] ?? ''),
      link: fixture.links[index] ?? new Uint8Array(32),
    }))
    await store.replaceThread(sessionId, fixture.header, linkOf(fixture.headerLink), buildChunkInputs(sessionId, stored, 128), { state: 'downloading' })
    expect(await localOpening(store, sessionId, { maxMessages: 50, full: false }, false)).toBeUndefined()
    expect(await localOpening(store, sessionId, { maxMessages: 50, full: false }, true)).toMatchObject({ partial: true, cursor: 9 })
    const emptied: PagesStore = { readThread: async id => await store.readThread(id), readChunks: async () => [] }
    expect(await localOpening(emptied, sessionId, { maxMessages: 50, full: false }, true)).toBeUndefined()
    expect(await localPage(store, sessionId, { maxMessages: 50, throughSeq: fixture.events.length - 1, full: false })).toBeUndefined()
    expect(await localPage(store, sessionId, { maxMessages: 50, throughSeq: 9, full: false })).not.toBeUndefined()
    expect(await localInterval(store, sessionId, { fromSeq: 0, throughSeq: 9, full: false })).not.toBeUndefined()
  })
})

/** A cropped page with every recorded stream removed, so stripped and whole events compare equal. */
function withoutStreams(page: CroppedPage | undefined): CroppedPage | undefined {
  if (page === undefined) return undefined
  return {
    ...page,
    records: page.records.map((record) => {
      const entry = record as { event: { type: string; data: Record<string, unknown> } }
      if (entry.event.type !== 'assistant/message') return record
      const { stream: _stream, ...data } = entry.event.data
      return { ...entry, event: { ...entry.event, data } }
    }),
  }
}

describe('local copy collapsed pages over the corpus', () => {
  const windows = [
    { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } },
    { maxMessages: 5, turnWindow: { minMessages: 2, minTurns: 1 } },
    { maxMessages: 3 },
    { maxMessages: 8 },
  ] as const

  const logNames = collapseCorpus().map(log => log.name)
  const windowCases = windows.flatMap((window, index) => [true, false].map(full => ({ window, index, full })))

  /** One corpus log stored in a fresh copy. */
  async function storedLog(name: string): Promise<{ fixture: Fixture; store: LocalCopyStore; cursor: number }> {
    const log = collapseCorpus().find(candidate => candidate.name === name)
    if (log === undefined) throw new Error(`fixture: no corpus log ${name}`)
    const fixture = await buildFixture(log.events)
    return { fixture, store: await filledStore(fixture), cursor: fixture.events.length - 1 }
  }

  describe.each(logNames)('%s', (name) => {
    const pagesTitle = 'opens and pages collapsed window $index (full: $full) exactly as the Host serves it, digests and turn usage included'
    it.each(windowCases)(pagesTitle, async ({ window, full }) => {
      const { fixture, store, cursor } = await storedLog(name)
      const request = { ...window, stepDetail: 'collapsed' as const, full }
      let digestCount = 0
      let beforeSeq: number | undefined
      for (let rounds = 0; ; rounds++) {
        if (rounds > 200) throw new Error(`${name}: page walk stalled`)
        const page = beforeSeq === undefined
          ? await localOpening(store, sessionId, request, false)
          : await localPage(store, sessionId, { ...request, beforeSeq, throughSeq: cursor })
        const host = hostPage(fixture, { ...request, ...(beforeSeq === undefined ? {} : { beforeSeq }), throughSeq: cursor })
        if (full) expect(cropPage(page), `before ${String(beforeSeq)}`).toEqual(host)
        else expect(withoutStreams(cropPage(page)), `before ${String(beforeSeq)}`).toEqual(withoutStreams(host))
        digestCount += host.digests?.length ?? 0
        if (page === undefined || !page.hasMore) break
        beforeSeq = (host.records[0] as { event: { seq: number } }).event.seq
      }
      expect(digestCount).toBeGreaterThan(0)
    })

    it('expands every digest of every collapsed page exactly as the Host expands it', async () => {
      const { fixture, store, cursor } = await storedLog(name)
      const request = { maxMessages: 5, turnWindow: { minMessages: 2, minTurns: 1 }, stepDetail: 'collapsed' as const }
      let beforeSeq: number | undefined
      for (;;) {
        const host = hostPage(fixture, { ...request, ...(beforeSeq === undefined ? {} : { beforeSeq }), throughSeq: cursor })
        const first = (host.records[0] as { event: { seq: number }; covers?: { from: number } } | undefined)
        if (first === undefined) break
        const windowHead = first.covers?.from ?? first.event.seq
        const turns = new Set((host.digests ?? []).map(digest => (digest as { turn: number }).turn))
        for (const turn of turns) {
          for (const fromSeq of [undefined, windowHead]) {
            const local = await localElided(store, sessionId, {
              turn, ...(fromSeq === undefined ? {} : { fromSeq }), throughSeq: cursor, full: true,
            })
            const expected = pageRecords(elidedEventsOfTurn(fixture.events, turn, fromSeq))
            expect(local?.map(record => ({ type: record.type, event: record.event })), `turn ${String(turn)}`).toEqual(expected)
          }
        }
        if (!host.hasMore) break
        beforeSeq = first.event.seq
      }
    })
  })

  it('strips streams from light interval and expansion reads and keeps them whole in full ones', async () => {
    const [log] = collapseCorpus()
    if (log === undefined) throw new Error('fixture: empty corpus')
    const fixture = await buildFixture(log.events)
    const store = await filledStore(fixture)
    const cursor = fixture.events.length - 1
    const reads = (full: boolean) => [
      localInterval(store, sessionId, { fromSeq: 0, throughSeq: cursor, full }),
      localElided(store, sessionId, { turn: 3, throughSeq: cursor, full }),
    ]
    for (const records of await Promise.all(reads(true))) {
      expect(records?.some(record => record.stripped === true)).toBe(false)
    }
    for (const records of await Promise.all(reads(false))) {
      const assistants = records?.filter(record => record.event.type === 'assistant/message') ?? []
      expect(assistants.length).toBeGreaterThan(0)
      expect(assistants.every(record => record.stripped === true)).toBe(true)
    }
  })
})

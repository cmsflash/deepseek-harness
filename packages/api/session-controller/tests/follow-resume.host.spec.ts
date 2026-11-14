/** Follow openings that continue a window the caller already holds. */

import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { interruptedTurnClosers, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage, createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  SESSION_LOG_CHAIN_TAG,
  SessionLogLink,
  SessionPersistenceRevision,
  type SessionHandle,
  type SessionLogChain,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { encodeHeaderLine, encodeEventLine, generationLogPath } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {
  SessionChainLink,
  SessionFollowFrame,
  SessionFollowResume,
  SessionHistoryRecord,
  SessionLineEntry,
} from '../src/types.ts'
import { decodeStoredLine } from '../src/history-shared/wire-event.ts'
import { HistoryController } from '../src/history/controller.ts'
import { EventListener } from '../src/history/listener.ts'
import { WebController } from '../src/web/controller.ts'
import { installSessionReadTestServices, testSessionPersistence, testStoredChain } from './test-remote.ts'

type Opening = Extract<SessionFollowFrame, { readonly type: 'snapshot' | 'resumed' }>
type EventFrame = Extract<SessionFollowFrame, { readonly type: 'event' }>

const contexts: Context[] = []
const scratchRoots: string[] = []
afterEach(async () => {
  try {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  } finally {
    await Promise.all(scratchRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  }
})

function prompt(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

const SESSION_CHAIN_TAG = 'dsh-session-chain/1'

/** Claim any literal as the wire link type; the invalid resumes below exist to hit runtime validation. */
function anyLink(value: string | number): SessionChainLink {
  return value as never
}

/** The test links of the part 1 chain double: `link(seq)` hashes `String(seq)`. */
function testLink(seq: number): string {
  return createHash('sha256').update(String(seq)).digest('hex')
}

/** An independent chain oracle over a stored log's raw line bytes: the header, then every event line. */
function oracleLinks(lines: readonly string[]): string[] {
  const headerLine = lines[0]
  if (headerLine === undefined) throw new Error('the stored log lacks a header line')
  let previous = createHash('sha256').update(SESSION_CHAIN_TAG, 'utf8').update(headerLine, 'utf8').digest()
  const links: string[] = []
  for (const line of lines.slice(1)) {
    previous = createHash('sha256').update(previous).update(line, 'utf8').digest()
    links.push(previous.toString('hex'))
  }
  return links
}

/** Serialize JSON away from the writer's compact form, leaving string contents alone. */
function spacedJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(spacedJson).join(', ')}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.entries(value).map(([key, member]) => `"${key}": ${spacedJson(member)}`).join(', ')}}`
}

/** A chain double whose length follows the live log and whose link(seq) hashes `String(seq)`. */
function doubleChain(session: Session): SessionLogChain {
  return {
    length: session.seq,
    linkAt: (seq: number) => (0 <= seq && seq < session.seq ? SessionLogLink(testLink(seq)) : undefined),
  }
}

interface Fixture {
  readonly ctx: Context
  readonly web: WebController
  readonly session: Session
}

/** Dispose one tracked context, removing it from the afterEach sweep first. */
async function dispose(ctx: Context): Promise<void> {
  const index = contexts.indexOf(ctx)
  if (index >= 0) contexts.splice(index, 1)
  await ctx.fiber.dispose()
}

const webOf = (ctx: Context): WebController =>
  new WebController(ctx, new HistoryController(ctx), (observation) => { observation[Symbol.dispose]() }, 1000)

async function fixture(resumeEventLimit = 1000, liveChain = true): Promise<Fixture> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  const web = new WebController(
    ctx, new HistoryController(ctx), (observation) => { observation[Symbol.dispose]() }, resumeEventLimit,
  )
  const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
  if (liveChain) {
    ctx.provide('sessionPersistence', {
      liveChain: (id: SessionId) => (id === session.id ? doubleChain(session) : undefined),
    } as never)
  }
  return { ctx, web, session }
}

function follow(
  web: WebController, sessionId: SessionId, signal: AbortSignal, resume?: SessionFollowResume,
) {
  return web.follow({
    address: { kind: 'session', sessionId },
    ...(resume === undefined ? {} : { resume }),
  }, signal)[Symbol.asyncIterator]()
}

async function opening(web: WebController, sessionId: SessionId, resume?: SessionFollowResume): Promise<Opening> {
  const abort = new AbortController()
  const iterator = follow(web, sessionId, abort.signal, resume)
  try {
    const first = await iterator.next()
    if (first.done === true || (first.value.type !== 'snapshot' && first.value.type !== 'resumed')) {
      throw new Error('follow did not start with an opening')
    }
    return first.value
  } finally {
    abort.abort()
    await iterator.return?.()
  }
}

/** Event records of an opening; these tests never request stored lines. */
function eventRecords(frame: Opening): SessionHistoryRecord[] {
  const records: readonly (SessionHistoryRecord | SessionLineEntry)[] = frame.records
  return records.filter((record): record is SessionHistoryRecord => record.type !== 'line')
}

/** The resume point of a caller whose window ends with the opening's newest record. */
function resumeAfter(frame: Opening): SessionFollowResume {
  const newest = eventRecords(frame).at(-1)
  const link = newest?.link
  if (newest === undefined || link === undefined) throw new Error('the opening held no linked record')
  return { afterSeq: newest.covers?.to ?? newest.event.seq, link }
}

function seqs(frame: Opening): number[] {
  return eventRecords(frame).map(record => record.event.seq)
}

/** One complete turn with three tool steps so collapsed detail withholds two interiors. */
function appendTurn(session: Session, turn: number, steps: number): void {
  session.append('turn/start', { turn })
  prompt(session, `ask ${String(turn)}`)
  for (let step = 1; step <= steps; step += 1) {
    const callId = ToolCallId(`c${String(turn)}-${String(step)}`)
    session.append('step/start', { turn, step })
    session.append('tool/call', { turn, step, callId, name: 'write', arguments: '{}' })
    session.append('tool/result', {
      turn, step,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn, step,
      message: createMessage({
        role: 'assistant',
        content: step === steps ? [{ type: 'text', text: `done ${String(turn)}` }] : [],
        source: { kind: 'model', provider: 'p', model: 'm' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step })
  }
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('follow resume by chain link', () => {
  it('carries the chain links of the double on snapshot records and live frames', async () => {
    const { web, session } = await fixture()
    prompt(session, 'a')
    prompt(session, 'b')
    const abort = new AbortController()
    const iterator = follow(web, session.id, abort.signal)
    try {
      const snapshot = await iterator.next()
      expect(snapshot.value).toMatchObject({ type: 'snapshot' })
      if (snapshot.done !== true && snapshot.value.type === 'snapshot') {
        for (const record of snapshot.value.records) {
          expect(record.link).toBe(testLink(record.event.seq))
        }
      }
      prompt(session, 'c')
      const live = await iterator.next()
      expect(live.value).toMatchObject({ type: 'event', event: { seq: 2 }, link: testLink(2) })
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })

  it('carries only the events after a matching resume point', async () => {
    const { web, session } = await fixture()
    for (const text of ['a', 'b', 'c']) prompt(session, text)
    const first = await opening(web, session.id)
    prompt(session, 'd')
    prompt(session, 'e')

    const next = await opening(web, session.id, resumeAfter(first))

    expect(next).toMatchObject({ type: 'resumed', after: 2, cursor: 4 })
    expect(seqs(next)).toEqual([3, 4])
    expect(next.records.map(record => record.link)).toEqual([testLink(3), testLink(4)])
    expect(next.projections.asOfSeq).toBe(4)
  })

  it('resumes with no events when nothing was appended', async () => {
    const { web, session } = await fixture()
    prompt(session, 'a')
    const first = await opening(web, session.id)

    const next = await opening(web, session.id, resumeAfter(first))

    expect(next).toMatchObject({ type: 'resumed', after: 0, cursor: 0, records: [] })
  })

  it('delivers live events after a resumed opening exactly once', async () => {
    const { web, session } = await fixture()
    prompt(session, 'a')
    const first = await opening(web, session.id)
    prompt(session, 'b')
    const abort = new AbortController()
    const iterator = follow(web, session.id, abort.signal, resumeAfter(first))

    const resumed = await iterator.next()
    prompt(session, 'c')
    const live = await iterator.next()
    abort.abort()
    await iterator.return?.()

    expect(resumed.value).toMatchObject({ type: 'resumed', after: 0, cursor: 1 })
    expect(live.value).toMatchObject({ type: 'event', event: { seq: 2 } })
  })

  it.each([
    ['a link that differs from the log at that seq', (resume: SessionFollowResume) => ({
      ...resume, link: anyLink('f'.repeat(64)),
    })],
    ['a resume point past the end of the log', (resume: SessionFollowResume) => ({
      ...resume, afterSeq: 7, link: anyLink(testLink(7)),
    })],
  ] as const)('opens with a snapshot for %s', async (_case, change) => {
    const { web, session } = await fixture()
    for (const text of ['a', 'b']) prompt(session, text)
    const first = await opening(web, session.id)
    prompt(session, 'c')

    const next = await opening(web, session.id, change(resumeAfter(first)))

    expect(next.type).toBe('snapshot')
    expect(seqs(next)).toEqual([0, 1, 2])
  })

  it('resumes a gap of exactly the configured limit and opens with a snapshot past it', async () => {
    const { web, session } = await fixture(2)
    prompt(session, 'a')
    const first = await opening(web, session.id)
    const resume = resumeAfter(first)
    prompt(session, 'b')
    prompt(session, 'c')

    expect(await opening(web, session.id, resume)).toMatchObject({ type: 'resumed', cursor: 2 })
    prompt(session, 'd')
    expect(await opening(web, session.id, resume)).toMatchObject({ type: 'snapshot', cursor: 3 })
  })

  it('opens with a snapshot when resume is disabled', async () => {
    const { web, session } = await fixture(0)
    prompt(session, 'a')
    const first = await opening(web, session.id)

    const next = await opening(web, session.id, resumeAfter(first))

    expect(next).toMatchObject({ type: 'snapshot', cursor: 0 })
  })

  it.each([
    ['an uppercase link', (resume: SessionFollowResume) => ({ ...resume, link: anyLink(testLink(resume.afterSeq).toUpperCase()) })],
    ['a 63-character link', (resume: SessionFollowResume) => ({ ...resume, link: anyLink(testLink(resume.afterSeq).slice(1)) })],
    ['a non-string link', (resume: SessionFollowResume) => ({ ...resume, link: anyLink(1) })],
    ['a negative afterSeq', (resume: SessionFollowResume) => ({ ...resume, afterSeq: -1 })],
    ['a fractional afterSeq', (resume: SessionFollowResume) => ({ ...resume, afterSeq: 1.5 })],
  ] as const)('rejects a resume point with %s', async (_case, change) => {
    const { web, session } = await fixture()
    prompt(session, 'a')
    const resume = change(resumeAfter(await opening(web, session.id)))

    await expect(opening(web, session.id, resume)).rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('serves unlinked records and snapshots when no persistence service is mounted', async () => {
    const { web, session } = await fixture(1000, false)
    prompt(session, 'a')
    const first = await opening(web, session.id)

    expect(first.records[0]?.link).toBeUndefined()
    const next = await opening(web, session.id, { afterSeq: 0, link: anyLink(testLink(0)) })
    expect(next).toMatchObject({ type: 'snapshot', cursor: 0 })
  })

  it('carries the covering link on the last record of a collapsed snapshot', async () => {
    const { web, session } = await fixture()
    appendTurn(session, 1, 3)
    const abort = new AbortController()
    const iterator = web.follow({
      address: { kind: 'session', sessionId: session.id },
      stepDetail: 'collapsed',
    }, abort.signal)[Symbol.asyncIterator]()
    try {
      const snapshot = await iterator.next()
      if (snapshot.done === true || snapshot.value.type !== 'snapshot') throw new Error('unreachable')
      const covered = snapshot.value.records.filter(record => record.covers !== undefined)
      expect(covered.length).toBeGreaterThan(0)
      for (const record of snapshot.value.records) {
        expect(record.link).toBe(testLink(record.covers?.to ?? record.event.seq))
      }
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })

  it('carries the covering link of withheld page-tail events when a collapsed page ends inside a step', async () => {
    const { ctx, session } = await fixture()
    appendTurn(session, 1, 3)
    const page = await new HistoryController(ctx).events({
      address: { kind: 'session', sessionId: session.id },
      beforeSeq: 4,
      stepDetail: 'collapsed',
    }, new AbortController().signal)
    const last = page.records.at(-1)
    if (last === undefined || last.covers === undefined) throw new Error('the page tail is not a covering record')

    expect(last.covers.to).toBeGreaterThan(last.event.seq)
    expect(last.link).toBe(testLink(last.covers.to))
  })
})

describe('follow resume against a real JSONL log', () => {
  async function mountContext(root: string): Promise<Context> {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    installSessionReadTestServices(ctx)
    return ctx
  }

  /** One context with its own scratch root backed by the real JSONL backend. */
  async function jsonlFixture(): Promise<{ ctx: Context; web: WebController; root: string }> {
    const scratch = await mkdtemp(join(tmpdir(), 'dsh-follow-resume-'))
    scratchRoots.push(scratch)
    const root = join(scratch, 'logs')
    const ctx = await mountContext(root)
    return { ctx, web: webOf(ctx), root }
  }

  /** A host reloaded on the same stored logs, as after a crash. */
  async function reloaded(root: string): Promise<{ web: WebController }> {
    return { web: webOf(await mountContext(root)) }
  }

  /** The stored log under the mount root: its file path and lines without the trailing newline. */
  async function storedLog(root: string): Promise<{ path: string; lines: string[] }> {
    const logs: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(join(dir, entry.name))
        else if (entry.name.endsWith('.jsonl')) logs.push(join(dir, entry.name))
      }
    }
    await walk(root)
    expect(logs).toHaveLength(1)
    const path = logs[0] as string
    const lines = (await readFile(path, 'utf8')).split('\n').slice(0, -1)
    return { path, lines }
  }

  /** Seed a stored log whose final turn holds an unanswered tool call, as an interrupted Agent turn does. */
  async function seedInterruptedLog(ctx: Context, session: Session): Promise<void> {
    await ctx.sessionPersistence.create(session.header)
    session.append('turn/start', { turn: 1 })
    prompt(session, 'open turn')
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'read', arguments: '{}' }],
      }),
    }, { surfaceOp: 'append' })
    await ctx.sessions.flush(session)
  }

  /** Resume a stored interrupted log in this Host: append the closers, prepare, append the restore suffix, enter, and announce. */
  async function resumeInterruptedLog(ctx: Context, id: SessionId, writer: SessionHandle): Promise<Session> {
    const read = await writer.read(0)
    const closers = interruptedTurnClosers(read.events)
    await writer.append(closers)
    const session = ctx.sessions.prepare(id, {
      seed: [...read.events, ...closers], meta: structuredClone(writer.header),
      inheritedEventCount: writer.inheritedEventCount, eventState: read.eventState,
    })
    const storedCount = read.events.length + closers.length
    const suffix = session.snapshotEvents(storedCount as never)
    if (suffix.length > 0) await writer.append(suffix)
    ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    return session
  }

  it('opens a hand-written log with links over its stored line bytes', async () => {
    const { ctx, root } = await jsonlFixture()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    await ctx.sessionPersistence.create(session.header)
    session.append('turn/start', { turn: 1 })
    prompt(session, 'héllo wörld')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    await dispose(ctx)

    const log = await storedLog(root)
    const [headerLine, turnStart, messageLine, turnEnd] = log.lines
    if (headerLine === undefined || turnStart === undefined || messageLine === undefined || turnEnd === undefined) {
      throw new Error('the stored log lacks its header or event lines')
    }
    const escapedMessage = JSON.stringify(JSON.parse(messageLine)).replace('é', '\\u00e9')
    await writeFile(log.path, [headerLine, spacedJson(JSON.parse(turnStart)), escapedMessage, turnEnd].join('\n') + '\n')

    const { web } = await reloaded(root)
    const opened = await opening(web, session.id)
    const links = oracleLinks((await storedLog(root)).lines)

    expect(opened.type).toBe('snapshot')
    expect(seqs(opened)).toEqual([0, 1, 2])
    expect(opened.records.map(record => record.link)).toEqual(links)
  })

  it('sends live frames whose links equal the oracle over the flushed log', async () => {
    const { ctx, web, root } = await jsonlFixture()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    await ctx.sessionPersistence.create(session.header)
    const abort = new AbortController()
    const iterator = follow(web, session.id, abort.signal)
    try {
      expect((await iterator.next()).value).toMatchObject({ type: 'snapshot', cursor: -1 })
      prompt(session, 'a')
      prompt(session, 'b')
      const first = await iterator.next()
      const second = await iterator.next()
      expect(first.value).toMatchObject({ type: 'event', event: { seq: 0 } })
      expect(second.value).toMatchObject({ type: 'event', event: { seq: 1 } })
      await ctx.sessions.flush(session)
      const links = oracleLinks((await storedLog(root)).lines)

      expect(first.value).toMatchObject({ link: links[0] })
      expect(second.value).toMatchObject({ link: links[1] })
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })

  it('resumes a held link after a host reload on the same stored log', async () => {
    const { ctx, web, root } = await jsonlFixture()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    await ctx.sessionPersistence.create(session.header)
    prompt(session, 'a')
    prompt(session, 'b')
    await ctx.sessions.flush(session)
    const first = await opening(web, session.id)
    const resume = resumeAfter(first)
    expect(resume.afterSeq).toBe(1)
    await dispose(ctx)

    const next = await opening((await reloaded(root)).web, session.id, resume)

    expect(next).toMatchObject({ type: 'resumed', after: 1, cursor: 1, records: [] })
  })

  it.each([
    ['truncating the log by 2 events', async (log: { path: string; lines: string[] }) => {
      await writeFile(log.path, log.lines.slice(0, -2).join('\n') + '\n')
    }],
    ['changing one stored event time', async (log: { path: string; lines: string[] }) => {
      const event = JSON.parse(log.lines[2] as string) as { readonly time: number }
      const changed = [...log.lines]
      changed[2] = spacedJson({ ...event, time: event.time + 1 })
      await writeFile(log.path, changed.join('\n') + '\n')
    }],
    ['changing the header createdAt', async (log: { path: string; lines: string[] }) => {
      const header = JSON.parse(log.lines[0] as string) as { readonly createdAt: number }
      const changed = [...log.lines]
      changed[0] = spacedJson({ ...header, createdAt: header.createdAt + 1 })
      await writeFile(log.path, changed.join('\n') + '\n')
    }],
  ] as const)('opens with a snapshot after %s', async (_case, tamper) => {
    const { ctx, web, root } = await jsonlFixture()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    await ctx.sessionPersistence.create(session.header)
    prompt(session, 'a')
    prompt(session, 'b')
    prompt(session, 'c')
    await ctx.sessions.flush(session)
    const resume = resumeAfter(await opening(web, session.id))
    await dispose(ctx)

    await tamper(await storedLog(root))

    const next = await opening((await reloaded(root)).web, session.id, resume)
    expect(next.type).toBe('snapshot')
  })

  it('links cold-read interrupted-turn closers and resumes them after the resume append', async () => {
    const { ctx, root } = await jsonlFixture()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    await ctx.sessionPersistence.create(session.header)
    session.append('turn/start', { turn: 1 })
    prompt(session, 'a')
    await ctx.sessions.flush(session)
    await dispose(ctx)

    const cold = await reloaded(root)
    const storedLinks = oracleLinks((await storedLog(root)).lines)
    const first = await opening(cold.web, session.id)
    const held = eventRecords(first)
    for (const record of held.slice(0, storedLinks.length)) {
      expect(record.link).toBe(storedLinks[record.event.seq])
    }
    const closers = held.slice(storedLinks.length)
    expect(closers.length).toBeGreaterThan(0)
    expect(closers.filter(record => record.link === undefined)).toHaveLength(0)
    const resume = resumeAfter(first)
    expect(resume.afterSeq).toBe(first.cursor)
    expect((await opening(cold.web, session.id, resume)).type).toBe('resumed')

    const writer = await mountContext(root)
    const handle = await writer.sessionPersistence.open(session.id, 'write')
    try {
      const read = await handle.read(0)
      await handle.append(interruptedTurnClosers(read.events))
      await handle.flush()
    } finally {
      await handle.close()
    }
    const afterLinks = oracleLinks((await storedLog(root)).lines)

    for (const closer of closers) {
      expect(afterLinks[closer.event.seq]).toBe(closer.link)
    }
    expect(await opening((await reloaded(root)).web, session.id, resume)).toMatchObject({
      type: 'resumed', after: resume.afterSeq, cursor: resume.afterSeq, records: [],
    })
  })

  it('keeps streaming across an ordinary promotion with the new write handle links', async () => {
    const { ctx, root } = await jsonlFixture()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    await seedInterruptedLog(ctx, session)
    await dispose(ctx)
    const id = session.id

    const host = await mountContext(root)
    const abort = new AbortController()
    const iterator = follow(webOf(host), id, abort.signal)
    const writer = await host.sessionPersistence.open(id, 'write')
    try {
      const first = await iterator.next()
      if (first.done === true || first.value.type !== 'snapshot') throw new Error('no opening')
      const cold = first.value

      const resumed = await resumeInterruptedLog(host, id, writer)
      resumed.append('turn/start', { turn: 2 })
      prompt(resumed, 'after promotion')
      const live: EventFrame[] = []
      for (let index = 0; index < 2; index += 1) {
        const next = await iterator.next()
        if (next.done === true || next.value.type !== 'event') throw new Error('the follow ended without a live event')
        live.push(next.value)
      }
      await host.sessions.flush(resumed)
      const stored = oracleLinks((await storedLog(root)).lines)

      expect(cold.records.map(record => record.link)).toEqual(stored.slice(0, cold.records.length))
      for (const frame of live) {
        expect(frame.event.seq).toBeGreaterThanOrEqual(cold.cursor + 1)
        expect(frame.link).toBe(stored[frame.event.seq])
      }
    } finally {
      abort.abort()
      await iterator.return?.()
      await writer.close()
    }
  })

  it('ends the generation when a promotion inherits a stored log a cold write changed below the cursor', async () => {
    const { ctx, root } = await jsonlFixture()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    await seedInterruptedLog(ctx, session)
    await dispose(ctx)
    const id = session.id

    const host = await mountContext(root)
    const abort = new AbortController()
    const iterator = follow(webOf(host), id, abort.signal)
    const first = await iterator.next()
    if (first.done === true || first.value.type !== 'snapshot') throw new Error('no opening')
    const window: SessionHistoryRecord[] = [...first.value.records]

    // A cold writer, as message-feedback does for a Session that is not live, appends inside the open turn.
    const feedback = await host.sessionPersistence.open(id, 'write')
    const storable = await feedback.read()
    await feedback.append([{
      type: 'feedback/message-delete', seq: SessionSeq(storable.events.length), time: 50,
      data: { messageId: 'm' },
    } as never])
    await feedback.flush()
    await feedback.close()

    // Promotion as agent-loop resume performs it; its first live event exposes the changed stored log.
    const writer = await host.sessionPersistence.open(id, 'write')
    try {
      const resumed = await resumeInterruptedLog(host, id, writer)
      resumed.append('turn/start', { turn: 2 })

      expect((await iterator.next()).done).toBe(true)
    } finally {
      abort.abort()
      await iterator.return?.()
      await writer.close()
    }

    const newest = window.at(-1)
    if (newest === undefined || newest.link === undefined) throw new Error('the cold window held no linked record')
    const resume: SessionFollowResume = { afterSeq: newest.covers?.to ?? newest.event.seq, link: newest.link }

    expect((await opening((await reloaded(root)).web, id, resume)).type).toBe('snapshot')
  })

  it('snapshot on lost unwritten events and on reused seqs after a crash', async () => {
    const { ctx, web, root } = await jsonlFixture()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    await ctx.sessionPersistence.create(session.header)
    prompt(session, 'a')
    prompt(session, 'b')
    prompt(session, 'c')
    await ctx.sessions.flush(session)
    const log = await storedLog(root)
    const durable = await readFile(log.path)

    const abort = new AbortController()
    const iterator = follow(web, session.id, abort.signal)
    let held: SessionFollowResume | undefined
    try {
      const snapshot = await iterator.next()
      expect(snapshot.value).toMatchObject({ type: 'snapshot', cursor: 2 })
      prompt(session, 'd')
      prompt(session, 'e')
      const reappearance: EventFrame[] = []
      for (let index = 0; index < 2; index += 1) {
        const next = await iterator.next()
        if (next.done === true || next.value.type !== 'event') throw new Error('the follow ended without a live event')
        reappearance.push(next.value)
      }
      expect(reappearance.map(frame => frame.event.seq)).toEqual([3, 4])
      // Timestamps stay inside the batching window: the bytes on disk are still the flushed prefix.
      expect((await readFile(log.path)).equals(durable)).toBe(true)
      const link = reappearance.at(-1)?.link
      if (link === undefined) throw new Error('the live window carried no link')
      held = { afterSeq: 4, link }
    } finally {
      abort.abort()
      await iterator.return?.()
    }
    if (held === undefined) throw new Error('unreachable')
    // Close drains and durably writes the window; restoring the earlier bytes models the crash that lost it.
    await dispose(ctx)
    await writeFile(log.path, durable)

    const lost = await opening((await reloaded(root)).web, session.id, held)
    expect(lost).toMatchObject({ type: 'snapshot', cursor: 2 })

    const regrow = await mountContext(root)
    const writer = await regrow.sessionPersistence.open(session.id, 'write')
    await writer.append([3, 4].map(seq => ({
      type: 'user/message', seq: SessionSeq(seq), time: 99, surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: `other ${String(seq)}` }], source: { kind: 'user' } }),
    })))
    await writer.close()
    await dispose(regrow)
    const reused = await opening((await reloaded(root)).web, session.id, held)
    expect(reused).toMatchObject({ type: 'snapshot', cursor: 4 })
    expect(oracleLinks((await storedLog(root)).lines)[4]).not.toBe(held.link)
  })

  it('migration: a v3 log links the prepared migration and resumes from it; links equal the published v4 bytes', async () => {
    const { root } = await jsonlFixture()
    const id = 'migrated' as SessionId
    const path = generationLogPath(root, '/workspace', id, 3, 'none')
    const rows = [
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'user/message',
        data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
        surfaceOp: 'append',
      },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ].map((event, index) => ({ ...event, seq: index, time: index + 10 }))
    const header = { type: 'session', version: 3, id, createdAt: 1, cwd: '/workspace', isSeeded: false, delegationDepth: 0 }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, [header, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n')

    const host = await mountContext(root)
    const web = webOf(host)
    const prepared = await opening(web, id)
    const paused = { afterSeq: 2, link: anyLink('0'.repeat(64)) }
    expect((await opening(web, id, paused)).type).toBe('snapshot')
    expect((await opening(web, id, resumeAfter(prepared))).type).toBe('resumed')

    const writer = await host.sessionPersistence.open(id, 'write')
    const published = await opening(web, id)
    await writer.close()
    const afterClose = await opening(web, id)

    const afterReload = await opening((await reloaded(root)).web, id)
    const stored = oracleLinks((await readFile(generationLogPath(root, '/workspace', id, 4, 'none'), 'utf8'))
      .split('\n').slice(0, -1))
    expect(prepared.records.map(record => record.link)).toEqual(stored)
    expect(published.records.map(record => record.link)).toEqual(stored)
    expect(afterClose.records.map(record => record.link)).toEqual(stored)
    expect(afterReload.records.map(record => record.link)).toEqual(stored)
  })
})

/** Every stored JSONL log under a mount root, order undefined. */
async function jsonlLogFiles(root: string): Promise<string[]> {
  return readdir(root, { recursive: true, withFileTypes: true }).then(entries => entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => join(entry.parentPath, entry.name)))
}

describe('follow stored lines', () => {
  /** Rebuild the events of stored lines, as a current-format reader rebuilds them. */
  function linesToEvents(lines: readonly string[]): SessionEvent[] {
    return lines.map((line, index) => decodeStoredLine(line, index) as never)
  }

  /** Fold one raw digest over an entry's own line bytes: the linkage the wire claims. */
  function foldLink(previousHex: string, line: string): string {
    return createHash('sha256').update(Buffer.from(previousHex, 'hex')).update(line, 'utf8').digest('hex')
  }

  /**
   * Chain double over a live session's current events, with links as the write
   * path computes them and `storedLine` answering the event's JSONL encoding
   * when it hashes to the link, as the chain contract requires.
   */
  function liveLinesChain(session: Session): SessionLogChain {
    const headerLine = encodeHeaderLine(session.header)
    const linkAt = (seq: number): Buffer | undefined => {
      if (seq < 0 || seq >= session.seq) return undefined
      const lines = session.snapshotEvents(SessionLogOffset(0), SessionLogOffset(session.seq)).map(encodeEventLine)
      let previous = createHash('sha256').update(SESSION_LOG_CHAIN_TAG, 'utf8').update(headerLine).digest()
      for (const line of lines.slice(0, seq + 1)) {
        previous = createHash('sha256').update(previous).update(line).digest()
      }
      return previous
    }
    return {
      get length() { return session.seq },
      linkAt: (seq: number) => {
        const raw = linkAt(seq)
        return raw === undefined ? undefined : SessionLogLink(raw.toString('hex'))
      },
      storedLine: (event) => {
        const linked = linkAt(event.seq)
        if (linked === undefined) return undefined
        const line = encodeEventLine(event)
        const previous = event.seq === 0
          ? createHash('sha256').update(SESSION_LOG_CHAIN_TAG, 'utf8').update(headerLine).digest()
          : linkAt(event.seq - 1)
        const digest = createHash('sha256')
          .update(previous as Buffer).update(line).digest()
        return digest.toString('hex') === linked.toString('hex') ? line : undefined
      },
    }
  }

  /** The line entries of an opening. */
  function lineEntries(frame: Opening): SessionLineEntry[] {
    const records: readonly (SessionHistoryRecord | SessionLineEntry)[] = frame.records
    return records.filter((record): record is SessionLineEntry => record.type === 'line')
  }

  /** The seq one history or line record stands for. */
  function recordSeq(record: SessionHistoryRecord | SessionLineEntry): number {
    return record.type === 'event' ? record.event.seq : record.seq
  }

  /** Opening helper that sets `lines: true`. */
  async function linesOpening(
    web: WebController, sessionId: SessionId, resume?: SessionFollowResume,
  ): Promise<Opening> {
    const abort = new AbortController()
    const iterator = web.follow({
      address: { kind: 'session', sessionId },
      ...(resume === undefined ? {} : { resume }),
      lines: true,
    }, abort.signal)[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      if (first.done === true || (first.value.type !== 'snapshot' && first.value.type !== 'resumed')) {
        throw new Error('follow did not start with an opening')
      }
      return first.value
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  }

  it('sends live frames as stored lines that fold to their links from the bytes on the frame', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    installSessionReadTestServices(ctx)
    const web = webOf(ctx)
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    ctx.provide('sessionPersistence', {
      liveChain: (id: SessionId) => (id === session.id ? liveLinesChain(session) : undefined),
    } as never)
    appendTurn(session, 1, 1)
    const abort = new AbortController()
    const iterator = web.follow({
      address: { kind: 'session', sessionId: session.id }, lines: true,
    }, abort.signal)[Symbol.asyncIterator]()
    const quiet = new AbortController()
    const plain = web.follow({ address: { kind: 'session', sessionId: session.id } }, quiet.signal)[Symbol.asyncIterator]()
    try {
      const snapshot = await iterator.next()
      if (snapshot.done === true || snapshot.value.type !== 'snapshot') throw new Error('no opening')
      expect(lineEntries(snapshot.value)).toHaveLength(0)
      const newest = snapshot.value.records.at(-1)
      const newestSeq = newest?.covers?.to ?? newest?.event.seq
      const previousLink = newest?.link
      if (newestSeq === undefined || previousLink === undefined) throw new Error('the snapshot held no linked record')
      expect((await plain.next()).value).toMatchObject({ type: 'snapshot' })

      prompt(session, 'next')
      appendTurn(session, 2, 1)
      const lastSeq = session.seq - 1
      const live: SessionLineEntry[] = []
      for (;;) {
        const next = await iterator.next()
        if (next.done === true) break
        if (next.value.type === 'snapshot' || next.value.type === 'resumed' || next.value.type === 'assistant-stream') {
          throw new Error(`live frame was a ${next.value.type} frame`)
        }
        if (next.value.type !== 'line') throw new Error('live frame was an event record')
        live.push(next.value)
        if (next.value.seq >= lastSeq) break
      }
      let previous: string = previousLink
      const firstSeq = newestSeq + 1
      for (const [index, entry] of live.entries()) {
        expect(entry.seq).toBe(firstSeq + index)
        const digest = foldLink(previous, entry.line)
        expect(entry.link).toBe(digest)
        previous = digest
      }
      const end = live.at(-1)
      if (end === undefined) throw new Error('the live stream held no line entries')
      const source = session.snapshotEvents(SessionLogOffset(end.seq), SessionLogOffset(end.seq + 1))[0]
      if (source === undefined) throw new Error('the session lacks the final live event')
      expect(decodeStoredLine(end.line, end.seq)).toEqual(source)
      expect(end.turnUsage).toBeDefined()

      let plainUsage: unknown
      for (;;) {
        const next = await plain.next()
        if (next.done === true) break
        if (next.value.type === 'event' && next.value.event.seq === lastSeq) {
          plainUsage = next.value.turnUsage
          break
        }
      }
      expect(plainUsage).toEqual(end.turnUsage)
    } finally {
      abort.abort()
      await iterator.return?.()
      quiet.abort()
      await plain.return?.()
    }
  })

  /**
   * Write one real stored log of two three-step turns through the JSONL backend
   * and return the file's header line, event lines, and session identity.
   */
  async function realStoredLog(
    options: { readonly tamper?: (lines: readonly string[]) => string[] } = {},
  ): Promise<{ readonly id: SessionId; readonly meta: SessionHeader; readonly headerLine: string; readonly eventLines: string[] }> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-follow-lines-'))
    scratchRoots.push(root)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    await ctx.sessionPersistence.create(session.header)
    appendTurn(session, 1, 1)
    appendTurn(session, 2, 1)
    await ctx.sessions.flush(session)
    const id = session.id
    const meta = structuredClone(session.header)
    await ctx.fiber.dispose()
    const logs = await jsonlLogFiles(join(root, 'logs'))
    if (logs.length !== 1) throw new Error(`found ${logs.length} stored logs`)
    const fileLines = (await readFile(logs[0] as string, 'utf8')).split('\n').slice(0, -1)
    const headerLine = fileLines[0]
    if (headerLine === undefined) throw new Error('the stored log lacks its header line')
    return { id, meta, headerLine, eventLines: options.tamper?.(fileLines.slice(1)) ?? fileLines.slice(1) }
  }

  /**
   * A cold fixture over one real stored log: the double serves a first-turn
   * prefix until `reveal`, then the full log under a new revision. The chain is
   * always the oracle over the log's entire stored bytes.
   */
  async function resumedLinesFixture(
    options: { readonly tamper?: (lines: readonly string[]) => string[] } = {},
  ): Promise<{
    readonly web: WebController
    readonly id: SessionId
    readonly headerLine: string
    readonly eventLines: readonly string[]
    readonly links: readonly string[]
    readonly reveal: () => void
  }> {
    const source = await realStoredLog(options)
    const chain = testStoredChain(
      Buffer.from(source.headerLine, 'utf8'), source.eventLines.map(line => Buffer.from(line, 'utf8')),
    )
    const fullEvents = linesToEvents(source.eventLines)
    const prefix = 8
    const host = new Context()
    contexts.push(host)
    await host.plugin(SessionStore)
    await host.plugin(SessionProjectionRegistry)
    await host.plugin(AgentRegistry)
    installSessionReadTestServices(host)
    let revealed = false
    host.provide('sessionPersistence', testSessionPersistence(host, {
      list: () => Promise.resolve([source.meta]),
      stat: async (): Promise<SessionPersistenceSnapshot> => ({
        header: source.meta,
        revision: SessionPersistenceRevision(`test:${source.id}:${revealed ? 'full' : 'prefix'}`),
      }),
      inspect: () => Promise.resolve({
        meta: source.meta,
        events: revealed ? fullEvents : fullEvents.slice(0, prefix),
        chain,
      }),
    }) as never)
    return {
      web: webOf(host),
      id: source.id,
      headerLine: source.headerLine,
      eventLines: source.eventLines,
      links: oracleLinks([source.headerLine, ...source.eventLines]),
      reveal: () => { revealed = true },
    }
  }

  it('sends a resumed opening as stored lines equal to the file bytes with oracle links', async () => {
    const fixture = await resumedLinesFixture()
    const first = await opening(fixture.web, fixture.id)
    expect(first.type).toBe('snapshot')
    expect(lineEntries(first)).toHaveLength(0)
    const resume = resumeAfter(first)
    expect(resume.afterSeq).toBe(7)

    fixture.reveal()
    const resumed = await linesOpening(fixture.web, fixture.id, resume)
    expect(resumed.type).toBe('resumed')
    const lines = lineEntries(resumed)
    expect(lines.map(entry => entry.seq)).toEqual([8, 9, 10, 11, 12, 13, 14, 15])
    for (const entry of lines) {
      expect(entry.line).toBe(fixture.eventLines[entry.seq])
      expect(entry.link).toBe(fixture.links[entry.seq])
    }
    const end = lines.at(-1)
    if (end === undefined) throw new Error('the resumed opening held no final line entry')
    expect(end.turnUsage).toBeDefined()
    const plain = await opening(fixture.web, fixture.id, resume)
    expect(plain.type).toBe('resumed')
    const plainEnd = eventRecords(plain).at(-1)
    expect(plainEnd?.turnUsage).toEqual(end.turnUsage)
  })

  it('keeps a non-canonical stored line in the resumed range as an event record', async () => {
    const tamperAt = 9
    const fixture = await resumedLinesFixture({
      tamper: lines => lines.map((line, index) => index === tamperAt ? spacedJson(JSON.parse(line)) : line),
    })
    const first = await opening(fixture.web, fixture.id)
    const resume = resumeAfter(first)
    fixture.reveal()
    const resumed = await linesOpening(fixture.web, fixture.id, resume)
    expect(resumed.type).toBe('resumed')
    const records: readonly (SessionHistoryRecord | SessionLineEntry)[] = resumed.records
    const tampered = records.find(record => recordSeq(record) === tamperAt)
    if (tampered === undefined || tampered.type !== 'event') {
      throw new Error('the tampered seq did not remain an event record')
    }
    expect(tampered.link).toBe(fixture.links[tamperAt])
    expect(lineEntries(resumed).map(entry => entry.seq))
      .toEqual([8, 10, 11, 12, 13, 14, 15])
  })

  it('fails a pure subscription that received a stored line frame', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const listener = new EventListener(ctx, session.id, new AbortController().signal)
    listener.setCursor(0, () => ({
      type: 'line', seq: 0, line: '{}', link: anyLink(testLink(0)),
    }))
    ctx.emit('session/event', session, {
      type: 'user/message', seq: SessionSeq(1), time: 1, data: {}, surfaceOp: 'append',
    } as never)

    await expect((async () => {
      for await (const frame of listener.events()) void frame
    })()).rejects.toThrow('stored line frame')
  })

  it('serves decoded records for a snapshot opening of a real log with lines requested', async () => {
    const fixture = await resumedLinesFixture()
    const opened = await linesOpening(fixture.web, fixture.id)
    expect(opened.type).toBe('snapshot')
    expect(lineEntries(opened)).toHaveLength(0)
    const links = oracleLinks([fixture.headerLine, ...fixture.eventLines])
    for (const record of eventRecords(opened)) {
      expect(record.link).toBe(links[record.covers?.to ?? record.event.seq])
    }
  })
})

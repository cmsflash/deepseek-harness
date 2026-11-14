/** The authenticated /api/session/lines route: verified stored lines with resume checkpoints. */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, createMessage } from '@deepseek-ai/dsh-llm'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import type { SessionLogChain } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { decodeStoredLine } from '../src/history-shared/wire-event.ts'
import { lineEntry, linkAtOf } from '../src/history.ts'
import { SESSION_LINES_PATH, type SessionLinesHead } from '../src/types.ts'
import { createSessionTestController, testSessionPersistence, testStoredChain } from './test-remote.ts'

/** The oracle's chain tag: asserted literally, never imported from the code under test. */
const CHAIN_TAG = 'dsh-session-chain/1'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  try {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  } finally {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  }
})

/** Log one complete turn with a human message, one text step, and its end. */
function appendTurn(session: Session, turn: number, text = `ask ${String(turn)}`): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn, step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `reply ${String(turn)}` }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Hex links of the oracle over the header line and the event lines, in seq order. */
function oracleLinks(headerLine: string, lines: readonly string[]): string[] {
  let previous = createHash('sha256').update(CHAIN_TAG, 'utf8').update(headerLine, 'utf8').digest()
  const links: string[] = []
  for (const line of lines) {
    previous = createHash('sha256').update(previous).update(line, 'utf8').digest()
    links.push(previous.toString('hex'))
  }
  return links
}

/** Chain double over the exact stored line bytes, with links the oracle computed. */
function chainFor(headerLine: string, lines: readonly string[]): SessionLogChain {
  return testStoredChain(Buffer.from(headerLine, 'utf8'), lines.map(line => Buffer.from(line, 'utf8')))
}

/** Events rebuilt from stored lines, as a current-format reader rebuilds them. */
function eventsOfLines(lines: readonly string[]): SessionEvent[] {
  return lines.map((line, seq) => decodeStoredLine(line, seq) as never)
}

/** Serialize one stored record away from the writer's compact form, leaving contents alone. */
function spacedJson(line: string): string {
  const record: unknown = JSON.parse(line)
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return line
  return `{${Object.entries(record as Record<string, unknown>)
    .map(([key, member]) => `"${key}": ${JSON.stringify(member)}`).join(', ')}}`
}

/** The captured lines handler with its unregister audit. */
interface LinesRouteCall {
  (query: string, init?: RequestInit): Promise<Response>
  readonly unregistered: number[]
}

interface LinesFixture {
  readonly ctx: Context
  readonly id: SessionId
  readonly headerLine: string
  readonly lines: readonly string[]
  readonly links: readonly string[]
  readonly call: LinesRouteCall
  readonly unregistered: number[]
}

/** Build the connection double and return the captured lines handler with its unregister audit. */
function captureLinesRoute(ctx: Context): LinesRouteCall {
  const handlers = new Map<string, (request: Request) => Promise<Response>>()
  const unregistered: number[] = []
  ctx.provide('connection', {
    fetch: {
      register: (registered: { path: string; fetch: (request: Request) => Promise<Response> }) => {
        handlers.set(registered.path, registered.fetch)
        return () => {
          unregistered.push(1)
          return Promise.resolve()
        }
      },
    },
  } as never)
  return Object.assign(async (query: string, init?: RequestInit): Promise<Response> => {
    const handler = handlers.get(SESSION_LINES_PATH)
    if (handler === undefined) throw new Error('the lines route is not registered')
    return handler(new Request(`http://127.0.0.1${SESSION_LINES_PATH}${query}`, init))
  }, { unregistered })
}

/** Header line of one plain workspace log, as the writer serializes the header record. */
function plainHeaderLine(id: SessionId): string {
  return JSON.stringify({
    type: 'session', version: SESSION_FORMAT_VERSION, id, createdAt: 10,
    cwd: '/workspace', isSeeded: false, delegationDepth: 0,
  })
}

/**
 * A host fixture whose observation chain is a double over the supplied stored
 * line bytes, read through the real Session query. The lines stand for the
 * file's bytes: every link expectation derives from them with node:crypto.
 */
async function oracleFixture(
  lines: readonly string[],
  options: {
    readonly meta?: Partial<Pick<SessionHeader, 'origin' | 'parentSession'>>
    readonly withoutChain?: boolean
    readonly withoutCwd?: boolean
    readonly id?: SessionId
    readonly headerLine?: string
  } = {},
): Promise<LinesFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lines-route-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const id = options.id ?? ('lines-fixture' as SessionId)
  const meta: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 10,
    isSeeded: false,
    delegationDepth: 0,
    ...(options.withoutCwd === true ? {} : { cwd: '/workspace' }),
    ...(options.meta === undefined ? {} : options.meta),
  }
  const headerLine = options.headerLine ?? plainHeaderLine(id)
  const events = eventsOfLines(lines)
  const chain = options.withoutChain === true ? undefined : chainFor(headerLine, lines)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([meta]),
    inspect: () => Promise.resolve({
      meta,
      events,
      ...(chain === undefined ? {} : { chain }),
    }),
  }) as never)
  const call = captureLinesRoute(ctx)
  await createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
    cwd: root,
  })
  return { ctx, id, headerLine, lines, links: oracleLinks(headerLine, lines), call, unregistered: call.unregistered }
}

/**
 * Write one real stored log through the JSONL backend and return its exact file
 * lines; the fixtures below serve and verify against these bytes.
 */
async function realLogLines(
  seed: (session: Session, turn: number) => void,
  turns: number,
  options: { readonly tamper?: (lines: readonly string[]) => string[] } = {},
): Promise<{ id: SessionId; headerLine: string; lines: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lines-source-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
  const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
  await ctx.sessionPersistence.create(session.header)
  for (let turn = 1; turn <= turns; turn += 1) seed(session, turn)
  await ctx.sessions.flush(session)
  await ctx.fiber.dispose()
  const logs: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(dir, entry.name))
      else if (entry.name.endsWith('.jsonl')) logs.push(join(dir, entry.name))
    }
  }
  await walk(join(root, 'logs'))
  expect(logs).toHaveLength(1)
  const fileLines = (await readFile(logs[0] as string, 'utf8')).split('\n').slice(0, -1)
  return {
    id: session.id,
    headerLine: fileLines[0] as string,
    lines: options.tamper?.(fileLines.slice(1)) ?? [...fileLines.slice(1)],
  }
}

/** Parse a lines response body and validate it against the head contract. */
function parseLinesResponse(text: string, sessionId: SessionId): { head: SessionLinesHead; lines: string[] } {
  const separator = text.indexOf('\n')
  expect(separator).toBeGreaterThan(0)
  const head = JSON.parse(text.slice(0, separator)) as SessionLinesHead
  const lines = text.slice(separator + 1).split('\n').slice(0, -1)
  expect(head.type).toBe('dsh-session-lines')
  expect(head.version).toBe(1)
  expect(head.sessionId).toBe(sessionId)
  expect(head.through - head.start + 1).toBe(lines.length)
  expect(head.start === 0).toBe(head.header !== undefined)
  expect(head.start === 0).toBe(head.headerLink !== undefined)
  if (head.link !== null) expect(head.link).toMatch(/^[0-9a-f]{64}$/)
  return { head, lines }
}

const lineQuery = (id: SessionId): string => `?sessionId=${encodeURIComponent(id)}`

describe('GET /api/session/lines over real backend bytes', () => {
  it('downloads from 0 with the header, headerLink, the file lines and oracle links', async () => {
    const { id, lines } = await realLogLines(appendTurn, 2)
    const fixture = await oracleFixture(lines, { id })
    const response = await fixture.call(lineQuery(id))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    const { head, lines: served } = parseLinesResponse(await response.text(), id)
    expect(head.start).toBe(0)
    expect(head.through).toBe(lines.length - 1)
    expect(head.cursor).toBe(lines.length - 1)
    expect(head.header).toBe(fixture.headerLine)
    const expectedHeaderLink = createHash('sha256')
      .update(CHAIN_TAG, 'utf8').update(fixture.headerLine, 'utf8').digest('hex')
    expect(head.headerLink).toBe(expectedHeaderLink)
    expect(head.link).toBe(fixture.links.at(-1))
    expect(served).toEqual(lines)
  })

  it('continues from a matching checkpoint and splits the log under maxBytes', async () => {
    const { id, lines } = await realLogLines(appendTurn, 3)
    const fixture = await oracleFixture(lines, { id })
    const query = (have: string): string => `${lineQuery(id)}${have}&maxBytes=4096`
    const served: string[] = []
    let have = ''
    for (let response = 0; response < 40; response += 1) {
      const result = await fixture.call(query(have))
      expect(result.status).toBe(200)
      const { head, lines: chunk } = parseLinesResponse(await result.text(), id)
      served.push(...chunk)
      if (head.through >= head.cursor) {
        expect(head.through).toBe(head.cursor)
        break
      }
      have = `&have=${String(head.through)}:${String(head.link)}`
    }
    expect(served).toEqual(lines)
  })

  it('resumes from the newest right checkpoint when a newer one diverged', async () => {
    const { id, lines } = await realLogLines(appendTurn, 1)
    const fixture = await oracleFixture(lines, { id })
    const newest = lines.length - 1
    const response = await fixture.call(
      `${lineQuery(id)}&have=${String(newest)}:${'9'.repeat(64)},${String(newest - 1)}:${fixture.links[newest - 1]}`,
    )
    expect(response.status).toBe(200)
    const { head, lines: served } = parseLinesResponse(await response.text(), id)
    expect(head.start).toBe(newest)
    expect(served).toEqual(lines.slice(newest))
  })

  it('serves the whole log from 0 when no checkpoint matches', async () => {
    const { id, lines } = await realLogLines(appendTurn, 1)
    const fixture = await oracleFixture(lines, { id })
    const response = await fixture.call(`${lineQuery(id)}&have=${String(lines.length - 1)}:${'1'.repeat(64)}`)
    expect(response.status).toBe(200)
    const { head, lines: served } = parseLinesResponse(await response.text(), id)
    expect(head.start).toBe(0)
    expect(head.header).toBeDefined()
    expect(head.headerLink).toBeDefined()
    expect(served).toEqual(lines)
  })

  it('answers up to date with no lines, the cursor, and its link', async () => {
    const { id, lines } = await realLogLines(appendTurn, 1)
    const fixture = await oracleFixture(lines, { id })
    const newest = lines.length - 1
    const response = await fixture.call(`${lineQuery(id)}&have=${String(newest)}:${fixture.links[newest]}`)
    expect(response.status).toBe(200)
    const { head, lines: served } = parseLinesResponse(await response.text(), id)
    expect(head.start).toBe(lines.length)
    expect(head.through).toBe(newest)
    expect(head.link).toBe(fixture.links[newest])
    expect(head.header).toBeUndefined()
    expect(served).toEqual([])
  })

  it('sends one oversized line alone under a small maxBytes', async () => {
    const { id, lines } = await realLogLines((session, turn) => {
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'x'.repeat(9000) }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }, 1)
    const fixture = await oracleFixture(lines, { id })
    const first = await fixture.call(`${lineQuery(id)}&maxBytes=4096`)
    expect(first.status).toBe(200)
    const firstBody = parseLinesResponse(await first.text(), id)
    expect(firstBody.lines).toEqual(lines.slice(0, 1))
    const second = await fixture.call(
      `${lineQuery(id)}&maxBytes=4096&have=${String(firstBody.head.through)}:${String(firstBody.head.link)}`,
    )
    expect(second.status).toBe(200)
    const secondBody = parseLinesResponse(await second.text(), id)
    expect(secondBody.lines).toEqual(lines.slice(1, 2))
    expect(secondBody.head.through).toBe(1)
  })

  it('serves an empty log with a null link', async () => {
    const { id, lines } = await realLogLines(() => {}, 0)
    const fixture = await oracleFixture(lines, { id })
    const response = await fixture.call(lineQuery(id))
    expect(response.status).toBe(200)
    const { head, lines: served } = parseLinesResponse(await response.text(), id)
    expect(head.start).toBe(0)
    expect(head.through).toBe(-1)
    expect(head.cursor).toBe(-1)
    expect(head.link).toBeNull()
    expect(head.header).toBe(fixture.headerLine)
    expect(served).toEqual([])
  })
})

describe('stored-line verification on the route', () => {
  /** A fixture whose log carries one non-canonical stored line, at the given seq. */
  async function tamperedFixture(
    id: SessionId, tamperAt: number,
  ): Promise<{ fixture: LinesFixture; tamperAt: number }> {
    const { lines } = await realLogLines(appendTurn, 1, {
      tamper: source => source.map((line, index) => index === tamperAt ? spacedJson(line) : line),
    })
    const fixture = await oracleFixture(lines, { id })
    return { fixture, tamperAt }
  }

  it('answers 409 line-unverifiable at a tampered first due line', async () => {
    const { fixture, tamperAt } = await tamperedFixture('lines-tamper-start' as SessionId, 0)
    const response = await fixture.call(lineQuery(fixture.id))
    expect(response.status).toBe(409)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual({ code: 'session/line-unverifiable', seq: tamperAt })
  })

  it('answers 409 when a resumption reaches a tampered line', async () => {
    const { fixture, tamperAt } = await tamperedFixture('lines-tamper-resume' as SessionId, 2)
    const before = tamperAt - 1
    const response = await fixture.call(`${lineQuery(fixture.id)}&have=${String(before)}:${fixture.links[before]}`)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: 'session/line-unverifiable', seq: tamperAt })
  })

  it('stops before a tampered mid-log line and serves the verified prefix', async () => {
    const { fixture, tamperAt } = await tamperedFixture('lines-tamper-mid' as SessionId, 2)
    const response = await fixture.call(lineQuery(fixture.id))
    expect(response.status).toBe(200)
    const { head, lines: served } = parseLinesResponse(await response.text(), fixture.id)
    expect(served).toEqual(fixture.lines.slice(0, tamperAt))
    expect(head.through).toBe(tamperAt - 1)
    expect(head.link).toBe(fixture.links[tamperAt - 1])
  })

  it('succeeds when the budget ends before a tampered line', async () => {
    const tamperAt = 2
    const { id, lines } = await realLogLines((session, turn) => {
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'y'.repeat(5000) }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }, 1, {
      tamper: source => source.map((line, index) => index === tamperAt ? spacedJson(line) : line),
    })
    const fixture = await oracleFixture(lines, { id })
    const budget = lines.slice(0, tamperAt)
      .reduce((total, line) => total + Buffer.byteLength(line, 'utf8') + 1, 0)
    const response = await fixture.call(`${lineQuery(id)}&maxBytes=${String(budget)}`)
    expect(response.status).toBe(200)
    const { head, lines: served } = parseLinesResponse(await response.text(), id)
    expect(served).toEqual(lines.slice(0, tamperAt))
    expect(budget).toBeGreaterThanOrEqual(4096)
    expect(head.through).toBe(tamperAt - 1)
    expect(head.link).toBe(fixture.links[tamperAt - 1])
  })

  it('answers 409 lines-unavailable when the observation carries no chain', async () => {
    const { id, lines } = await realLogLines(appendTurn, 1)
    const fixture = await oracleFixture(lines, { id, withoutChain: true })
    const response = await fixture.call(lineQuery(id))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: 'session/lines-unavailable' })
  })

  it('serves a published v3 successor over the successor file bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lines-v3-'))
    roots.push(root)
    const id = 'migrated-v3' as SessionId
    const path = generationLogPath(join(root, 'logs'), '/workspace', id, 3, 'none')
    const rows = [
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'user/message',
        data: { id: 'v3-u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
        surfaceOp: 'append',
      },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ].map((row, index) => ({ ...row, seq: index, time: index + 10 }))
    const header = { type: 'session', version: 3, id, createdAt: 1, cwd: '/workspace', isSeeded: false, delegationDepth: 0 }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, [header, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n')

    const source = new Context()
    await source.plugin(SessionStore)
    await source.plugin(AgentRegistry)
    await source.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
    const writer = await source.sessionPersistence.open(id, 'write')
    await writer.close()
    await source.fiber.dispose()
    const successor = await readFile(generationLogPath(join(root, 'logs'), '/workspace', id, SESSION_FORMAT_VERSION, 'none'), 'utf8')
    const fileLines = successor.split('\n').slice(0, -1)
    const headerLine = fileLines[0]
    if (headerLine === undefined) throw new Error('the published successor lacks its header line')
    const lines = fileLines.slice(1)
    expect(lines.length).toBe(rows.length)

    const fixture = await oracleFixture(lines, { id, headerLine })
    const response = await fixture.call(lineQuery(id))
    expect(response.status).toBe(200)
    const { head, lines: served } = parseLinesResponse(await response.text(), id)
    expect(head.start).toBe(0)
    expect(served).toEqual(lines)
    expect(head.header).toBe(headerLine)
    const expectedHeaderLink = createHash('sha256')
      .update(CHAIN_TAG, 'utf8').update(headerLine, 'utf8').digest('hex')
    expect(head.headerLink).toBe(expectedHeaderLink)
    expect(head.link).toBe(fixture.links.at(-1))
  })
})

describe('cold reads of a migrated log across chunks', () => {
  it('prepares the migration once while unrelated Sessions are written between requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lines-chunks-'))
    roots.push(root)
    const logs = join(root, 'logs')
    const id = 'chunked-v3' as SessionId
    const path = generationLogPath(logs, '/workspace', id, 3, 'none')
    const rows = Array.from({ length: 12 }, (_, turn) => [
      { type: 'turn/start', data: { turn: turn + 1 } },
      {
        type: 'user/message',
        data: { id: `v3-u${String(turn)}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(2000) }] },
        surfaceOp: 'append',
      },
      { type: 'turn/end', data: { turn: turn + 1, reason: { kind: 'completed' } } },
    ]).flat().map((row, index) => ({ ...row, seq: index, time: index + 10 }))
    const header = { type: 'session', version: 3, id, createdAt: 1, cwd: '/workspace', isSeeded: false, delegationDepth: 0 }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, [header, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n')

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: logs, compression: 'none' })
    const call = captureLinesRoute(ctx)
    await createSessionTestController(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: root,
    })
    const other = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    await ctx.sessionPersistence.create(other.header)
    const opens = vi.spyOn(ctx.sessionPersistence, 'open')

    const served: string[] = []
    let have: string | undefined
    for (let request = 0; request < 20; request += 1) {
      appendTurn(other, request + 1)
      await ctx.sessions.flush(other)
      const response = await call(`${lineQuery(id)}&maxBytes=4096${have === undefined ? '' : `&have=${have}`}`)
      expect(response.status).toBe(200)
      const { head, lines } = parseLinesResponse(await response.text(), id)
      served.push(...lines)
      have = `${String(head.through)}:${String(head.link)}`
      if (head.through >= head.cursor) break
    }
    expect(served).toHaveLength(rows.length)
    expect(opens.mock.calls.filter(([opened]) => opened === id)).toHaveLength(1)
  })
})

describe('shared line encoding helpers', () => {
  it('falls back to the event record when stored bytes are not UTF-8', () => {
    const event = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as never
    const link = 'a'.repeat(64) as never
    expect(lineEntry(event, new Uint8Array([0xff, 0xfe]), link, undefined)).toEqual({
      type: 'event', event, link,
    })
    expect(lineEntry(event, new Uint8Array([0x7b, 0x7d]), link, undefined)).toMatchObject({
      type: 'line', seq: 0, line: '{}', link,
    })
  })

  it('answers undefined past a covered chain and brands covered links', () => {
    const chain = testStoredChain(Buffer.from('{}', 'utf8'), [Buffer.from('{}', 'utf8')])
    const at = linkAtOf(chain)
    expect(at?.(0)).toMatch(/^[0-9a-f]{64}$/)
    expect(at?.(1)).toBeUndefined()
    expect(linkAtOf(undefined)).toBeUndefined()
  })
})

describe('access and lifecycle of the lines route', () => {
  async function realHostFixture(): Promise<LinesRouteCall> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lines-real-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
    const call = captureLinesRoute(ctx)
    await createSessionTestController(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: root,
    })
    return call
  }

  it('rejects malformed parameters with 400 naming the parameter', async () => {
    const call = await realHostFixture()
    const longCheckpoint = (count: number): string =>
      Array.from({ length: count }, (_, index) => `${String(100 - index)}:${'a'.repeat(64)}`).join(',')
    for (const [query, parameter] of [
      ['', 'sessionId'],
      ['?sessionId=', 'sessionId'],
      ['?sessionId=lines&have=nolink', 'have'],
      ['?sessionId=lines&have=f:aaa', 'have'],
      [`?sessionId=lines&have=${String(-1)}:${'a'.repeat(64)}`, 'have'],
      [`?sessionId=lines&have=3:${'A'.repeat(64)}`, 'have'],
      [`?sessionId=lines&have=3:${'a'.repeat(63)}`, 'have'],
      [`?sessionId=lines&have=3:${'a'.repeat(64)},3:${'b'.repeat(64)}`, 'have'],
      [`?sessionId=lines&have=4:${'a'.repeat(64)},5:${'a'.repeat(64)}`, 'have'],
      [`?sessionId=lines&have=${longCheckpoint(33)}`, 'have'],
      ['?sessionId=lines&maxBytes=4095', 'maxBytes'],
      [`?sessionId=lines&maxBytes=${String(8388609)}`, 'maxBytes'],
      ['?sessionId=lines&maxBytes=3.5', 'maxBytes'],
      ['?sessionId=lines&maxBytes=abc', 'maxBytes'],
      ['?sessionId=lines&maxBytes=', 'maxBytes'],
      ['?sessionId=lines&maxBytes=0x1000', 'maxBytes'],
      ['?sessionId=lines&maxBytes=1e4', 'maxBytes'],
      ['?sessionId=lines&maxBytes=%204096', 'maxBytes'],
      [`?sessionId=lines&have=0x3:${'a'.repeat(64)}`, 'have'],
      [`?sessionId=lines&have=3e0:${'a'.repeat(64)}`, 'have'],
      [`?sessionId=lines&have=-0:${'a'.repeat(64)}`, 'have'],
      [`?sessionId=lines&have=${'9'.repeat(17)}:${'a'.repeat(64)}`, 'have'],
    ] as const) {
      const response = await call(query)
      expect(response.status, query).toBe(400)
      expect(await response.text(), query).toContain(parameter)
    }
  })

  it('answers 404 for a session the backend does not store', async () => {
    const call = await realHostFixture()
    const response = await call(lineQuery('absent' as SessionId))
    expect(response.status).toBe(404)
  })

  it('activates no Agent for a stored session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lines-active-'))
    roots.push(root)
    const stored = new Context()
    await stored.plugin(SessionStore)
    await stored.plugin(AgentRegistry)
    await stored.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
    const session = stored.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    await stored.sessionPersistence.create(session.header)
    appendTurn(session, 1, 'kept')
    await stored.sessions.flush(session)
    const id = session.id
    await stored.fiber.dispose()

    const cold = new Context()
    contexts.push(cold)
    await cold.plugin(SessionStore)
    await cold.plugin(SessionProjectionRegistry)
    await cold.plugin(AgentRegistry)
    await cold.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
    const call = captureLinesRoute(cold)
    await createSessionTestController(cold, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: root,
    })
    await call(lineQuery(id))

    expect(cold.sessions.get(id)).toBeUndefined()
  })

  it('answers 400 for a subagent child', async () => {
    const { id, lines } = await realLogLines(appendTurn, 1)
    const child = await oracleFixture(lines, {
      id: 'child-of-parent' as SessionId,
      meta: { origin: 'subagent', parentSession: id },
    })
    const response = await child.call(lineQuery(child.id))
    expect(response.status).toBe(400)
    expect(await response.text()).toBe('subagent sessions are not copied')
  })

  it('answers 404 when the observed session has no cwd', async () => {
    const { lines } = await realLogLines(appendTurn, 1)
    const cwdless = await oracleFixture(lines, { id: 'no-cwd' as SessionId, withoutCwd: true, withoutChain: true })
    const response = await cwdless.call(lineQuery(cwdless.id))
    expect(response.status).toBe(404)
  })

  it('rethrows read failures outside the not-found taxonomy', async () => {
    const { id, lines } = await realLogLines(appendTurn, 1)
    const fixture = await oracleFixture(lines, { id })
    await expect(fixture.call(lineQuery(id), { signal: AbortSignal.abort() })).rejects.toThrow()
  })

  it('unregisters the route on disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lines-dispose-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    const call = captureLinesRoute(ctx)
    await createSessionTestController(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: root,
    })
    expect(call.unregistered).toHaveLength(0)
    await ctx.fiber.dispose()
    expect(call.unregistered).toHaveLength(1)
  })
})

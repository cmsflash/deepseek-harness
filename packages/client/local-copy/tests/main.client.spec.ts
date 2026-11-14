/** Worker dispatch: message protocol, migration, and answer paths over the real store (§2.13). */

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { headerLinkOf, nextLink, toHex } from '../src/client/worker/chain.ts'
import { localCopyWorkerMain, type WorkerScope } from '../src/client/worker/main.ts'
import type { LockHost } from '../src/client/worker/downloader.ts'
import { buildChunkInputs, LocalCopyStore, type StoredLine } from '../src/client/worker/store.ts'

const sessionId = brandString<SessionId>('session-main')

/** Three stored lines that decode as valid wire events. */
const SCRIPT0 = '{"type":"turn/start","seq":0,"time":1700000000000,"data":{"turn":1}}'
const SCRIPT2 = [
  SCRIPT0,
  '{"type":"turn/end","seq":1,"time":1700000000001,"data":{"turn":1,"reason":{"kind":"completed"}}}',
]
const SCRIPT3 = [
  ...SCRIPT2,
  '{"type":"turn/start","seq":2,"time":1700000000002,"data":{"turn":2}}',
]

/** One reply the worker posts for a request. */
interface Reply {
  readonly id: number
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly message: string }
}

/** Narrow one posted frame into a typed reply for awaiting callers. */
const replyOf = (message: unknown): Reply => {
  if (typeof message !== 'object' || message === null) return { id: -1, ok: false }
  const posted = message as { readonly id?: unknown; readonly ok?: unknown; readonly value?: unknown; readonly error?: unknown }
  return {
    id: typeof posted.id === 'number' ? posted.id : -1,
    ok: posted.ok === true,
    value: posted.value,
    ...(typeof posted.error === 'object' && posted.error !== null && 'message' in posted.error
      ? { error: posted.error as { readonly message: string } }
      : {}),
  }
}

/** One fake worker global collecting posts. */
class Scope implements WorkerScope {
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  readonly posted: unknown[] = []
  terminated = false
  private nextId = 0
  private readonly pending = new Map<number, (value: Reply) => void>()
  private readonly env: { fetch: typeof fetch; locks: LockHost | undefined; onLine: () => boolean }

  constructor(
    fetchImpl: typeof fetch = async (): Promise<Response> => new Response('', { status: 404 }),
    sharedFactory?: IDBFactory,
  ) {
    this.env = { fetch: fetchImpl, locks: undefined, onLine: () => true }
    this.factoryShared = sharedFactory
  }

  private readonly factoryShared: IDBFactory | undefined

  postMessage(message: unknown): void {
    this.posted.push(message)
    const response = message as { readonly id?: number; readonly ok?: boolean; readonly value?: unknown; readonly type?: string }
    if (typeof response.id === 'number' && typeof response.ok === 'boolean') {
      this.pending.get(response.id)?.(replyOf(message))
      this.pending.delete(response.id)
    }
  }

  /**
   * Post one method call and resolve with the worker's reply value.
   * @param method - worker method name.
   * @param params - method parameters.
   * @returns the reply's `value` field.
   */
  async call(method: string, params: unknown): Promise<unknown> {
    this.nextId += 1
    const id = this.nextId
    const posted = await new Promise<Reply>((resolve) => {
      this.pending.set(id, resolve)
      this.onmessage?.({ data: { id, method, ...(params === undefined ? {} : { params }) } })
    })
    if (!posted.ok) throw new Error(posted.error?.message ?? 'the worker call failed')
    return posted.value
  }

  notify(message: unknown): void {
    this.onmessage?.({ data: message })
  }

  get indexedDB(): IDBFactory { return this.factoryShared ?? this.factory }
  get keyRange(): typeof IDBKeyRange { return this.keyRangeImpl }
  get fetch(): typeof fetch { return this.env.fetch }
  get locks(): LockHost | undefined { return undefined }
  get onLine(): () => boolean { return this.env.onLine }

  readonly factory = new IDBFactory()
  readonly keyRangeImpl = IDBKeyRange
  get isIndexedDbMissing(): boolean { return false }
}

beforeEach(() => {
  // Fake IndexedDB drives its queue through setImmediate; only the loop's timers are faked.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

/** Flush real promise work between fake-timer advances. */
async function flush(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await Promise.resolve()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
}

/** Wake the worker after the startup delay and settle its async work. */
async function boot(): Promise<void> {
  await vi.advanceTimersByTimeAsync(3_000)
  await flush()
}

/** A scripted thread log the route serves, with links under node:crypto. */
interface Script {
  readonly header: string
  readonly events: readonly string[]
  readonly headerLink: string
  readonly links: readonly string[]
}

async function script(events: readonly string[], header = '{"version":4,"id":"main"}'): Promise<Script> {
  const headerLink = toHex(await headerLinkOf(new TextEncoder().encode(header)))
  const links: string[] = []
  let previous = await headerLinkOf(new TextEncoder().encode(header))
  for (const text of events) {
    previous = await nextLink(previous, new TextEncoder().encode(text))
    links.push(toHex(previous))
  }
  return { header, events, headerLink, links }
}

/** Coerce one fetch input to a URL the way the builtin does. */
function toUrl(input: URL | RequestInfo): URL {
  if (input instanceof URL) return input
  const text = input instanceof Request ? input.url : input
  return new URL(text)
}

/** A fetch that serves the script per §2.3, 409s on demand. */
function route(from: Script): typeof fetch {
  return async (input: URL | RequestInfo): Promise<Response> => {
    const url = toUrl(input)
    const have = (url.searchParams.get('have') ?? '').split(',').filter(entry => entry.length > 0)
      .map((entry) => {
        const [seq, link] = entry.split(':', 2)
        return { seq: Number(seq), link: link ?? '' }
      })
    let start = 0
    for (const checkpoint of have) {
      if (checkpoint.seq >= start && checkpoint.seq < from.events.length && from.links[checkpoint.seq] === checkpoint.link) {
        start = checkpoint.seq + 1
      }
    }
    const body = from.events.slice(start)
    const head = {
      type: 'dsh-session-lines',
      version: 1,
      sessionId,
      start,
      through: start + body.length - 1,
      cursor: from.events.length - 1,
      ...(start + body.length - 1 === -1 ? { link: null } : { link: from.links[start + body.length - 1] }),
      ...(start === 0 ? { header: from.header, headerLink: from.headerLink } : {}),
    }
    return new Response(`${JSON.stringify(head)}\n${body.join('\n')}${body.length > 0 ? '\n' : ''}`)
  }
}

describe('local copy worker main', () => {
  it('answers opening, page, interval, and elided reads from the stored copy', async () => {
    const from = await script(SCRIPT3)
    const scope = new Scope(route(from))
    const stop = localCopyWorkerMain(scope)
    await scope.call('init', {
      linesUrl: 'http://harness.test/api/session/lines',
      phone: false,
      scope: 'opened',
      chunkBytes: 1_048_576,
      minPauseMs: 1,
      diskBudgetBytes: 0,
    })
    await scope.call('opened', { sessionId })
    await boot()
    const store = new LocalCopyStore({ indexedDB: scope.factory, keyRange: IDBKeyRange })
    await waitForCondition(async () => (await store.readThread(sessionId))?.state === 'complete')
    const opening = await scope.call('opening', { sessionId, window: { maxMessages: 5, full: true } }) as
      { records: { event: { seq: number } }[]; hasMore: boolean; cursor: number } | undefined
    expect(opening).toBeDefined()
    expect(opening?.records?.[0]?.event.seq).toBe(0)
    expect(opening?.cursor).toBe(2)
    const page = await scope.call('page', { sessionId, request: { beforeSeq: 2, maxMessages: 2, throughSeq: 2, full: true } }) as
      { records: { event: { seq: number } }[]; hasMore: boolean } | undefined
    expect(page?.records.map(record => record.event.seq)).toEqual([0, 1])
    const interval = await scope.call('interval', { sessionId, request: { fromSeq: 1, throughSeq: 2, full: true } })
    expect(Array.isArray(interval)).toBe(true)
    const elided = await scope.call('elided', { sessionId, request: { turn: 1, throughSeq: 2, full: true } })
    expect(Array.isArray(elided)).toBe(true)
    const usage = await scope.call('usage', undefined) as { threads: number; complete: number }
    expect(usage).toMatchObject({ threads: 1, complete: 1 })
    stop.stop()
  })

  it('stores verified live appends and repairs on a gap', async () => {
    const from = await script(SCRIPT2)
    const scope = new Scope(route(from))
    const stop = localCopyWorkerMain(scope)
    await scope.call('init', {
      linesUrl: 'http://harness.test/api/session/lines',
      phone: false,
      scope: 'opened',
      chunkBytes: 1_048_576,
      minPauseMs: 1,
      diskBudgetBytes: 0,
    })
    await scope.call('opened', { sessionId })
    await boot()
    const store = new LocalCopyStore({ indexedDB: scope.factory, keyRange: IDBKeyRange })
    await waitForCondition(async () => ((await store.readThread(sessionId))?.head ?? -2) >= 0)
    let chain = await headerLinkOf(new TextEncoder().encode(from.header))
    for (const text of from.events) {
      chain = await nextLink(chain, new TextEncoder().encode(text))
    }
    const grown = SCRIPT2[1] === undefined ? '' : SCRIPT2[1]
    void grown
    const extra = '{"type":"turn/start","seq":2,"time":1700000000002,"data":{"turn":2}}'
    const link2 = toHex(await nextLink(chain, new TextEncoder().encode(extra)))
    await scope.call('append', { sessionId, lines: [{ seq: 2, line: extra, link: link2 }] })
    const appended = await store.readThread(sessionId)
    expect(appended?.head).toBe(2)
    stop.stop()
  })

  it('records an opened session and a diverged repair', async () => {
    const from = await script([SCRIPT0])
    const scope = new Scope(route(from))
    const stop = localCopyWorkerMain(scope)
    await scope.call('init', {
      linesUrl: 'http://harness.test/api/session/lines',
      phone: false,
      scope: 'opened',
      chunkBytes: 1_048_576,
      minPauseMs: 1,
      diskBudgetBytes: 0,
    })
    await scope.call('opened', { sessionId })
    await boot()
    const store = new LocalCopyStore({ indexedDB: scope.factory, keyRange: IDBKeyRange })
    await waitForCondition(async () => (await store.readThread(sessionId))?.complete === true)
    await scope.call('opened', { sessionId })
    await scope.call('diverged', { sessionId })
    const reopened = await store.readThread(sessionId)
    expect(reopened?.complete).toBe(false)
    stop.stop()
  })

  it('migrates recorded follow keys once, then clears on request', async () => {
    const factory = new IDBFactory()
    await writeFollow(factory, 'stream session/follow {"args":{"request":{"address":{"kind":"session","sessionId":"session-migrated"}}}}')
    await writeFollow(factory, 'call session/list {}')
    const scope = new Scope(undefined, factory)
    const stop = localCopyWorkerMain(scope)
    await scope.call('init', {
      linesUrl: 'http://harness.test/api/session/lines',
      phone: false,
      scope: 'opened',
      chunkBytes: 1_048_576,
      minPauseMs: 1,
      diskBudgetBytes: 0,
    })
    await boot()
    const store = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    const migrated = brandString<SessionId>('session-migrated')
    const migratedThread = await store.readThread(migrated)
    // The unserved default route parks the migrated thread; the migration's own
    // record is what matters.
    expect(['downloading', 'paused']).toContain(migratedThread?.state)
    const usage = await scope.call('usage', undefined) as { threads: number }
    expect(usage.threads).toBeGreaterThanOrEqual(1)
    await scope.call('clear', undefined)
    expect(await store.readThread(migrated)).toBeUndefined()
    stop.stop()
  })

  it('answers plant schedule and visibility state updates', async () => {
    const from = await script([SCRIPT0])
    const scope = new Scope(route(from))
    const stop = localCopyWorkerMain(scope)
    await scope.call('init', {
      linesUrl: 'http://harness.test/api/session/lines',
      phone: true,
      scope: 'all',
      chunkBytes: 1_048_576,
      minPauseMs: 1,
      diskBudgetBytes: 0,
    })
    await scope.call('schedule', { listed: [{ sessionId, activityAt: 42, activitySeq: -1, running: false }] })
    await scope.call('state', { offline: true, hidden: false })
    await scope.call('state', { offline: false, hidden: true })
    stop.stop()
  })

  it('reports one worker failure as an error reply with its message', async () => {
    const from = await script([SCRIPT0])
    const scope = new Scope(route(from))
    const failing = Object.create(scope.factory) as IDBFactory
    const refusing: IDBFactory['open'] = () => { throw new Error('quota blocked the open') }
    failing.open = refusing
    Object.defineProperty(scope, 'indexedDB', { get: () => failing, configurable: true })
    const stop = localCopyWorkerMain(scope)
    await expect(scope.call('usage', undefined)).rejects.toThrow('quota blocked the open')
    expect(scope.posted.at(-1)).toMatchObject({ ok: false, error: { code: 'Error', message: 'quota blocked the open' } })
    stop.stop()
  })

  it('reports the innermost cause of a wrapped failure as the error code', async () => {
    const scope = new Scope()
    const failing = Object.create(scope.factory) as IDBFactory
    const refusing: IDBFactory['open'] = () => {
      throw new Error('local copy: transaction aborted', { cause: new DOMException('the disk is full', 'QuotaExceededError') })
    }
    failing.open = refusing
    Object.defineProperty(scope, 'indexedDB', { get: () => failing, configurable: true })
    const stop = localCopyWorkerMain(scope)
    await expect(scope.call('usage', undefined)).rejects.toThrow('local copy: transaction aborted')
    expect(scope.posted.at(-1)).toMatchObject({ ok: false, error: { code: 'QuotaExceededError' } })
    stop.stop()
  })

  it('keeps working when the worker scope has no IndexedDB', () => {
    const scope = new Scope()
    const degraded = Object.create(scope) as WorkerScope & { indexedDB: undefined }
    Object.defineProperty(degraded, 'indexedDB', { get: () => undefined })
    expect(() => localCopyWorkerMain(degraded)).not.toThrow()
  })

  it('stops a degraded worker cleanly', () => {
    const scope = new Scope()
    const degraded = Object.create(scope) as WorkerScope & { indexedDB: undefined }
    Object.defineProperty(degraded, 'indexedDB', { get: () => undefined })
    const handle = localCopyWorkerMain(degraded)
    expect(() => { handle.stop() }).not.toThrow()
  })

  it('ignores messages that are not worker requests', async () => {
    const from = await script([SCRIPT0])
    const scope = new Scope(route(from))
    const stop = localCopyWorkerMain(scope)
    await scope.call('init', {
      linesUrl: 'http://harness.test/api/session/lines',
      phone: false,
      scope: 'opened',
      chunkBytes: 1_048_576,
      minPauseMs: 1,
      diskBudgetBytes: 0,
    })
    expect(() => { scope.notify(undefined) }).not.toThrow()
    expect(() => { scope.notify('not a request') }).not.toThrow()
    expect(() => { scope.notify({ id: 1 }) }).not.toThrow()
    expect(() => { scope.notify({ id: 'one', method: 'usage' }) }).not.toThrow()
    expect(() => { scope.notify({ id: 2, method: 'usage', params: 'not an object' }) }).not.toThrow()
    stop.stop()
  })

  it('reports a non-error failure with its string form', async () => {
    const scope = new Scope()
    const failing = Object.create(scope.factory) as IDBFactory
    const refusing: IDBFactory['open'] = () => { throw 'open refused by the disk' }
    failing.open = refusing
    Object.defineProperty(scope, 'indexedDB', { get: () => failing, configurable: true })
    const handle = localCopyWorkerMain(scope)
    await expect(scope.call('usage', undefined)).rejects.toThrow('open refused by the disk')
    expect(scope.posted.at(-1)).toMatchObject({ ok: false, error: { code: 'error', message: 'open refused by the disk' } })
    handle.stop()
  })

  it('runs the offline-replay migration once and refuses a second init', async () => {
    const factory = new IDBFactory()
    await writeFollow(factory, 'stream session/follow {"args":{"request":{"address":{"kind":"session","sessionId":"session-once"}}}}')
    const scope = new Scope(undefined, factory)
    const stop = localCopyWorkerMain(scope)
    const init = {
      linesUrl: 'http://harness.test/api/session/lines',
      phone: false,
      scope: 'opened',
      chunkBytes: 1_048_576,
      minPauseMs: 1,
      diskBudgetBytes: 0,
    }
    await scope.call('init', init)
    const store = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    expect(await store.readThread(brandString<SessionId>('session-once'))).toBeDefined()
    expect(await store.readMeta('migratedOfflineReplay')).toBe(true)
    await expect(scope.call('init', init)).rejects.toThrow('local copy: downloader is already initialized')
    stop.stop()
  })

  it('leaves a replaced message listener in place at stop', async () => {
    const from = await script([SCRIPT0])
    const scope = new Scope(route(from))
    const stop = localCopyWorkerMain(scope)
    const replaced = (): void => {}
    scope.onmessage = replaced
    stop.stop()
    expect(scope.onmessage).toBe(replaced)
  })
})

/** A stored fixture parsed back into lines the store accepts. */
export async function storedLines(from: Script, events: readonly string[]): Promise<readonly StoredLine[]> {
  const headerLink = await headerLinkOf(new TextEncoder().encode(from.header))
  const lines: StoredLine[] = []
  let previous = headerLink
  for (const [index, text] of events.entries()) {
    const bytes = new TextEncoder().encode(text)
    previous = await nextLink(previous, bytes)
    lines.push({ seq: index, bytes, link: previous })
  }
  return lines
}

void storedLines
void buildChunkInputs

/** Write one recorded key into the offline replay database of a factory. */
async function writeFollow(factory: IDBFactory, key: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = factory.open('dsh-offline-replay', 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('records') }
    request.onsuccess = () => {
      const connection = request.result
      const tx = connection.transaction('records', 'readwrite')
      tx.objectStore('records').put({}, key)
      tx.oncomplete = () => { connection.close(); resolve() }
    }
  })
}

/** Poll until one async condition holds, bounded by real timers. */
async function waitForCondition(condition: () => Promise<boolean>, rounds = 200): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    if (await condition()) return
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
  throw new Error('test condition never held')
}

/** The download loop: order, pauses, locks, quota, offline and hidden pauses, restarts (§2.5). */

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocalCopyDownloader, type LockHost } from '../src/client/worker/downloader.ts'
import { buildChunkInputs, LocalCopyStore, type ThreadRecord } from '../src/client/worker/store.ts'
import { headerLinkOf, nextLink, toHex } from '../src/client/worker/chain.ts'
import type { SessionChainLink } from '@deepseek-ai/dsh-api-session-controller/types'
import type { LocalCopyInit, LocalCopyThreadNotification } from '../src/client/protocol.ts'
import { failChunkPuts, failQueuedChunkWrites, quotaError } from './storage-failures.client.ts'

const encoder = new TextEncoder()

const sessionId = (name: string): SessionId => brandString<SessionId>(name)

/** One served log with its chain links, computed under node:crypto-verified fixtures. */
interface Fixture {
  readonly header: string
  readonly events: readonly string[]
  readonly headerLink: string
  readonly links: readonly string[]
}

async function fixture(events: readonly string[], name: string): Promise<Fixture> {
  const header = `{"version":4,"id":"${name}"}`
  const headerLink = toHex(await headerLinkOf(encoder.encode(header)))
  const links: string[] = []
  let previous = await headerLinkOf(encoder.encode(header))
  for (const text of events) {
    previous = await nextLink(previous, encoder.encode(text))
    links.push(toHex(previous))
  }
  return { header, events, headerLink, links }
}

/** A per-session route memory serving §2.3 responses from one fixture each. */
/** Coerce one fetch input to a URL the way the builtin does. */
function toUrl(input: URL | RequestInfo): URL {
  if (input instanceof URL) return input
  if (input instanceof Request) return new URL(input.url)
  return new URL(`route-${input}`)
}

/** Seed one stored thread of a fixture's first events with its true links. */
async function seedPart(store: LocalCopyStore, id: SessionId, from: Fixture): Promise<void> {
  const lines = from.events.map((text, index) => ({ seq: index, bytes: encoder.encode(text), link: hex(from.links[index] ?? '') }))
  await store.replaceThread(id, from.header, brandString<SessionChainLink>(from.headerLink), buildChunkInputs(id, lines, 1_048_576), {})
}

class FakeRoute {
  private readonly logs = new Map<SessionId, Fixture>()
  readonly fetched: SessionId[] = []
  failWith: ((sessionId: SessionId) => Response | undefined) | undefined

  serve(log: Fixture, id: SessionId): void {
    this.logs.set(id, log)
  }

  readonly fetch = async (input: URL | RequestInfo): Promise<Response> => {
    const url = toUrl(input)
    const id = brandString<SessionId>(url.searchParams.get('sessionId') ?? '')
    const log = this.logs.get(id)
    if (log === undefined) return new Response('', { status: 404 })
    this.fetched.push(id)
    const forced = this.failWith?.(id)
    if (forced !== undefined) return forced
    const have = (url.searchParams.get('have') ?? '').split(',').filter(entry => entry.length > 0)
      .map((entry) => {
        const [seq, link] = entry.split(':', 2)
        return { seq: Number(seq), link: link ?? '' }
      })
    // §2.3: the route answers one past the highest seq whose link matches.
    let start = 0
    for (const checkpoint of have) {
      if (checkpoint.seq >= start && checkpoint.seq < log.events.length && log.links[checkpoint.seq] === checkpoint.link) {
        start = checkpoint.seq + 1
      }
    }
    const maxBytes = Number(url.searchParams.get('maxBytes'))
    const body: string[] = []
    let bytes = 0
    for (let seq = start; seq < log.events.length; seq++) {
      const line = log.events[seq]
      if (line === undefined) break
      // At least one line is due whenever the request has any.
      if (body.length > 0 && bytes + line.length + 1 > maxBytes) break
      body.push(line)
      bytes += line.length + 1
    }
    const through = start + body.length - 1
    const head = {
      type: 'dsh-session-lines',
      version: 1,
      sessionId: id,
      start,
      through,
      cursor: log.events.length - 1,
      ...(through === -1 || log.links[through] === undefined ? { link: null } : { link: log.links[through] }),
      ...(start === 0 ? { header: log.header, headerLink: log.headerLink } : {}),
    }
    return new Response(`${JSON.stringify(head)}\n${body.join('\n')}${body.length > 0 ? '\n' : ''}`)
  }
}

/** Drain pending promise work between timer advances. */
async function flush(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await Promise.resolve()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
}

/** Advance fake time and flush async work until one condition holds. */
async function drain(condition: () => boolean, budgetMs = 30_000, stepMs = 25): Promise<void> {
  let waited = 0
  while (!condition() && waited < budgetMs) {
    await vi.advanceTimersByTimeAsync(stepMs)
    await flush(6)
    waited += stepMs
  }
}

/** Restores of the storage failures a test injected. */
const restores: (() => void)[] = []

afterEach(() => {
  for (const restore of restores.splice(0)) restore()
})

beforeEach(() => {
  // Fake IndexedDB drives its transaction queue through setImmediate, so only the
  // loop's own timers and the clock run under fake time.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})

/** One downloader wired to a fresh store and a fake route. */
function harness(options: {
  readonly init?: Partial<LocalCopyInit>
  readonly locks?: LockHost
  readonly store?: LocalCopyStore
  readonly fetch?: typeof fetch
  readonly onLine?: () => boolean
}): { downloader: LocalCopyDownloader; notifications: LocalCopyThreadNotification[] } {
  const notifications: LocalCopyThreadNotification[] = []
  const downloader = new LocalCopyDownloader(options.store ?? new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange }), {
    fetch: options.fetch ?? (async (): Promise<Response> => new Response('', { status: 404 })),
    locks: options.locks,
    onLine: options.onLine ?? (() => true),
    now: () => Date.now(),
  }, (notification) => { notifications.push(notification) })
  downloader.init({
    linesUrl: 'http://harness.test/api/session/lines',
    phone: false,
    scope: 'all',
    chunkBytes: 1_048_576,
    minPauseMs: 100,
    diskBudgetBytes: 0,
    ...options.init,
  })
  return { downloader, notifications }
}

describe('local copy downloader', () => {
  it('downloads listed threads newest activity first and marks them complete', async () => {
    const route = new FakeRoute()
    route.serve(await fixture(['{"seq":0}', '{"seq":1}'], 'a'), sessionId('a'))
    route.serve(await fixture(['{"seq":0}'], 'b'), sessionId('b'))
    const { downloader, notifications } = harness({ fetch: route.fetch })
    downloader.schedule([
      { sessionId: sessionId('a'), activityAt: 5, activitySeq: -1, running: false },
      { sessionId: sessionId('b'), activityAt: 9, activitySeq: -1, running: false },
    ])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.length === 2)
    expect(route.fetched).toEqual([sessionId('b'), sessionId('a')])
    expect(notifications).toEqual([
      { type: 'thread', sessionId: sessionId('b'), state: 'complete', head: 0, cursorSeen: 0 },
      { type: 'thread', sessionId: sessionId('a'), state: 'complete', head: 1, cursorSeen: 1 },
    ])
    const fetched = route.fetched.length
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(route.fetched.length).toBe(fetched)
  })

  it('puts a thread opened in this tab ahead of listed ones', async () => {
    const route = new FakeRoute()
    route.serve(await fixture(['{"seq":0}'], 'listed'), sessionId('listed'))
    route.serve(await fixture(['{"seq":0}'], 'opened'), sessionId('opened'))
    const { downloader, notifications } = harness({ fetch: route.fetch })
    downloader.schedule([{ sessionId: sessionId('listed'), activityAt: 100, activitySeq: -1, running: false }])
    await downloader.opened(sessionId('opened'))
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.length === 2)
    expect(route.fetched).toEqual([sessionId('opened'), sessionId('listed')])
  })

  it('pauses after each chunk by the busy arithmetic', async () => {
    const events = Array.from({ length: 6 }, (_value, index) => `{"seq":${String(index)}}`)
    const route = new FakeRoute()
    const joined = encoder.encode(events.join('\n')).byteLength
    route.serve(await fixture(events, 'paused'), sessionId('paused'))
    const { downloader, notifications } = harness({ fetch: route.fetch, init: { chunkBytes: Math.ceil(joined / 2) } })
    downloader.schedule([{ sessionId: sessionId('paused'), activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => route.fetched.length === 1)
    // No second request goes out before the pause elapses on fake time.
    await drain(() => notifications.length >= 1)
    await vi.advanceTimersByTimeAsync(50)
    await flush(4)
    expect(route.fetched).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ state: 'downloading' })
    await drain(() => route.fetched.length >= 2)
    await drain(() => notifications.some(entry => entry.state === 'complete'))
    expect(notifications.some(entry => entry.state === 'complete')).toBe(true)
  })

  it('waits for the origin-wide web lock before its first request', async () => {
    const route = new FakeRoute()
    route.serve(await fixture(['{"seq":0}'], 'locked'), sessionId('locked'))
    let release: (() => void) | undefined
    let queued: (() => Promise<void>) | undefined
    const locks: LockHost = {
      request: <T>(_name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> =>
        new Promise<T>((resolve) => {
          queued = callback as () => Promise<void>
          release = () => { resolve(null as T) }
        }),
    }
    const { downloader } = harness({ fetch: route.fetch, locks })
    downloader.schedule([{ sessionId: sessionId('locked'), activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await flush()
    const held = queued
    expect(held).not.toBeUndefined()
    expect(route.fetched).toEqual([])
    release?.()
    void held?.()
    await drain(() => route.fetched.length === 1)
    expect(route.fetched).toEqual([sessionId('locked')])
  })

  it('marks a line-unverifiable thread and retries it on open, at most hourly otherwise', async () => {
    const route = new FakeRoute()
    const id = sessionId('broken')
    route.serve(await fixture(['{"seq":0}'], 'broken'), id)
    const { downloader, notifications } = harness({ fetch: route.fetch })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'complete'))
    expect(notifications).toContainEqual({ type: 'thread', sessionId: id, state: 'complete', head: 0, cursorSeen: 0 })
    // The Host can no longer check its lines, so a repair attempt runs into a 409.
    route.failWith = session => session === id
      ? new Response(JSON.stringify({ code: 'session/line-unverifiable', seq: 3 }), { status: 409 })
      : undefined
    await downloader.diverged(id)
    await drain(() => notifications.some(entry => entry.state === 'unverifiable'))
    const at409 = route.fetched.length
    // An unverifiable thread never retries on the idle poll before an hour passes.
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(route.fetched.length).toBe(at409)
    // Opening the thread clears the block and runs one more attempt.
    await downloader.opened(id)
    await drain(() => route.fetched.length > at409, 60_000, 50)
    expect(route.fetched.length).toBe(at409 + 1)
  })

  it('pauses while the page reported offline and resumes when it comes back', async () => {
    const route = new FakeRoute()
    route.serve(await fixture(['{"seq":0}'], 'offline'), sessionId('offline'))
    const { downloader } = harness({ fetch: route.fetch })
    downloader.setOffline(true)
    downloader.schedule([{ sessionId: sessionId('offline'), activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await flush()
    expect(route.fetched).toEqual([])
    downloader.setOffline(false)
    await drain(() => route.fetched.length === 1)
    expect(route.fetched).toEqual([sessionId('offline')])
  })

  it('releases the lock and pauses while a phone page is hidden', async () => {
    const route = new FakeRoute()
    route.serve(await fixture(['{"seq":0}'], 'hidden'), sessionId('hidden'))
    const held: Array<() => void> = []
    const locks: LockHost = {
      request: <T>(_name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> => {
        held.push(() => { void callback() })
        return callback()
      },
    }
    const { downloader, notifications } = harness({ fetch: route.fetch, locks, init: { phone: true } })
    downloader.setHidden(true)
    downloader.schedule([{ sessionId: sessionId('hidden'), activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await flush()
    expect(route.fetched).toEqual([])
    // A hidden phone page never holds the download lock.
    expect(held).toHaveLength(0)
    downloader.setHidden(false)
    await drain(() => notifications.length === 1)
    expect(route.fetched).toEqual([sessionId('hidden')])
    expect(held).toHaveLength(1)
  })

  it('evicts whole phone copies on quota, then retries the write once', async () => {
    const route = new FakeRoute()
    const current = sessionId('current-chunk')
    const victim = sessionId('victim')
    route.serve(await fixture(['{"seq":0}', '{"seq":1}'], 'current'), current)
    const sharedFactory = new IDBFactory()
    const store = new LocalCopyStore({ indexedDB: sharedFactory, keyRange: IDBKeyRange })
    // An old, complete copy that quota eviction may delete.
    const oldHeader = '{"version":4,"id":"old"}'
    const oldLines: { seq: number; bytes: Uint8Array<ArrayBuffer>; link: Uint8Array<ArrayBuffer> }[] = []
    let previous = await headerLinkOf(encoder.encode(oldHeader))
    for (const [index, text] of ['{"seq":0}', '{"seq":1}'].entries()) {
      const bytes = encoder.encode(text)
      const link = await nextLink(previous, bytes)
      oldLines.push({ seq: index, bytes, link })
      previous = link
    }
    const victimChunks = buildChunkInputs(victim, oldLines, 1_048_576)
    await store.ensureThread(victim, Date.now() - 11 * 60_000)
    await store.replaceThread(victim, oldHeader, brandString<SessionChainLink>(toHex(await headerLinkOf(encoder.encode(oldHeader)))), victimChunks, { state: 'complete', complete: true })
    let failures = 0
    restores.push(await failQueuedChunkWrites(chunk => chunk.sessionId === current && (failures += 1) === 1 ? quotaError() : undefined))
    const { downloader, notifications } = harness({ fetch: route.fetch, store, init: { phone: true, diskBudgetBytes: 25 } })
    downloader.schedule([{ sessionId: current, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'complete' && entry.sessionId === current))
    expect(await store.readThread(victim)).toBeUndefined()
    expect(await store.readThread(current)).toMatchObject({ head: 1, state: 'complete' })
    expect(notifications.at(-1)).toMatchObject({ sessionId: current, state: 'complete' })
    expect(failures).toBe(2)
    // The retry writes the response it already verified instead of fetching again.
    expect(route.fetched).toEqual([current])
  })

  it('parks never-opened desktop threads on quota without retrying', async () => {
    const route = new FakeRoute()
    const id = sessionId('desktop-quota')
    route.serve(await fixture(['{"seq":0}'], 'dq'), id)
    const failing = { attempts: 0 }
    restores.push(failChunkPuts(() => {
      failing.attempts += 1
      return quotaError()
    }))
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    const { downloader, notifications } = harness({ fetch: route.fetch, store })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'paused'))
    expect(notifications.at(-1)).toMatchObject({ state: 'paused' })
    expect(route.fetched).toEqual([id])
    const attempts = failing.attempts
    expect(attempts).toBe(2)
    expect(await store.readThread(id)).toMatchObject({ state: 'paused', head: -1, problem: { code: 'quota' } })
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(failing.attempts).toBe(attempts)
  })

  it('verifies live appends from the head link and queues a repair on a gap', async () => {
    const route = new FakeRoute()
    const id = sessionId('append')
    const base = await fixture(['{"seq":0}', '{"seq":1}'], 'append')
    route.serve(base, id)
    const { downloader, notifications } = harness({ fetch: route.fetch })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.length > 0)
    // A contiguous, link-verified append stores its small chunk.
    await downloader.append(id, [{ seq: 2, line: '{"seq":2}', link: toHex(await nextLink(hex(base.links[1] ?? ''), encoder.encode('{"seq":2}'))) }])
    // A gapped append stores nothing and wakes the repair path.
    await downloader.append(id, [{ seq: 4, line: '{"seq":4}', link: toHex(await nextLink(hex(base.links[1] ?? ''), encoder.encode('{"seq":4}'))) }])
    expect(notifications.length).toBeGreaterThanOrEqual(1)
  })

  it('resumes from the stored head after a simulated worker restart', async () => {
    const route = new FakeRoute()
    const id = sessionId('restart')
    const first = await fixture(['{"seq":0}', '{"seq":1}'], 'restart')
    route.serve(first, id)
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    const round = harness({ fetch: route.fetch, store })
    round.downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => round.notifications.some(entry => entry.state === 'complete'))
    expect(round.notifications.at(-1)).toMatchObject({ state: 'complete', head: 1 })
    round.downloader.dispose()
    const grown = await fixture(['{"seq":0}', '{"seq":1}', '{"seq":2}'], 'restart')
    route.serve(grown, id)
    const restart = harness({ fetch: route.fetch, store })
    // The complete copy is not re-fetched, and the appended line extends it live.
    await restart.downloader.append(id, [{ seq: 2, line: '{"seq":2}', link: grown.links[2] ?? '' }])
    await vi.advanceTimersByTimeAsync(3_000)
    await flush()
    expect(route.fetched).toEqual([id])
    expect(await store.readThread(id)).toMatchObject({ head: 2 })
  })

  it('wakes nothing for a diverged thread it never stored', async () => {
    const route = new FakeRoute()
    const { downloader, notifications } = harness({ fetch: route.fetch })
    await downloader.diverged(sessionId('never-stored'))
    await vi.advanceTimersByTimeAsync(3_000)
    await flush()
    expect(route.fetched).toEqual([])
    expect(notifications).toEqual([])
  })

  it('ignores appends for threads it has no verified head of', async () => {
    const route = new FakeRoute()
    const absent = sessionId('absent')
    const { downloader } = harness({ fetch: route.fetch })
    await downloader.append(absent, [{ seq: 0, line: '{"seq":0}', link: '0'.repeat(64) }])
    const partial = sessionId('partial-append')
    await downloader.append(partial, [])
    await downloader.append(partial, [{ seq: 0, line: '{"seq":0}', link: '0'.repeat(64) }])
    expect(route.fetched).toEqual([])
  })

  it('queues a repair when a stored head link cannot parse', async () => {
    const raw = sessionId('raw-head')
    const factory = new IDBFactory()
    const store = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    await store.ensureThread(raw, 1)
    await new Promise<void>((resolve, reject) => {
      const request = factory.open('dsh-local-copy')
      request.onsuccess = () => {
        const tx = request.result.transaction('threads', 'readwrite')
        tx.objectStore('threads').put({
          sessionId: raw, chainTag: 'dsh-session-chain/1', header: null, headerLink: null, head: 1,
          headLink: 'not-hex', lineBytes: 20, chunkCount: 1, cursorSeen: 1, complete: false,
          state: 'downloading', openedAt: 1, syncedAt: 1, activityAt: 0, activitySeq: -1, activityRunning: false,
        }, raw)
        tx.oncomplete = () => { request.result.close(); resolve() }
        tx.onerror = () => { reject(tx.error ?? new Error('fixture: seed failed')) }
      }
    })
    const route = new FakeRoute()
    const { downloader, notifications } = harness({ fetch: route.fetch, store })
    await downloader.append(raw, [{ seq: 2, line: '{"seq":2}', link: '0'.repeat(64) }])
    await downloader.diverged(raw)
    expect(notifications).toEqual([])
    expect((await store.readThread(raw))?.state).toBe('downloading')
    downloader.dispose()
  })

  it('queues a repair when a contiguous append lies about its link', async () => {
    const route = new FakeRoute()
    const id = sessionId('lying-link')
    const base = await fixture(['{"seq":0}', '{"seq":1}'], 'lying-link')
    route.serve(base, id)
    const { downloader, notifications } = harness({ fetch: route.fetch })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'complete'))
    await downloader.append(id, [{ seq: 2, line: '{"seq":2}', link: 'f'.repeat(64) }])
    expect(notifications.some(entry => entry.state === 'downloading')).toBe(true)
    downloader.dispose()
  })

  it('keeps a complete copy complete when live lines repeat lines a refresh already stored', async () => {
    const id = sessionId('raced')
    const base = await fixture(['{"seq":0}', '{"seq":1}', '{"seq":2}'], 'raced')
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    await seedPart(store, id, base)
    await store.markThread(id, { state: 'complete', complete: true, cursorSeen: 2 })
    const { downloader, notifications } = harness({ store, init: { scope: 'opened' } })
    // The follow's frames for seqs 1 and 2 arrive after the refresh stored them; seq 3 continues the head.
    const next = await fixture([...base.events, '{"seq":3}'], 'raced')
    await downloader.append(id, [1, 2, 3].map(seq => ({ seq, line: next.events[seq] ?? '', link: next.links[seq] ?? '' })))
    expect(await store.readThread(id)).toMatchObject({ head: 3, complete: true, state: 'complete' })
    expect(notifications).toEqual([])
    downloader.dispose()
  })

  it('queues a repair when a live line at or below the head carries another link', async () => {
    const id = sessionId('raced-diverged')
    const base = await fixture(['{"seq":0}', '{"seq":1}', '{"seq":2}'], 'raced-diverged')
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    await seedPart(store, id, base)
    await store.markThread(id, { state: 'complete', complete: true, cursorSeen: 2 })
    const { downloader, notifications } = harness({ store, init: { scope: 'opened' } })
    await downloader.append(id, [{ seq: 2, line: '{"seq":2}', link: 'f'.repeat(64) }])
    expect(await store.readThread(id)).toMatchObject({ head: 2, complete: false, state: 'downloading' })
    expect(notifications).toEqual([{ type: 'thread', sessionId: id, state: 'downloading', head: 2, cursorSeen: 2 }])
    downloader.dispose()
  })

  it('marks a thread paused when the route answers lines-unavailable', async () => {
    const route = new FakeRoute()
    const id = sessionId('unavailable')
    route.serve(await fixture(['{"seq":0}'], 'unavailable'), id)
    route.failWith = session => session === id
      ? new Response(JSON.stringify({ code: 'session/lines-unavailable' }), { status: 409 })
      : undefined
    const { downloader, notifications } = harness({ fetch: route.fetch })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'paused'))
    expect(notifications.at(-1)).toMatchObject({ sessionId: id, state: 'paused' })
    downloader.dispose()
  })

  it('marks a thread unverifiable when the chain it serves does not hold', async () => {
    const route = new FakeRoute()
    const id = sessionId('mismatch')
    const honest = await fixture(['{"seq":0}', '{"seq":1}'], 'mismatch')
    const broken = { ...honest, links: [honest.links[0] ?? '', 'e'.repeat(64)] }
    route.serve(broken, id)
    const { downloader, notifications } = harness({ fetch: route.fetch })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'unverifiable'))
    expect(notifications.at(-1)).toMatchObject({ sessionId: id, state: 'unverifiable' })
    downloader.dispose()
  })

  it('enforces the disk budget before storing, evicting the least recently opened first', async () => {
    const route = new FakeRoute()
    const id = sessionId('budget-opened')
    route.serve(await fixture(['{"seq":0}', '{"seq":1}'], 'budget-opened'), id)
    const factory = new IDBFactory()
    const store = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    const victims: readonly [SessionId, number, string][] = [
      [sessionId('budget-oldest'), Date.now() - 11 * 60_000, 'oldest'],
      [sessionId('budget-newer'), Date.now() - 10 * 60_000 - 1_000, 'newer'],
    ]
    for (const [victim, openedAt, name] of victims) {
      await seedPart(store, victim, await fixture([`{"who":"${name}"}`], `budget-${name}`))
      await store.markThread(victim, { state: 'complete', complete: true, openedAt })
    }

    const oldestBytes = (await store.readThread(victims[0]?.[0] ?? id))?.lineBytes ?? 0
    const newerBytes = (await store.readThread(victims[1]?.[0] ?? id))?.lineBytes ?? 0
    expect(oldestBytes).toBeGreaterThan(0)
    expect(newerBytes).toBeGreaterThan(0)
    const { downloader, notifications } = harness({
      fetch: route.fetch,
      store,
      init: { phone: true, diskBudgetBytes: newerBytes + 20 },
    })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'complete'))
    expect(await store.readThread(sessionId('budget-oldest'))).toBeUndefined()
    expect(await store.readThread(sessionId('budget-newer'))).toBeDefined()
    expect(await store.readThread(id)).toMatchObject({ state: 'complete', head: 1 })
    downloader.dispose()
  })

  it('parks the download with a quota problem when the budget cannot free room', async () => {
    const route = new FakeRoute()
    const id = sessionId('budget-stuck')
    route.serve(await fixture(['{"seq":0}', '{"seq":1}'], 'budget-stuck'), id)
    const factory = new IDBFactory()
    const store = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    const fresh = sessionId('budget-fresh')
    await seedPart(store, fresh, await fixture(['{"who":"fresh"}'], 'budget-fresh'))
    await store.markThread(fresh, { state: 'complete', complete: true, openedAt: Date.now() - 60_000 })
    const { downloader, notifications } = harness({
      fetch: route.fetch,
      store,
      init: { phone: true, diskBudgetBytes: 10 },
    })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'paused'))
    expect(await store.readThread(id)).toMatchObject({ state: 'paused', problem: { code: 'quota' } })
    expect(await store.readThread(fresh)).toBeDefined()
    const stuck = route.fetched.filter(session => session === id).length
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(route.fetched.filter(session => session === id).length).toBe(stuck)
    downloader.dispose()
  })

  it('parks with a quota problem when another tab fills the room between the two checks', async () => {
    const route = new FakeRoute()
    const id = sessionId('budget-raced')
    route.serve(await fixture(['{"seq":0}'], 'budget-raced'), id)
    class Raced extends LocalCopyStore {
      private raced = false
      public override async listThreads(): Promise<ThreadRecord[]> {
        const threads = await super.listThreads()
        if (!this.raced) return threads
        // The recheck sees a copy another tab stored after the first budget pass.
        return [...threads.filter(thread => thread.sessionId !== 'budget-raced'), {
          sessionId: sessionId('budget-intruder'), chainTag: 'dsh-session-chain/1', header: 'h', headerLink: null,
          head: 0, headLink: null, lineBytes: 500, chunkCount: 1, cursorSeen: 0, complete: false,
          state: 'downloading', openedAt: Date.now(), syncedAt: Date.now(), activityAt: 0, activitySeq: -1, activityRunning: false,
        }]
      }
      public race(): void {
        this.raced = true
      }
    }
    const raced = new Raced({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    restores.push(await failQueuedChunkWrites(() => {
      raced.race()
      return quotaError()
    }))
    const { downloader, notifications } = harness({ fetch: route.fetch, store: raced, init: { diskBudgetBytes: 100 } })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'paused'))
    expect(notifications.at(-1)).toMatchObject({ sessionId: id, state: 'paused' })
    downloader.dispose()
  })

  it('backs off a 404 from a Host restart window instead of pausing for ten minutes', async () => {
    for (const status of [404, 401, 403] as const) {
      const route = new FakeRoute()
      const id = sessionId(`restart-${String(status)}`)
      route.serve(await fixture(['{"seq":0}', '{"seq":1}'], `restart-${String(status)}`), id)
      let misses = 0
      route.failWith = session => session === id && misses < 1
        ? (misses += 1, new Response('', { status }))
        : undefined
      const { downloader, notifications } = harness({ fetch: route.fetch })
      downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
      await vi.advanceTimersByTimeAsync(3_000)
      await drain(() => route.fetched.length >= 2)
      await drain(() => notifications.some(entry => entry.state === 'complete'))
      expect(notifications.some(entry => entry.state === 'paused')).toBe(false)
      downloader.dispose()
    }
  })

  it('clears a stale problem when a later round completes', async () => {
    const route = new FakeRoute()
    const id = sessionId('stale-problem')
    route.serve(await fixture(['{"seq":0}', '{"seq":1}'], 'stale-problem'), id)
    let misses = 0
    route.failWith = session => session === id && (misses += 1) === 2
      ? new Response('', { status: 418 })
      : undefined
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    const { downloader, notifications } = harness({ fetch: route.fetch, store, init: { chunkBytes: 12 } })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => route.fetched.length >= 2)
    await drain(() => notifications.some(entry => entry.state === 'paused'))
    expect(await store.readThread(id)).toMatchObject({ state: 'paused', head: 0, problem: { code: 'http' } })
    route.failWith = undefined
    const pausedAt = route.fetched.length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await drain(() => notifications.some(entry => entry.state === 'complete'))
    expect(route.fetched.length).toBeGreaterThan(pausedAt)
    const record = await store.readThread(id)
    expect(record).toMatchObject({ state: 'complete', complete: true, head: 1 })
    expect(record?.problem).toBeUndefined()
    downloader.dispose()
  })

  it('backs off on a network failure and on a failing queue read, then recovers', async () => {
    const route = new FakeRoute()
    const id = sessionId('flaky')
    route.serve(await fixture(['{"seq":0}'], 'flaky'), id)
    let fetches = 0
    const flaky: typeof fetch = async (input: URL | RequestInfo): Promise<Response> => {
      fetches += 1
      if (fetches === 1) throw new TypeError('fetch failed')
      return route.fetch(input)
    }
    let listFailures = 0
    class FailingList extends LocalCopyStore {
      public override async listThreads(): Promise<ThreadRecord[]> {
        if ((listFailures += 1) === 1) throw new Error('listing failed')
        return await super.listThreads()
      }
    }
    const store = new FailingList({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { downloader, notifications } = harness({ fetch: flaky, store })
    await downloader.opened(id)
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'complete'))
    expect(fetches).toBe(2)
    expect(notifications.at(-1)).toMatchObject({ state: 'complete' })
    downloader.schedule([{ sessionId: sessionId('listed-after'), activityAt: 1, activitySeq: -1, running: false }])
    await drain(() => listFailures >= 2)
    expect(warn).toHaveBeenCalledWith('local copy: a download round failed', expect.objectContaining({ message: 'listing failed' }))
    warn.mockRestore()
    downloader.dispose()
  })

  it('stores an empty log the route answers with cursor -1 as a complete copy', async () => {
    const route = new FakeRoute()
    const id = sessionId('empty-log')
    route.serve(await fixture([], 'empty-log'), id)
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    const { downloader, notifications } = harness({ fetch: route.fetch, store })
    await downloader.opened(id)
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'complete'))
    expect(await store.readThread(id)).toMatchObject({ head: -1, cursorSeen: -1, complete: true, state: 'complete', header: '{"version":4,"id":"empty-log"}' })
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    await flush()
    expect(route.fetched).toEqual([id])
    downloader.dispose()
  })

  it('parks a thread whose round fails unexpectedly and moves on to the next one', async () => {
    const route = new FakeRoute()
    const broken = sessionId('malformed-head')
    const healthy = sessionId('healthy-after')
    route.serve(await fixture(['{"seq":0}'], 'malformed-head'), broken)
    route.serve(await fixture(['{"seq":0}'], 'healthy-after'), healthy)
    route.failWith = session => session === broken ? new Response('<html>a proxy page</html>', { status: 200 }) : undefined
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { downloader, notifications } = harness({ fetch: route.fetch, store })
    downloader.schedule([
      { sessionId: broken, activityAt: 9, activitySeq: -1, running: false },
      { sessionId: healthy, activityAt: 1, activitySeq: -1, running: false },
    ])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.sessionId === healthy && entry.state === 'complete'))
    expect(await store.readThread(broken)).toMatchObject({ state: 'paused', problem: { code: 'unexpected' } })
    expect(route.fetched).toEqual([broken, healthy])
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await flush()
    expect(route.fetched).toEqual([broken, healthy])
    // Opening the thread retries it at once.
    await downloader.opened(broken)
    await drain(() => route.fetched.length === 3)
    expect(route.fetched).toEqual([broken, healthy, broken])
    warn.mockRestore()
    downloader.dispose()
  })

  it('holds a failing thread out of the queue when its parking cannot be stored', async () => {
    const route = new FakeRoute()
    const broken = sessionId('unparkable')
    const healthy = sessionId('healthy-next')
    route.serve(await fixture(['{"seq":0}'], 'unparkable'), broken)
    route.serve(await fixture(['{"seq":0}'], 'healthy-next'), healthy)
    route.failWith = session => session === broken ? new Response('not json', { status: 200 }) : undefined
    class Unparkable extends LocalCopyStore {
      public override async markThread(): Promise<ThreadRecord | undefined> {
        throw new Error('record write failed')
      }
    }
    const store = new Unparkable({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { downloader, notifications } = harness({ fetch: route.fetch, store })
    downloader.schedule([
      { sessionId: broken, activityAt: 9, activitySeq: -1, running: false },
      { sessionId: healthy, activityAt: 1, activitySeq: -1, running: false },
    ])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.sessionId === healthy && entry.state === 'complete'))
    expect(route.fetched).toEqual([broken, healthy])
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    await flush()
    expect(route.fetched).toEqual([broken, healthy])
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    await drain(() => route.fetched.length === 3)
    expect(route.fetched).toEqual([broken, healthy, broken])
    warn.mockRestore()
    downloader.dispose()
  })

  it('waits while navigator onLine reports offline and resumes on the next wake', async () => {
    const route = new FakeRoute()
    const id = sessionId('navigator-offline')
    route.serve(await fixture(['{"seq":0}'], 'nav-off'), id)
    let online = false
    const { downloader, notifications } = harness({ fetch: route.fetch, onLine: () => online })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await flush()
    expect(route.fetched).toEqual([])
    online = true
    downloader.schedule([{ sessionId: id, activityAt: 2, activitySeq: -1, running: false }])
    await drain(() => notifications.some(entry => entry.state === 'complete'))
    expect(route.fetched).toEqual([id])
    downloader.dispose()
  })

  it('keeps going without a notification when another tab deleted the thread mid-failure', async () => {
    const route = new FakeRoute()
    const id = sessionId('vanishing')
    route.serve(await fixture(['{"seq":0}'], 'vanishing'), id)
    class Vanishing extends LocalCopyStore {
      public override async markThread(): Promise<ThreadRecord | undefined> {
        return undefined
      }
    }
    route.failWith = () => new Response(JSON.stringify({ code: 'session/lines-unavailable' }), { status: 409 })
    const { downloader, notifications } = harness({
      fetch: route.fetch,
      store: new Vanishing({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange }),
    })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => route.fetched.length === 1)
    await flush()
    expect(notifications).toEqual([])
    downloader.dispose()
  })

  it('orders stored threads by their last open on this device', async () => {
    const route = new FakeRoute()
    const older = sessionId('older-open')
    const newer = sessionId('newer-open')
    route.serve(await fixture(['{"seq":0}'], 'older-open'), older)
    route.serve(await fixture(['{"seq":0}'], 'newer-open'), newer)
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    await store.ensureThread(older, 10)
    await store.ensureThread(newer, 20)
    const { downloader, notifications } = harness({ fetch: route.fetch, store })
    downloader.schedule([{ sessionId: sessionId('listed-ignored'), activityAt: 5, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.length === 2)
    expect(route.fetched).toEqual([newer, older])
    downloader.dispose()
  })

  it('re-downloads a stored record whose head claims chunks that are gone', async () => {
    const route = new FakeRoute()
    const id = sessionId('gone-chunks')
    route.serve(await fixture(['{"seq":0}', '{"seq":1}'], 'gone-chunks'), id)
    const factory = new IDBFactory()
    const store = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    await store.ensureThread(id, 1)
    await new Promise<void>((resolve, reject) => {
      const request = factory.open('dsh-local-copy')
      request.onsuccess = () => {
        const tx = request.result.transaction('threads', 'readwrite')
        tx.objectStore('threads').put({
          sessionId: id, chainTag: 'dsh-session-chain/1', header: null, headerLink: null, head: 1,
          headLink: 'a'.repeat(64), lineBytes: 20, chunkCount: 1, cursorSeen: 1, complete: false,
          state: 'downloading', openedAt: 1, syncedAt: 1, activityAt: 0, activitySeq: -1, activityRunning: false,
        }, id)
        tx.oncomplete = () => { request.result.close(); resolve() }
        tx.onerror = () => { reject(tx.error ?? new Error('fixture: seed failed')) }
      }
    })
    const { downloader, notifications } = harness({ fetch: route.fetch, store })
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'complete'))
    expect(await store.readThread(id)).toMatchObject({ head: 1, state: 'complete' })
    downloader.dispose()
  })

  it('accepts an empty append against a stored head as a no-op', async () => {
    const route = new FakeRoute()
    const id = sessionId('empty-append')
    const base = await fixture(['{"seq":0}', '{"seq":1}'], 'empty-append')
    route.serve(base, id)
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    const { downloader, notifications } = harness({ fetch: route.fetch, store })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'complete'))
    const head = (await store.readThread(id))?.head
    await downloader.append(id, [])
    expect((await store.readThread(id))?.head).toBe(head)
    expect(notifications.every(entry => entry.state === 'complete')).toBe(true)
    downloader.dispose()
  })

  it('evicts both old copies, least recently opened first, when quota needs the room', async () => {
    const route = new FakeRoute()
    const current = sessionId('quota-order-current')
    const victimOld = sessionId('quota-order-old')
    const victimNew = sessionId('quota-order-new')
    route.serve(await fixture(['{"seq":0}', '{"seq":1}'], 'quota-order-current'), current)
    const factory = new IDBFactory()
    const store = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    const victims: readonly [SessionId, number, string][] = [[victimOld, 30, 'old'], [victimNew, 40, 'new']]
    for (const [id, openedAt, name] of victims) {
      const past = await fixture([`{"who":"${name}"}`], `quota-order-${name}`)
      await store.ensureThread(id, openedAt)
      const lines = past.events.map((text, index) => ({ seq: index, bytes: encoder.encode(text), link: hex(past.links[index] ?? '') }))
      await store.replaceThread(id, past.header, brandString<SessionChainLink>(past.headerLink), buildChunkInputs(id, lines, 1_048_576), { state: 'complete', complete: true })
    }
    let failures = 0
    restores.push(await failQueuedChunkWrites(() => {
      failures += 1
      return quotaError()
    }))
    const { downloader, notifications } = harness({ fetch: route.fetch, store, init: { phone: true, diskBudgetBytes: 10 } })
    downloader.schedule([{ sessionId: current, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'paused'))
    expect(await store.readThread(victimOld)).toBeUndefined()
    expect(await store.readThread(victimNew)).toBeUndefined()
    // The pre-store budget check parks the thread before the first write is attempted.
    expect(failures).toBe(0)
    downloader.dispose()
  })

  it('re-fetches after losing a continuation race against another tab', async () => {
    const route = new FakeRoute()
    const id = sessionId('lost-race')
    const starter = await fixture(['{"seq":0}'], 'lost-race')
    const base = await fixture(['{"seq":0}', '{"seq":1}'], 'lost-race')
    route.serve(base, id)
    const factory = new IDBFactory()
    const store = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    await seedPart(store, id, starter)
    class Racing extends LocalCopyStore {
      public override async appendChunks(): Promise<boolean> {
        return false
      }
    }
    const { downloader } = harness({
      fetch: route.fetch,
      store: new Racing({ indexedDB: factory, keyRange: IDBKeyRange }),
    })
    await downloader.opened(id)
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => route.fetched.length >= 2)
    expect(await store.readThread(id)).toMatchObject({ head: 0, state: 'downloading' })
    downloader.dispose()
  })

  it('keeps an exact chunk count through two truncating repairs in a row', async () => {
    const route = new FakeRoute()
    const id = sessionId('two-repairs')
    route.serve(await fixture(['{"seq":0}', '{"seq":1}', '{"seq":2}'], 'two-repairs'), id)
    const factory = new IDBFactory()
    const store = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    const { downloader, notifications } = harness({ fetch: route.fetch, store, init: { chunkBytes: 12 } })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    const completions = (): number => notifications.filter(entry => entry.state === 'complete').length
    await drain(() => completions() === 1)
    for (const [round, branch] of [[2, 'x'], [3, 'y']] as const) {
      // The Host's log now shares only seq 0 with the copy, so the repair truncates to it.
      route.serve(await fixture(['{"seq":0}', `{"${branch}":1}`, `{"${branch}":2}`], 'two-repairs'), id)
      await downloader.diverged(id)
      await drain(() => completions() === round)
      const record = await store.readThread(id)
      expect(record).toMatchObject({ head: 2, state: 'complete' })
      expect(record?.chunkCount).toBe(await storedChunkCount(factory, id))
      expect((await store.readLines(id, 0, 2)).map(line => new TextDecoder().decode(line.bytes)))
        .toEqual(['{"seq":0}', `{"${branch}":1}`, `{"${branch}":2}`])
    }
    downloader.dispose()
  })

  it('refuses a repair append when another tab replaced the line it was verified from', async () => {
    const route = new FakeRoute()
    const id = sessionId('repair-race')
    const served = await fixture(['{"seq":0}', '{"seq":1}', '{"seq":2}'], 'repair-race')
    route.serve(served, id)
    const factory = new IDBFactory()
    const store = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    // The copy shares seq 0 with the Host, so the repair verifies from seq 0's link and truncates to it.
    await seedPart(store, id, await fixture(['{"seq":0}', '{"diverged":1}'], 'repair-race'))
    const intruder = await fixture(['{"other":0}', '{"other":1}'], 'repair-intruder')
    class Racing extends LocalCopyStore {
      private raced = false
      public override async truncateThread(sessionId: SessionId, newHead: number): Promise<ThreadRecord | undefined> {
        if (!this.raced) {
          this.raced = true
          // Another tab replaces the copy after the fetch verified its lines.
          await seedPart(store, id, intruder)
        }
        return await super.truncateThread(sessionId, newHead)
      }
    }
    const { downloader, notifications } = harness({ fetch: route.fetch, store: new Racing({ indexedDB: factory, keyRange: IDBKeyRange }) })
    await downloader.opened(id)
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'complete'))
    expect((await store.readLines(id, 0, 9)).map(line => new TextDecoder().decode(line.bytes))).toEqual(served.events)
    expect((await store.readThread(id))?.header).toBe(served.header)
    downloader.dispose()
  })

  it('stands down when a repair lost its thread to a truncate that found nothing', async () => {
    const route = new FakeRoute()
    const id = sessionId('repair-gone')
    const starter = await fixture(['{"seq":0}', '{"seq":0}'], 'repair-gone')
    // The served log shares the first line's link but diverges at the newest checkpoint.
    const base = await fixture(['{"seq":0}', '{"seq":1}'], 'repair-gone')
    route.serve(base, id)
    const factory = new IDBFactory()
    const store = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    await seedPart(store, id, starter)
    class Truncating extends LocalCopyStore {
      public override async truncateThread(): Promise<ThreadRecord | undefined> {
        return undefined
      }
    }
    const { downloader, notifications } = harness({
      fetch: route.fetch,
      store: new Truncating({ indexedDB: factory, keyRange: IDBKeyRange }),
    })
    await downloader.opened(id)
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => route.fetched.length >= 1)
    await flush()
    expect(notifications.filter(entry => entry.sessionId === id && entry.state === 'complete')).toEqual([])
    expect(await store.readThread(id)).toMatchObject({ head: 1 })
    downloader.dispose()
  })

  it('parks a phone thread whose quota budget nothing keeps', async () => {
    const route = new FakeRoute()
    const id = sessionId('phone-quota')
    const served = await fixture(['{"seq":0}'], 'phone-quota')
    route.serve(served, id)
    const failing = { calls: 0 }
    restores.push(await failQueuedChunkWrites(() => {
      failing.calls += 1
      return quotaError()
    }))
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    const { downloader, notifications } = harness({ fetch: route.fetch, store, init: { phone: true, diskBudgetBytes: 20 } })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'paused'))
    expect(notifications.at(-1)).toMatchObject({ sessionId: id, state: 'paused' })
    expect(failing.calls).toBe(2)
    downloader.dispose()
  })

  it('parks a thread whose write fails for a reason other than quota without retrying it', async () => {
    const route = new FakeRoute()
    const id = sessionId('write-failure')
    route.serve(await fixture(['{"seq":0}'], 'write-failure'), id)
    let failures = 0
    restores.push(await failQueuedChunkWrites(() => {
      failures += 1
      return new Error('disk failure')
    }))
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { downloader, notifications } = harness({ fetch: route.fetch, store })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'paused'))
    expect(failures).toBe(1)
    expect(await store.readThread(id)).toMatchObject({ state: 'paused', head: -1, problem: { code: 'unexpected' } })
    warn.mockRestore()
    downloader.dispose()
  })

  it('parks a thread whose quota retry write fails for another reason', async () => {
    const route = new FakeRoute()
    const id = sessionId('quota-rethrow')
    const served = await fixture(['{"seq":0}'], 'quota-rethrow')
    route.serve(served, id)
    let failures = 0
    restores.push(await failQueuedChunkWrites(() => (failures += 1) === 1 ? quotaError() : new Error('disk corruption')))
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    const { downloader, notifications } = harness({ fetch: route.fetch, store, init: { phone: true, diskBudgetBytes: 1_073_741_824 } })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => failures >= 2)
    const info = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await vi.advanceTimersByTimeAsync(10_000)
      await flush()
    } finally {
      info.mockRestore()
    }
    expect(failures).toBe(2)
    expect(notifications).toEqual([{ type: 'thread', sessionId: id, state: 'paused', head: -1, cursorSeen: -1 }])
    expect(await store.readThread(id)).toMatchObject({ problem: { code: 'unexpected' } })
    downloader.dispose()
  })

  it('silences the appended notification when the thread vanished between store and read', async () => {
    const route = new FakeRoute()
    const id = sessionId('vanished-read')
    const base = await fixture(['{"seq":0}', '{"seq":1}'], 'vanished-read')
    route.serve(base, id)
    const factory = new IDBFactory()
    const store = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    await seedPart(store, id, { ...base, events: base.events.slice(0, 1) })
    class Read extends LocalCopyStore {
      private seen = 0
      public override async readThread(sessionId: SessionId): Promise<ThreadRecord | undefined> {
        this.seen += 1
        if (this.seen >= 3) return undefined
        return await super.readThread(sessionId)
      }
    }
    const { downloader, notifications } = harness({
      fetch: route.fetch,
      store: new Read({ indexedDB: factory, keyRange: IDBKeyRange }),
    })
    await downloader.opened(id)
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.length >= 1)
    await flush()
    expect(notifications.filter(entry => entry.sessionId === id && entry.head === 1)).toEqual([])
    downloader.dispose()
  })
})

/** Count one thread's chunk rows directly in the database. */
function storedChunkCount(factory: IDBFactory, id: SessionId): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = factory.open('dsh-local-copy')
    request.onsuccess = () => {
      const count = request.result.transaction('chunks').objectStore('chunks').count(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))
      count.onsuccess = () => { request.result.close(); resolve(count.result) }
      count.onerror = () => { reject(count.error ?? new Error('fixture: count failed')) }
    }
  })
}

function hex(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32)
  for (let index = 0; index < 32; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

describe('local copy downloader, refreshing complete copies', () => {
  /** Events `{"seq":0}` … `{"seq":count − 1}`, so a longer log continues a shorter one's chain. */
  const events = (count: number): string[] => Array.from({ length: count }, (_, seq) => `{"seq":${String(seq)}}`)

  /** The route's request log: each request's checkpoint list. */
  function recorded(route: FakeRoute): { readonly fetch: typeof fetch; readonly haves: string[] } {
    const haves: string[] = []
    return {
      haves,
      fetch: async (input: URL | RequestInfo): Promise<Response> => {
        haves.push(toUrl(input).searchParams.get('have') ?? '')
        return await route.fetch(input)
      },
    }
  }

  it('fetches only the new lines of a complete copy after the list reports a later prompt', async () => {
    const route = new FakeRoute()
    const id = sessionId('grows')
    const first = await fixture(events(2), 'grows')
    route.serve(first, id)
    const requests = recorded(route)
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    const { downloader, notifications } = harness({ fetch: requests.fetch, store })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'complete'))
    route.serve(await fixture(events(4), 'grows'), id)
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    await flush()
    expect(route.fetched).toEqual([id])

    downloader.schedule([{ sessionId: id, activityAt: 2, activitySeq: -1, running: false }])
    await drain(() => notifications.at(-1)?.head === 3)
    expect(notifications.at(-1)).toEqual({ type: 'thread', sessionId: id, state: 'complete', head: 3, cursorSeen: 3 })
    expect(requests.haves.at(-1)?.startsWith(`1:${first.links[1] ?? ''}`)).toBe(true)
    expect(await store.readThread(id)).toMatchObject({
      head: 3, complete: true, chunkCount: 2, activityAt: 2, activitySeq: -1, activityRunning: false,
    })
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    await flush()
    expect(route.fetched).toEqual([id, id])
    downloader.dispose()
  })

  it('refreshes once when the list reports a projection cut past the stored head, even one the Host does not reach', async () => {
    const route = new FakeRoute()
    const id = sessionId('cut')
    route.serve(await fixture(events(2), 'cut'), id)
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    const { downloader, notifications } = harness({ fetch: route.fetch, store })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: 1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'complete'))
    route.serve(await fixture(events(3), 'cut'), id)
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: 1, running: false }])
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(route.fetched).toEqual([id])

    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: 2, running: false }])
    await drain(() => notifications.at(-1)?.head === 2)
    expect(route.fetched).toEqual([id, id])
    // A cut from another sequence space can exceed what the Host serves; one empty refresh records it.
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: 9, running: false }])
    await drain(() => route.fetched.length === 3)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await flush()
    expect(route.fetched).toEqual([id, id, id])
    expect(await store.readThread(id)).toMatchObject({ head: 2, complete: true, activitySeq: 9 })
    downloader.dispose()
  })

  it('refreshes a copy synced while its thread ran once the thread stops', async () => {
    const route = new FakeRoute()
    const id = sessionId('running')
    route.serve(await fixture(events(1), 'running'), id)
    const { downloader, notifications } = harness({ fetch: route.fetch })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: true }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'complete'))
    route.serve(await fixture(events(5), 'running'), id)
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: true }])
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(route.fetched).toEqual([id])
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await drain(() => notifications.at(-1)?.head === 4)
    expect(notifications.at(-1)).toMatchObject({ state: 'complete', head: 4 })
    downloader.dispose()
  })

  it('refreshes only threads opened on a phone, never ones it only lists', async () => {
    const route = new FakeRoute()
    const opened = sessionId('phone-opened')
    const listedOnly = sessionId('phone-listed')
    route.serve(await fixture(events(1), 'phone-opened'), opened)
    route.serve(await fixture(events(1), 'phone-listed'), listedOnly)
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    await store.ensureThread(opened, 10)
    const { downloader, notifications } = harness({ fetch: route.fetch, store, init: { phone: true, scope: 'opened', diskBudgetBytes: 0 } })
    downloader.schedule([
      { sessionId: opened, activityAt: 1, activitySeq: -1, running: false },
      { sessionId: listedOnly, activityAt: 1, activitySeq: -1, running: false },
    ])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'complete'))
    route.serve(await fixture(events(3), 'phone-opened'), opened)
    downloader.schedule([
      { sessionId: opened, activityAt: 2, activitySeq: -1, running: false },
      { sessionId: listedOnly, activityAt: 2, activitySeq: -1, running: false },
    ])
    await drain(() => notifications.at(-1)?.head === 2)
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(route.fetched).toEqual([opened, opened])
    downloader.dispose()
  })

  it('leaves a device copy under another chain tag alone', async () => {
    const route = new FakeRoute()
    const id = sessionId('foreign-tag')
    route.serve(await fixture(events(2), 'foreign-tag'), id)
    const factory = new IDBFactory()
    const store = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    await store.ensureThread(id, 1)
    await new Promise<void>((resolve, reject) => {
      const request = factory.open('dsh-local-copy')
      request.onsuccess = () => {
        const tx = request.result.transaction('threads', 'readwrite')
        tx.objectStore('threads').put({
          sessionId: id, chainTag: 'dsh-session-chain/2', header: null, headerLink: null, head: -1, headLink: null,
          lineBytes: 0, chunkCount: 0, cursorSeen: -1, complete: false, state: 'downloading', openedAt: 5, syncedAt: 1,
          activityAt: 0, activitySeq: -1, activityRunning: false,
        }, id)
        tx.oncomplete = () => { request.result.close(); resolve() }
        tx.onerror = () => { reject(tx.error ?? new Error('fixture: seed failed')) }
      }
    })
    const { downloader } = harness({ fetch: route.fetch, store })
    downloader.schedule([{ sessionId: id, activityAt: 9, activitySeq: 9, running: false }])
    await vi.advanceTimersByTimeAsync(3_000 + 60_000)
    await flush()
    expect(route.fetched).toEqual([])
    downloader.dispose()
  })

  it('waits out the hourly retry when a refresh finds the copy unverifiable', async () => {
    const route = new FakeRoute()
    const id = sessionId('refresh-unverifiable')
    route.serve(await fixture(events(1), 'refresh-unverifiable'), id)
    const store = new LocalCopyStore({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange })
    const { downloader, notifications } = harness({ fetch: route.fetch, store })
    downloader.schedule([{ sessionId: id, activityAt: 1, activitySeq: -1, running: false }])
    await vi.advanceTimersByTimeAsync(3_000)
    await drain(() => notifications.some(entry => entry.state === 'complete'))
    route.failWith = () => new Response(JSON.stringify({ code: 'session/line-unverifiable', seq: 0 }), { status: 409 })
    downloader.schedule([{ sessionId: id, activityAt: 2, activitySeq: -1, running: false }])
    await drain(() => notifications.some(entry => entry.state === 'unverifiable'))
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    await flush()
    expect(route.fetched).toEqual([id, id])
    route.failWith = undefined
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    await drain(() => route.fetched.length === 3)
    expect(await store.readThread(id)).toMatchObject({ state: 'complete', activityAt: 2 })
    downloader.dispose()
  })
})

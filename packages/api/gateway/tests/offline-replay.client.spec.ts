import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { ConnectionGeneration, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import {
  browserReplayEnvironment,
  OfflineReplay,
  openIndexedDbReplayStore,
  type OfflineReplayConnection,
  type OfflineReplayEnvironment,
  type OfflineReplayStore,
} from '../src/client/offline-replay.ts'
import { RemoteStream } from '../src/client/remote-stream.ts'
import { RemoteStreamCarrierError } from '../src/client/stream-client.ts'

function memoryStore(): OfflineReplayStore & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: key => Promise.resolve(structuredClone(data.get(key))),
    put: (key, value) => {
      data.set(key, structuredClone(value))
      return Promise.resolve()
    },
  }
}

function fakeConnection(): OfflineReplayConnection & { readonly held: boolean[]; reconnects: number } {
  const held: boolean[] = []
  const connection: OfflineReplayConnection & { readonly held: boolean[]; reconnects: number } = {
    held,
    reconnects: 0,
    state: { getSnapshot: () => 'connected' as const, subscribe: () => () => {} },
    generation: { getSnapshot: () => ({ id: 1, host: { home: '/home/me' } }), subscribe: () => () => {} },
    holdNetworkAvailable: (value: boolean) => { held.push(value) },
    reconnect: () => { connection.reconnects++ },
  }
  return connection
}

function fakeEnvironment(online = true): OfflineReplayEnvironment & {
  reachable: boolean
  emit(online: boolean): void
} {
  let listener: ((online: boolean) => void) | undefined
  const environment = {
    reachable: true,
    probe: () => Promise.resolve(environment.reachable),
    online: () => online,
    watch: (next: (online: boolean) => void) => {
      listener = next
      return () => { listener = undefined }
    },
    emit: (value: boolean) => { listener?.(value) },
  }
  return environment
}

const ok = (value: unknown): ConnectionRpcResult<unknown> => ({ ok: true, value })

async function collect(source: AsyncIterable<unknown>, count: number): Promise<unknown[]> {
  const items: unknown[] = []
  for await (const item of source) {
    items.push(item)
    if (items.length === count) break
  }
  return items
}

async function* items(...values: unknown[]): AsyncIterable<unknown> {
  for (const value of values) yield value
}

async function* failing(error: Error): AsyncIterable<unknown> {
  yield* []
  throw error
}

describe('OfflineReplay', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('answers recorded reads and refuses everything else while the Host is unreachable', async () => {
    const store = memoryStore()
    const connection = fakeConnection()
    const environment = fakeEnvironment()
    const replay = new OfflineReplay(store, connection, environment)
    const signal = new AbortController().signal

    await replay.call('session/list', { request: { b: 1, a: 2 } }, () => Promise.resolve(ok(['row'])), signal)
    await replay.call('session/prompt', { text: 'hi' }, () => Promise.resolve(ok({ accepted: true })), signal)
    await vi.advanceTimersByTimeAsync(0)
    expect([...store.data.keys()]).toEqual(['call session/list {"request":{"a":2,"b":1}}'])

    environment.emit(false)
    expect(replay.active).toBe(true)
    expect(connection.held).toEqual([true])
    expect(connection.reconnects).toBe(1)

    const live = vi.fn(() => Promise.resolve(ok('live')))
    await expect(replay.call('session/list', { request: { a: 2, b: 1 } }, live, signal)).resolves.toEqual(ok(['row']))
    await expect(replay.call('session/prompt', { text: 'hi' }, live, signal)).rejects.toThrow('the Host is unreachable')
    expect(live).not.toHaveBeenCalled()
    replay.dispose()
  })

  it('falls back to the record when a live read never reaches the Host, then probes into replay', async () => {
    const store = memoryStore()
    const connection = fakeConnection()
    const environment = fakeEnvironment()
    const replay = new OfflineReplay(store, connection, environment)
    const signal = new AbortController().signal
    await replay.call('settings/describe', {}, () => Promise.resolve(ok('settings')), signal)
    environment.reachable = false

    await expect(replay.call('settings/describe', {}, () => Promise.reject(new TypeError('Failed to fetch')), signal))
      .resolves.toEqual(ok('settings'))
    await vi.advanceTimersByTimeAsync(0)
    expect(replay.active).toBe(true)
    await expect(replay.call('session/cancel', {}, () => Promise.resolve(ok(true)), signal))
      .rejects.toThrow('the Host is unreachable')

    environment.reachable = true
    await vi.advanceTimersByTimeAsync(5_000)
    expect(replay.active).toBe(false)
    expect(connection.held).toEqual([true, false])
    expect(connection.reconnects).toBe(2)
    replay.dispose()
  })

  it('replays a stream log after its latest opening and stays open until cancelled', async () => {
    const store = memoryStore()
    const replay = new OfflineReplay(store, fakeConnection(), fakeEnvironment())
    const signal = new AbortController().signal
    await collect(replay.stream('session/control', { args: { id: 1 } }, signal, () => items('old')), 1)
    await collect(replay.stream('session/control', { args: { id: 1 } }, signal, () => items('snapshot', 'event')), 2)
    await collect(replay.stream('$events', { args: {} }, signal, () => items('ready', 'emit')), 2)
    await vi.advanceTimersByTimeAsync(1_000)

    const offline = fakeEnvironment(false)
    const restored = new OfflineReplay(store, fakeConnection(), offline)
    const cancel = new AbortController()
    const iterator = restored.stream('session/control', { args: { id: 1 } }, cancel.signal, () => items())[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: 'snapshot' })
    expect(await iterator.next()).toEqual({ done: false, value: 'event' })
    const pending = iterator.next()
    cancel.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(await collect(restored.stream('$events', { args: {} }, signal, () => items()), 1)).toEqual(['ready'])
    await expect(collect(restored.stream('session/control', { args: { id: 2 } }, signal, () => items()), 1))
      .rejects.toThrow('no offline copy exists')
    replay.dispose()
    restored.dispose()
  })

  it('neither records nor replays Session follow', async () => {
    const store = memoryStore()
    const signal = new AbortController().signal
    const replay = new OfflineReplay(store, fakeConnection(), fakeEnvironment())
    const follow = { args: { request: { address: { kind: 'session', sessionId: 's' } } } }
    await expect(collect(replay.stream('session/follow', follow, signal, () => items('snapshot', 'event')), 2))
      .resolves.toEqual(['snapshot', 'event'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.data.size).toBe(0)
    replay.dispose()

    store.data.set(`stream session/follow ${JSON.stringify(follow)}`, ['stale'])
    const restored = new OfflineReplay(store, fakeConnection(), fakeEnvironment(false))
    await expect(collect(restored.stream('session/follow', follow, signal, () => items('live')), 1))
      .rejects.toBeInstanceOf(RemoteStreamCarrierError)
    restored.dispose()
  })

  it('holds a Session follow that resumes a held window open until the Host is reachable again', async () => {
    const connection = fakeConnection()
    const environment = fakeEnvironment(false)
    environment.reachable = false
    const replay = new OfflineReplay(memoryStore(), connection, environment)
    const request = { address: { kind: 'session', sessionId: 's' }, resume: { afterSeq: 4, link: 'l' } }
    const live = vi.fn(() => items('live'))
    const iterator = replay.stream('session/follow', { args: { request } }, new AbortController().signal, live)[Symbol.asyncIterator]()
    let settled = false
    const ended = expect(iterator.next().finally(() => { settled = true })).rejects.toThrow('the Host is reachable again')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(settled).toBe(false)
    expect(live).not.toHaveBeenCalled()

    environment.reachable = true
    environment.emit(true)
    await vi.advanceTimersByTimeAsync(0)
    await ended

    const other = replay.stream('session/control', { args: { request } }, new AbortController().signal, live)[Symbol.asyncIterator]()
    await expect(other.next()).resolves.toBeDefined()
    replay.dispose()
  })

  it('publishes the replay state to subscribers when it enters and leaves', async () => {
    const connection = fakeConnection()
    const environment = fakeEnvironment()
    const replay = new OfflineReplay(memoryStore(), connection, environment)
    const seen: boolean[] = []
    const unsubscribe = replay.offline.subscribe(() => { seen.push(replay.offline.getSnapshot()) })
    expect(replay.offline.getSnapshot()).toBe(false)

    environment.emit(false)
    environment.emit(false)
    expect(replay.offline.getSnapshot()).toBe(true)
    environment.reachable = true
    environment.emit(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(replay.offline.getSnapshot()).toBe(false)
    expect(seen).toEqual([true, false])

    unsubscribe()
    environment.emit(false)
    expect(seen).toEqual([true, false])
    replay.dispose()
  })

  it('probes when a live stream fails before its opening item', async () => {
    const environment = fakeEnvironment()
    environment.reachable = false
    const replay = new OfflineReplay(memoryStore(), fakeConnection(), environment)
    await expect(collect(replay.stream('session/control', { args: {} }, new AbortController().signal,
      () => failing(new Error('socket closed'))), 1)).rejects.toThrow('socket closed')
    await vi.advanceTimersByTimeAsync(0)
    expect(replay.active).toBe(true)
    replay.dispose()
  })

  it('serves the recorded control baseline to every later opening, whatever checkpoints it names', async () => {
    const store = memoryStore()
    const signal = new AbortController().signal
    const recorder = new OfflineReplay(store, fakeConnection(), fakeEnvironment())
    const baseline = {
      type: 'baseline',
      value: { projections: { held: { asOfSeq: 3, values: { title: 'Daily' }, link: 'a'.repeat(64) } } },
    }
    await collect(recorder.stream('session/control', { args: { request: { known: [] } } }, signal, () => items(baseline)), 1)
    await vi.advanceTimersByTimeAsync(1_000)
    recorder.dispose()

    const replay = new OfflineReplay(store, fakeConnection(), fakeEnvironment(false))
    const known = [{ sessionId: 'held', asOfSeq: 3, link: 'a'.repeat(64) }]
    const replayed = await collect(
      replay.stream('session/control', { args: { request: { known } } }, signal, () => items()),
      1,
    )
    expect(replayed).toEqual([baseline])
    replay.dispose()
  })

  it('completes a reconnect baseline from the earlier record, so a fresh offline page receives every Session', async () => {
    const store = memoryStore()
    const signal = new AbortController().signal
    const recorder = new OfflineReplay(store, fakeConnection(), fakeEnvironment())
    const idle = { asOfSeq: 7, values: { sessionStats: { turns: 4 }, todos: ['a'] }, link: 'b'.repeat(64) }
    const busy = { asOfSeq: 2, values: { title: 'Busy', turnOutline: [1] }, link: 'c'.repeat(64) }
    const quiet = { asOfSeq: 1, values: { title: 'Quiet', todos: [] }, link: 'f'.repeat(64) }
    await collect(recorder.stream('session/control', { args: { request: { known: [] } } }, signal, () => items(
      { type: 'baseline', value: { projections: { idle, busy, quiet } } },
      { type: 'projection', sessionId: 'quiet', key: 'title', value: 'Quieter', seq: 2 },
      { type: 'projection', sessionId: 'busy', key: 'turnOutline', value: [1, 2], seq: 5 },
      { type: 'projection', sessionId: 'busy', key: 'title', value: 'Stale', seq: 2 },
      { type: 'projection', sessionId: 'later', key: 'todos', value: ['b'], seq: 1 },
      { type: 'projection', sessionId: 'idle', key: 'todos', value: ['stale'], seq: 6 },
      { type: 'projection', sessionId: 'later', key: 'todos', value: ['older'], seq: 0 },
    )), 7)
    await vi.advanceTimersByTimeAsync(1_000)

    const changed = { asOfSeq: 9, values: { title: 'Busy', turnOutline: [1, 2, 3] }, link: 'd'.repeat(64) }
    const known = [{ sessionId: 'idle', asOfSeq: 7, link: 'b'.repeat(64) }, { sessionId: 'busy', asOfSeq: 2, link: 'c'.repeat(64) }]
    const partial = { type: 'baseline', value: { projections: { busy: changed }, retained: ['idle'] } }
    const frame = { type: 'projection', sessionId: 'idle', key: 'todos', value: ['a', 'c'], seq: 8 }
    expect(await collect(recorder.stream('session/control', { args: { request: { known } } }, signal, () => items(partial, frame)), 2))
      .toEqual([partial, frame])
    await vi.advanceTimersByTimeAsync(1_000)
    recorder.dispose()

    const replay = new OfflineReplay(store, fakeConnection(), fakeEnvironment(false))
    const replayed = await collect(
      replay.stream('session/control', { args: { request: { known: [] } } }, signal, () => items()),
      3,
    )
    expect(replayed).toEqual([
      {
        type: 'baseline',
        value: { projections: { idle, busy: changed, quiet: { asOfSeq: 2, values: { title: 'Quieter', todos: [] } } } },
      },
      { type: 'projection', sessionId: 'later', key: 'todos', value: ['b'], seq: 1 },
      frame,
    ])
    replay.dispose()
  })

  it('keeps a Session known only from frames as frames, so a reconnect to a restarted Host does not seed it', async () => {
    const store = memoryStore()
    const signal = new AbortController().signal
    const recorder = new OfflineReplay(store, fakeConnection(), fakeEnvironment())
    const old = { asOfSeq: 3, values: { title: 'Old thread' }, link: 'a'.repeat(64) }
    const later = { type: 'projection', sessionId: 'later', key: 'todos', value: ['x'], seq: 4 }
    await collect(recorder.stream('session/control', { args: { request: { known: [] } } }, signal, () => items(
      { type: 'baseline', value: { projections: { old } } },
      later,
    )), 2)
    await vi.advanceTimersByTimeAsync(1_000)
    // A restarted Host has activated nothing, so its relative baseline lists no Session.
    const known = [{ sessionId: 'old', asOfSeq: 3, link: 'a'.repeat(64) }]
    await collect(recorder.stream('session/control', { args: { request: { known } } }, signal,
      () => items({ type: 'baseline', value: { projections: {} } })), 1)
    await vi.advanceTimersByTimeAsync(1_000)
    recorder.dispose()

    // A seeded block would replace every value the page holds for `later`, its list-cached title
    // included; a frame changes only `todos`.
    const replay = new OfflineReplay(store, fakeConnection(), fakeEnvironment(false))
    expect(await collect(replay.stream('session/control', { args: { request: { known: [] } } }, signal, () => items()), 2))
      .toEqual([{ type: 'baseline', value: { projections: { old } } }, later])
    replay.dispose()
  })

  it('folds a reconnect baseline into the stored record when this page recorded no earlier opening', async () => {
    const store = memoryStore()
    const signal = new AbortController().signal
    const key = 'stream session/control {"args":{"request":{}}}'
    const kept = { asOfSeq: 4, values: { title: 'Kept' }, link: 'e'.repeat(64) }
    store.data.set(key, [{ type: 'baseline', value: { projections: { kept, broken: 'block' } } }])
    const recorder = new OfflineReplay(store, fakeConnection(), fakeEnvironment())
    const known = [{ sessionId: 'kept', asOfSeq: 4, link: 'e'.repeat(64) }]
    const first = { type: 'baseline', value: { projections: {}, retained: ['kept'] } }
    const second = { type: 'baseline', value: { projections: { fresh: { asOfSeq: 1, values: {} } }, retained: ['kept'] } }
    await collect(recorder.stream('session/control', { args: { request: { known } } }, signal, () => items(first)), 1)
    await collect(recorder.stream('session/control', { args: { request: { known } } }, signal, () => items(second)), 1)
    recorder.dispose()
    await vi.advanceTimersByTimeAsync(0)

    expect(store.data.get(key)).toEqual([
      { type: 'baseline', value: { projections: { kept, fresh: { asOfSeq: 1, values: {} } } } },
    ])
  })

  it('keeps a reconnect opening as received when nothing earlier can complete it', async () => {
    const store = memoryStore()
    const signal = new AbortController().signal
    const key = 'stream session/control {"args":{"request":{}}}'
    const known = [{ sessionId: 'kept', asOfSeq: 4, link: 'e'.repeat(64) }]
    const recorder = new OfflineReplay(store, fakeConnection(), fakeEnvironment())
    const partial = { type: 'baseline', value: { projections: {}, retained: ['kept'] } }
    await collect(recorder.stream('session/control', { args: { request: { known } } }, signal, () => items(partial)), 1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.data.get(key)).toEqual([partial])

    store.data.set(key, [
      { type: 'baseline', value: { projections: { kept: { asOfSeq: 'x', values: 'y' } } } },
      { type: 'projection', sessionId: 'kept', key: 'title', value: 'T', seq: 0 },
      { type: 'projection', sessionId: 'kept', key: 7, value: 'ignored', seq: 1 },
    ])
    const later = new OfflineReplay(store, fakeConnection(), fakeEnvironment())
    const open = async (opening: unknown): Promise<unknown> => {
      await collect(later.stream('session/control', { args: { request: { known } } }, signal, () => items(opening)), 1)
      await vi.advanceTimersByTimeAsync(1_000)
      return store.data.get(key)
    }
    expect(await open(partial)).toEqual([
      { type: 'baseline', value: { projections: { kept: { asOfSeq: 0, values: { title: 'T' } } } } },
    ])
    expect(await open('opening')).toEqual(['opening'])
    const listed = { type: 'baseline', value: { projections: [] } }
    expect(await open(listed)).toEqual([listed])
    later.dispose()
  })

  it('ends every replayed stream as a carrier failure once the Host is reachable again', async () => {
    const store = memoryStore()
    const signal = new AbortController().signal
    const recorder = new OfflineReplay(store, fakeConnection(), fakeEnvironment())
    await collect(recorder.stream('workspace/follow', { args: {} }, signal, () => items('baseline', 'upsert')), 2)
    await vi.advanceTimersByTimeAsync(1_000)
    recorder.dispose()

    const connection = fakeConnection()
    const environment = fakeEnvironment(false)
    const replay = new OfflineReplay(store, connection, environment)
    const open = (): AsyncIterator<unknown> =>
      replay.stream('workspace/follow', { args: {} }, signal, () => items())[Symbol.asyncIterator]()
    const [waiting, drained, unread] = [open(), open(), open()]
    for (const iterator of [waiting, drained]) {
      expect(await iterator.next()).toEqual({ done: false, value: 'baseline' })
      expect(await iterator.next()).toEqual({ done: false, value: 'upsert' })
    }
    const pending = waiting.next()
    let settled = false
    const ended = expect(pending.finally(() => { settled = true })).rejects.toBeInstanceOf(RemoteStreamCarrierError)
    environment.reachable = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(replay.active).toBe(true)
    expect(settled).toBe(false)

    environment.reachable = true
    environment.emit(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(replay.active).toBe(false)
    expect(connection.held).toEqual([true, false])
    expect(connection.reconnects).toBe(2)
    await ended
    await expect(pending).rejects.toThrow('the Host is reachable again')
    await expect(drained.next()).rejects.toBeInstanceOf(RemoteStreamCarrierError)
    await expect(unread.next()).rejects.toBeInstanceOf(RemoteStreamCarrierError)
    replay.dispose()
  })

  it('returns a consumer that reopens only on carrier failure to the live Host after replay', async () => {
    let generation: ConnectionGeneration | undefined = { id: 1, host: { home: '/home/me' } }
    const listeners = new Set<() => void>()
    const publish = (next: ConnectionGeneration | undefined): void => {
      generation = next
      for (const listener of [...listeners]) listener()
    }
    const host = { baseline: 'v1', opens: 0, carriers: new Set<(error: Error) => void>() }
    const connection: OfflineReplayConnection = {
      state: { getSnapshot: () => 'connected' as const, subscribe: () => () => {} },
      generation: {
        getSnapshot: () => generation,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
      holdNetworkAvailable: () => {},
      reconnect: () => {
        const id = (generation?.id ?? 0) + 1
        publish(undefined)
        for (const fail of [...host.carriers]) fail(new RemoteStreamCarrierError('carrier replaced'))
        queueMicrotask(() => { publish({ id, host: { home: '/home/me' } }) })
      },
    }
    const follow = (signal: AbortSignal): AsyncIterable<unknown> => (async function* () {
      host.opens++
      yield host.baseline
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error): void => {
          host.carriers.delete(fail)
          reject(error)
        }
        host.carriers.add(fail)
        signal.addEventListener('abort', () => {
          host.carriers.delete(fail)
          resolve()
        }, { once: true })
      })
    })()
    const environment = fakeEnvironment()
    const replay = new OfflineReplay(memoryStore(), connection, environment)
    const stream = new RemoteStream<unknown>(connection, {
      name: 'test follow',
      open: signal => replay.stream('workspace/follow', { args: {} }, signal, () => follow(signal)),
      ended: () => new Error('test follow ended'),
    })
    const seen: unknown[] = []
    const consuming = (async () => {
      for await (const item of stream) {
        item.accept()
        seen.push(item.value)
      }
    })()
    await vi.waitFor(() => { expect(seen).toEqual(['v1']) })
    await vi.advanceTimersByTimeAsync(1_000)

    environment.emit(false)
    await vi.waitFor(() => { expect(seen).toEqual(['v1', 'v1']) })
    host.baseline = 'v2'
    environment.emit(true)
    await vi.waitFor(() => { expect(seen).toEqual(['v1', 'v1', 'v2']) })
    expect(host.opens).toBe(2)
    expect(host.carriers.size).toBe(1)

    await stream.dispose()
    await consuming
    replay.dispose()
  })
})

describe('browserReplayEnvironment', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('counts a proxy gateway failure as an unreachable Host and any other answer as reachable', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
    vi.stubGlobal('navigator', { onLine: true })
    vi.stubGlobal('fetch', fetch)
    const environment = browserReplayEnvironment('http://127.0.0.1/api/offline-probe')!
    for (const [status, reachable] of [[502, false], [503, false], [504, false], [404, true], [401, true]] as const) {
      fetch.mockResolvedValueOnce(new Response(null, { status }))
      await expect(environment.probe(new AbortController().signal)).resolves.toBe(reachable)
    }
  })
})

describe('OfflineReplay failure paths', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('probes after a slow first connection, and not once a generation exists', async () => {
    let state: 'connecting' | 'connected' = 'connecting'
    let generation: ConnectionGeneration | undefined
    let notify: (() => void) | undefined
    const connection: OfflineReplayConnection = {
      ...fakeConnection(),
      state: { getSnapshot: () => state, subscribe: (listener) => { notify = listener; return () => { notify = undefined } } },
      generation: { getSnapshot: () => generation, subscribe: () => () => {} },
    }
    const environment = fakeEnvironment()
    environment.reachable = false
    const replay = new OfflineReplay(memoryStore(), connection, environment)
    generation = { id: 1, host: { home: '/home/me' } }
    await vi.advanceTimersByTimeAsync(3_000)
    expect(replay.active).toBe(false)

    generation = undefined
    notify?.()
    await vi.advanceTimersByTimeAsync(2_999)
    expect(replay.active).toBe(false)
    state = 'connected'
    notify?.()
    state = 'connecting'
    notify?.()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(replay.active).toBe(true)
    replay.dispose()
    expect(notify).toBeUndefined()
  })

  it('rethrows live failures it cannot answer from the record', async () => {
    const replay = new OfflineReplay(memoryStore(), fakeConnection(), fakeEnvironment())
    const cancelled = new AbortController()
    cancelled.abort()
    const offline = new TypeError('fetch failed')
    await expect(replay.call('session/list', {}, () => Promise.reject(offline), cancelled.signal)).rejects.toBe(offline)
    const live = new AbortController().signal
    await expect(replay.call('session/list', {}, () => Promise.reject(offline), live)).rejects.toBe(offline)
    await expect(replay.call('session/send', {}, () => Promise.reject(offline), live)).rejects.toBe(offline)
    const remote = new Error('remote failed')
    await expect(replay.call('session/list', {}, () => Promise.reject(remote), live)).rejects.toBe(remote)
    replay.dispose()
    await expect(replay.call('session/list', {}, () => Promise.reject(remote), live)).rejects.toBe(remote)
  })

  it('stops a stream log at its item limit', async () => {
    const store = memoryStore()
    const replay = new OfflineReplay(store, fakeConnection(), fakeEnvironment())
    const values = Array.from({ length: 20_001 }, (_, index) => index)
    await collect(replay.stream('job/list', { args: {} }, new AbortController().signal, () => items(...values)), values.length)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.data.get('stream job/list {"args":{}}')).toHaveLength(20_000)
    replay.dispose()
  })

  it('shares one probe, treats a failed probe as unreachable, and does nothing once disposed', async () => {
    let settle: ((reachable: boolean) => void) | undefined
    let fail: ((error: Error) => void) | undefined
    const probe = vi.fn(() => new Promise<boolean>((resolve, reject) => { settle = resolve; fail = reject }))
    const environment = { ...fakeEnvironment(false), probe }
    const replay = new OfflineReplay(memoryStore(), fakeConnection(), environment)
    expect(replay.active).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    environment.emit(true)
    expect(probe).toHaveBeenCalledTimes(1)
    fail?.(new Error('network down'))
    await vi.advanceTimersByTimeAsync(0)
    expect(replay.active).toBe(true)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(probe).toHaveBeenCalledTimes(2)
    replay.dispose()
    settle?.(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(replay.active).toBe(true)
  })

  it('treats records it cannot read as absent and reports writes it cannot store', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store: OfflineReplayStore = {
      get: () => Promise.reject(new Error('read refused')),
      put: () => Promise.reject(new Error('write refused')),
    }
    const replay = new OfflineReplay(store, fakeConnection(), fakeEnvironment())
    const signal = new AbortController().signal
    await expect(replay.call('session/list', {}, () => Promise.resolve(ok([])), signal)).resolves.toEqual(ok([]))
    await vi.advanceTimersByTimeAsync(0)
    await expect(replay.call('session/list', {}, () => Promise.reject(new TypeError('fetch failed')), signal))
      .rejects.toThrow('fetch failed')
    expect(warn).toHaveBeenCalledWith('[offline-replay] write failed:', new Error('write refused'))
    expect(warn).toHaveBeenCalledWith('[offline-replay] read failed:', new Error('read refused'))
    replay.dispose()
    warn.mockRestore()
  })

  it('reports the browser network state and its transitions', () => {
    expect(browserReplayEnvironment('http://127.0.0.1/api/offline-probe')).toBeUndefined()
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    vi.stubGlobal('navigator', { onLine: false })
    try {
      const environment = browserReplayEnvironment('http://127.0.0.1/api/offline-probe')!
      expect(environment.online()).toBe(false)
      const seen: boolean[] = []
      const unwatch = environment.watch((online) => { seen.push(online) })
      target.dispatchEvent(new Event('online'))
      target.dispatchEvent(new Event('offline'))
      unwatch()
      target.dispatchEvent(new Event('online'))
      expect(seen).toEqual([true, false])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

const DATABASE = 'dsh-offline-replay'

/**
 * Open the record database directly, as another page or an earlier build would.
 * @param factory - the IndexedDB factory the store under test also uses.
 * @param version - version to open, or undefined for the current one.
 * @param upgrade - runs in an upgrade; omitted, an upgrade creates no object store.
 * @returns the open connection, which the caller closes.
 */
function openDirectly(factory: IDBFactory, version?: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? factory.open(DATABASE) : factory.open(DATABASE, version)
    request.onupgradeneeded = () => { upgrade?.(request.result) }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('record database open failed')) }
  })
}

/** Leave a version-1 record database with no object store, the state some browser profiles hold. */
async function leaveStorelessDatabase(factory: IDBFactory): Promise<void> {
  const db = await openDirectly(factory, 1)
  expect([...db.objectStoreNames]).toEqual([])
  db.close()
}

describe('openIndexedDbReplayStore', () => {
  let factory: IDBFactory
  let warn: MockInstance<typeof console.warn>

  beforeEach(() => {
    factory = new IDBFactory()
    vi.stubGlobal('indexedDB', factory)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('is absent without IndexedDB, and stores and reads records', async () => {
    vi.stubGlobal('indexedDB', undefined)
    expect(openIndexedDbReplayStore()).toBeUndefined()
    vi.stubGlobal('indexedDB', factory)
    const store = openIndexedDbReplayStore()!
    await expect(store.get('k')).resolves.toBeUndefined()
    await store.put('k', { value: 1 })
    await expect(store.get('k')).resolves.toEqual({ value: 1 })
    expect(warn).not.toHaveBeenCalled()
  })

  it('adds the object store to a version-1 database left without it, once, and keeps what it then stores', async () => {
    await leaveStorelessDatabase(factory)
    const store = openIndexedDbReplayStore()!
    await store.put('k', { value: 1 })
    await store.put('j', { value: 2 })
    await expect(store.get('k')).resolves.toEqual({ value: 1 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[offline-replay] the record database has no "records" object store and so holds no records; adding the store')

    // The next page load reads what this one stored, without repairing again.
    const reloaded = openIndexedDbReplayStore()!
    await expect(reloaded.get('j')).resolves.toEqual({ value: 2 })
    expect(warn).toHaveBeenCalledTimes(1)
    const db = await openDirectly(factory)
    expect(db.version).toBe(2)
    expect([...db.objectStoreNames]).toEqual(['records'])
    db.close()
  })

  it('reports a repair that another page blocks once, keeps no records for the rest of the page, and repairs on the next load', async () => {
    await leaveStorelessDatabase(factory)
    // An earlier build's page holds the database open and never answers a version change.
    const holder = await openDirectly(factory)
    const store = openIndexedDbReplayStore()!
    await expect(store.put('k', 1)).resolves.toBeUndefined()
    await expect(store.get('k')).resolves.toBeUndefined()
    await store.put('j', 2)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenLastCalledWith(
      '[offline-replay] the record database cannot be repaired; this page keeps no offline records until it reloads:',
      new Error('offline replay: another page keeps the record database open at its older version'),
    )

    // The blocked upgrade completes once the holder closes; the store closes that late connection.
    holder.close()
    const reloaded = openIndexedDbReplayStore()!
    await reloaded.put('k', 3)
    await expect(reloaded.get('k')).resolves.toBe(3)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('reports an upgrade that leaves the store missing, and a store that goes missing again after the repair', async () => {
    await leaveStorelessDatabase(factory)
    const open = factory.open.bind(factory)
    // The repair's upgrade answers with the unchanged database.
    vi.spyOn(factory, 'open').mockImplementationOnce(name => open(name)).mockImplementationOnce(name => open(name, 1))
    await expect(openIndexedDbReplayStore()!.get('k')).resolves.toBeUndefined()
    expect(warn).toHaveBeenLastCalledWith(
      '[offline-replay] the record database cannot be repaired; this page keeps no offline records until it reloads:',
      new Error('offline replay: the record object store is still missing after the upgrade'),
    )

    warn.mockClear()
    const store = openIndexedDbReplayStore()!
    await store.put('k', 1)
    // Another page deletes the database and leaves it without the store again.
    await new Promise<void>((resolve) => { factory.deleteDatabase(DATABASE).onsuccess = () => { resolve() } })
    await leaveStorelessDatabase(factory)
    await expect(store.get('k')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenLastCalledWith(
      '[offline-replay] the record database cannot be repaired; this page keeps no offline records until it reloads:',
      new Error('offline replay: the record object store is missing again after this page added it'),
    )
  })

  it('reopens after the browser closes the connection, and retries an open that failed', async () => {
    const open = factory.open.bind(factory)
    const opens = vi.spyOn(factory, 'open')
    const store = openIndexedDbReplayStore()!
    await store.put('k', 1)
    const first = opens.mock.results[0]!.value as { readonly result: IDBDatabase }
    // An abnormal closure: the connection is closed, then the browser fires `close`.
    first.result.close()
    first.result.onclose?.call(first.result, new Event('close'))
    await expect(store.get('k')).resolves.toBe(1)

    // A close the event has not reported yet fails the transaction; the store reopens once.
    const second = opens.mock.results[1]!.value as { readonly result: IDBDatabase }
    second.result.close()
    await expect(store.get('k')).resolves.toBe(1)
    expect(opens).toHaveBeenCalledTimes(3)
    // Its close event, arriving late, leaves the replacement connection in place.
    second.result.onclose?.call(second.result, new Event('close'))
    await expect(store.get('k')).resolves.toBe(1)
    expect(opens).toHaveBeenCalledTimes(3)

    const third = opens.mock.results[2]!.value as { readonly result: IDBDatabase }
    third.result.close()
    const upgraded = await openDirectly(factory, 2)
    upgraded.close()
    opens.mockImplementationOnce(name => open(name, 1)).mockImplementationOnce(name => open(name, 1))
    await expect(store.get('k')).rejects.toMatchObject({ name: 'VersionError' })
    await expect(store.get('k')).rejects.toMatchObject({ name: 'VersionError' })
    await expect(store.get('k')).resolves.toBe(1)
  })

  it('gives way to another page\'s upgrade, then reads the upgraded database', async () => {
    const store = openIndexedDbReplayStore()!
    await store.put('k', 1)
    const upgraded = await openDirectly(factory, 2, (db) => { db.createObjectStore('other') })
    upgraded.close()
    await expect(store.get('k')).resolves.toBe(1)
  })

  it('fails a request the database refuses, and a transaction that fails again after reopening', async () => {
    const store = openIndexedDbReplayStore()!
    await store.put('k', 1)
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore, value, key) {
      return this.add(value, key)
    })
    await expect(store.put('k', 2)).rejects.toMatchObject({ name: 'ConstraintError' })
    await expect(store.put('k', () => {})).rejects.toMatchObject({ name: 'DataCloneError' })
    const closed = new DOMException('The connection is closing.', 'InvalidStateError')
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => { throw closed })
    await expect(store.get('k')).rejects.toBe(closed)
  })
})

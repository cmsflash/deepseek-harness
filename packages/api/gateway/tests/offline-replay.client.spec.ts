import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionGeneration, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import {
  browserReplayEnvironment,
  OfflineReplay,
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
    await collect(replay.stream('session/follow', { args: { id: 1 } }, signal, () => items('old')), 1)
    await collect(replay.stream('session/follow', { args: { id: 1 } }, signal, () => items('snapshot', 'event')), 2)
    await collect(replay.stream('$events', { args: {} }, signal, () => items('ready', 'emit')), 2)
    await vi.advanceTimersByTimeAsync(1_000)

    const offline = fakeEnvironment(false)
    const restored = new OfflineReplay(store, fakeConnection(), offline)
    const cancel = new AbortController()
    const iterator = restored.stream('session/follow', { args: { id: 1 } }, cancel.signal, () => items())[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: 'snapshot' })
    expect(await iterator.next()).toEqual({ done: false, value: 'event' })
    const pending = iterator.next()
    cancel.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(await collect(restored.stream('$events', { args: {} }, signal, () => items()), 1)).toEqual(['ready'])
    await expect(collect(restored.stream('session/follow', { args: { id: 2 } }, signal, () => items()), 1))
      .rejects.toThrow('no offline copy exists')
    replay.dispose()
    restored.dispose()
  })

  it('folds a resumed Session follow into its recorded snapshot under the key without the resume point', async () => {
    const store = memoryStore()
    const replay = new OfflineReplay(store, fakeConnection(), fakeEnvironment())
    const signal = new AbortController().signal
    const record = (seq: number) => ({ type: 'event', event: { seq } })
    const request = { address: { kind: 'session', sessionId: 's' } }
    const snapshot = {
      type: 'snapshot', header: { version: 4 }, cursor: 1, records: [record(0), record(1)], hasMore: true,
      projections: { asOfSeq: 1 }, assistantStream: { revision: 0 },
    }
    await collect(replay.stream('session/follow', { args: { request } }, signal,
      () => items(snapshot, record(2), { type: 'assistant-stream', frame: { revision: 1 } })), 3)
    await vi.advanceTimersByTimeAsync(1_000)
    const resumed = {
      type: 'resumed', header: { version: 4 }, after: 2, cursor: 3, records: [record(3)],
      projections: { asOfSeq: 3 }, assistantStream: { revision: 7 },
    }
    await collect(replay.stream('session/follow', { args: { request: { ...request, resume: { afterSeq: 2 } } } }, signal,
      () => items(resumed, record(4))), 2)
    await vi.advanceTimersByTimeAsync(1_000)

    expect([...store.data.entries()]).toEqual([[
      'stream session/follow {"args":{"request":{"address":{"kind":"session","sessionId":"s"}}}}',
      [
        {
          type: 'snapshot', header: { version: 4 }, cursor: 3, records: [record(0), record(1), record(2), record(3)],
          hasMore: true, projections: { asOfSeq: 3 }, assistantStream: { revision: 7 },
        },
        record(4),
      ],
    ]])
    replay.dispose()
  })

  it('keeps the recorded Session follow when a resumed opening does not continue it', async () => {
    const store = memoryStore()
    const replay = new OfflineReplay(store, fakeConnection(), fakeEnvironment())
    const signal = new AbortController().signal
    const record = (seq: number) => ({ type: 'event', event: { seq } })
    const snapshot = { type: 'snapshot', cursor: 1, records: [record(0), record(1)] }
    await collect(replay.stream('session/follow', { args: { request: {} } }, signal, () => items(snapshot)), 1)
    const resumed = { type: 'resumed', after: 5, cursor: 6, records: [record(6)] }
    await collect(replay.stream('session/follow', { args: { request: { resume: {} } } }, signal,
      () => items(resumed, record(7))), 2)
    await vi.advanceTimersByTimeAsync(1_000)

    expect([...store.data.values()]).toEqual([[snapshot]])
    replay.dispose()
  })

  it('continues the persisted Session follow record when this page has no log of it', async () => {
    const store = memoryStore()
    const record = (seq: number) => ({ type: 'event', event: { seq } })
    const key = 'stream session/follow {"args":{"request":{}}}'
    store.data.set(key, [{ type: 'snapshot', cursor: 0, records: [record(0)] }, record(1)])
    const replay = new OfflineReplay(store, fakeConnection(), fakeEnvironment())
    const signal = new AbortController().signal

    await collect(replay.stream('session/follow', { args: { request: { resume: {} } } }, signal,
      () => items({ type: 'resumed', after: 1, cursor: 2, records: [record(2)] })), 1)
    await collect(replay.stream('session/follow', { args: { request: { other: true, resume: {} } } }, signal,
      () => items({ type: 'resumed', after: 3, cursor: 4, records: [record(4)] })), 1)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(store.data.get(key)).toEqual([{ type: 'snapshot', cursor: 2, records: [record(0), record(1), record(2)] }])
    expect(store.data.size).toBe(1)
    replay.dispose()
  })

  it('stops recording a Session follow whose folded window would pass the log limit', async () => {
    const store = memoryStore()
    const record = (seq: number) => ({ type: 'event', event: { seq } })
    const records = Array.from({ length: 20_000 }, (_, seq) => record(seq))
    const snapshot = { type: 'snapshot', cursor: 19_999, records }
    const replay = new OfflineReplay(store, fakeConnection(), fakeEnvironment())
    const signal = new AbortController().signal
    await collect(replay.stream('session/follow', { args: { request: {} } }, signal, () => items(snapshot)), 1)

    await collect(replay.stream('session/follow', { args: { request: { resume: {} } } }, signal,
      () => items({ type: 'resumed', after: 19_999, cursor: 20_000, records: [record(20_000)] }, record(20_001))), 2)
    await vi.advanceTimersByTimeAsync(1_000)

    expect([...store.data.values()]).toEqual([[snapshot]])
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

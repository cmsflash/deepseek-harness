/**
 * Offline replay for a browser page: while the Host is reachable, successful
 * read responses and selected stream logs are persisted in browser storage;
 * while it is not, the same calls are answered from that record so the page can
 * show what it last saw. Calls without a record fail as carrier failures.
 */

import type { ConnectionHandle, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { RemoteStreamCarrierError } from './stream-client.ts'

/** Persistence for replay records; values are structured-clone data. */
export interface OfflineReplayStore {
  /**
   * @param key - record key.
   * @returns the stored value, or undefined when absent.
   */
  get(key: string): Promise<unknown>
  /**
   * @param key - record key.
   * @param value - structured-clone value replacing the record.
   */
  put(key: string, value: unknown): Promise<void>
}

/** Whether a stream records only its opening item or its complete item log since that opening. */
type StreamRecording = 'opening' | 'log'

/**
 * Unary endpoints whose successful results are recorded and replayed. Only
 * reads belong here: replaying a mutation would report an effect that did not happen.
 */
const REPLAYED_CALLS: ReadonlySet<string> = new Set([
  'agentPresets/list',
  'commands/list',
  'credentials/describe',
  'dynamicCordisRunner/inventory',
  'dynamicCordisRunner/syncInspectManifest',
  'llm/listConfigurableProviders',
  'llm/listProviders',
  'messageFeedback/list',
  'permissionPresets/catalog',
  'schedule/catalog',
  'schedule/list',
  'session/events',
  'session/expandSteps',
  'session/list',
  'session/modelCatalog',
  'session/page',
  'session/projections',
  'settings/describe',
  'skills/list',
])

/**
 * Streams replayed offline. The forwarded-event stream replays only its ready
 * item: its later frames are deliveries and requests that must not run twice.
 */
const REPLAYED_STREAMS: ReadonlyMap<string, StreamRecording> = new Map([
  ['$events', 'opening'],
  ['job/list', 'log'],
  ['session/control', 'log'],
  ['session/follow', 'log'],
  ['workspace/follow', 'log'],
])

/** Upper bound on one stream log; later items of the same opening are not recorded. */
const STREAM_LOG_LIMIT = 20_000
const STREAM_PERSIST_DELAY_MS = 1_000
const PROBE_TIMEOUT_MS = 4_000
const PROBE_INTERVAL_MS = 5_000
const SLOW_CONNECT_MS = 3_000

/** Connection controls the replay drives. */
export type OfflineReplayConnection = Pick<ConnectionHandle, 'state' | 'generation' | 'holdNetworkAvailable' | 'reconnect'>

/** Network operations the replay needs from the page. */
export interface OfflineReplayEnvironment {
  /** Resolve true when the Host answers any HTTP response, false when it is unreachable. */
  probe(signal: AbortSignal): Promise<boolean>
  /** Current browser network report. */
  online(): boolean
  /**
   * Subscribe to browser network transitions.
   * @returns the unsubscriber.
   */
  watch(listener: (online: boolean) => void): () => void
}

/** Records Host reads and answers them while the Host is unreachable. */
export class OfflineReplay {
  /** Present while calls are answered from the record; aborting it ends every stream served from the record. */
  private episode: AbortController | undefined
  private disposed = false
  private probing: Promise<void> | undefined
  private probeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly logs = new Map<string, { items: unknown[]; timer: ReturnType<typeof setTimeout> | undefined }>()
  private readonly stopWatching: () => void
  private readonly stopObservingState: () => void

  /**
   * @param store - persistence for records.
   * @param connection - Connection whose generation loop is redirected while replaying.
   * @param environment - Host reachability and browser network signals.
   */
  constructor(
    private readonly store: OfflineReplayStore,
    private readonly connection: OfflineReplayConnection,
    private readonly environment: OfflineReplayEnvironment,
  ) {
    this.stopWatching = environment.watch((online) => {
      if (online) this.check()
      else this.enter()
    })
    let slow: ReturnType<typeof setTimeout> | undefined
    const observe = (): void => {
      clearTimeout(slow)
      if (connection.state.getSnapshot() === 'connected') return
      slow = setTimeout(() => {
        if (connection.generation.getSnapshot() === undefined) this.check()
      }, SLOW_CONNECT_MS)
    }
    const unsubscribe = connection.state.subscribe(observe)
    observe()
    this.stopObservingState = () => {
      clearTimeout(slow)
      unsubscribe()
    }
    if (!environment.online()) this.enter()
  }

  /** Whether calls are currently answered from the record. */
  get active(): boolean {
    return this.episode !== undefined
  }

  /**
   * Run one unary call live, or answer it from the record while replaying.
   * @param endpoint - Remote endpoint.
   * @param args - wire arguments; part of the record key.
   * @param live - the network call.
   * @param signal - caller cancellation.
   * @returns the live or recorded result.
   */
  async call(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    live: () => Promise<ConnectionRpcResult<unknown>>,
    signal: AbortSignal,
  ): Promise<ConnectionRpcResult<unknown>> {
    const recorded = REPLAYED_CALLS.has(endpoint)
    if (this.episode !== undefined) {
      const value = recorded ? await this.read(callKey(endpoint, args)) : undefined
      if (value === undefined) throw new Error('the Host is unreachable')
      return value as ConnectionRpcResult<unknown>
    }
    let result: ConnectionRpcResult<unknown>
    try {
      result = await live()
    } catch (error) {
      if (signal.aborted) throw error
      this.check()
      // fetch rejects with TypeError when the request never reached the Host; calls
      // made before the probe settles (during the first page load) still get the record.
      const value = recorded && error instanceof TypeError ? await this.read(callKey(endpoint, args)) : undefined
      if (value === undefined) throw error
      return value as ConnectionRpcResult<unknown>
    }
    if (recorded && result.ok) this.write(callKey(endpoint, args), result)
    return result
  }

  /**
   * Open one stream live, recording it, or replay its record while replaying.
   * @param endpoint - Remote endpoint.
   * @param payload - wire payload; part of the record key.
   * @param signal - stream cancellation.
   * @param live - the network stream opener.
   * @returns the live or replayed item sequence. A replayed sequence fails as a carrier failure
   * once the Host is reachable again, so its consumer reopens it on the live Host.
   */
  stream(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    live: () => AsyncIterable<unknown>,
  ): AsyncIterable<unknown> {
    const recording = REPLAYED_STREAMS.get(endpoint)
    const episode = this.episode
    if (episode !== undefined) return this.replay(recording, streamKey(endpoint, payload), signal, episode.signal)
    return this.record(recording, streamKey(endpoint, payload), signal, live())
  }

  /** Stop probing and flush pending stream logs. */
  dispose(): void {
    this.disposed = true
    this.stopWatching()
    this.stopObservingState()
    clearTimeout(this.probeTimer)
    for (const [key, log] of this.logs) {
      if (log.timer === undefined) continue
      clearTimeout(log.timer)
      this.write(key, log.items)
    }
    this.logs.clear()
  }

  private async * replay(
    recording: StreamRecording | undefined,
    key: string,
    signal: AbortSignal,
    episode: AbortSignal,
  ): AsyncIterable<unknown> {
    const items = recording === undefined ? undefined : await this.read(key)
    if (!Array.isArray(items)) throw new RemoteStreamCarrierError('the Host is unreachable and no offline copy exists')
    for (const item of items) {
      episode.throwIfAborted()
      yield item
    }
    const ended = AbortSignal.any([signal, episode])
    if (!ended.aborted) await new Promise<void>((resolve) => { ended.addEventListener('abort', () => { resolve() }, { once: true }) })
    if (!signal.aborted) episode.throwIfAborted()
  }

  private async * record(
    recording: StreamRecording | undefined,
    key: string,
    signal: AbortSignal,
    source: AsyncIterable<unknown>,
  ): AsyncIterable<unknown> {
    let opened = false
    try {
      for await (const item of source) {
        if (!opened) {
          opened = true
          if (recording !== undefined) this.restartLog(key, item)
        } else if (recording === 'log') {
          this.appendLog(key, item)
        }
        yield item
      }
    } catch (error) {
      if (!opened && !signal.aborted) this.check()
      throw error
    }
  }

  private restartLog(key: string, item: unknown): void {
    const previous = this.logs.get(key)
    clearTimeout(previous?.timer)
    this.logs.set(key, { items: [item], timer: undefined })
    this.schedulePersist(key)
  }

  private appendLog(key: string, item: unknown): void {
    const log = this.logs.get(key)
    if (log === undefined || log.items.length >= STREAM_LOG_LIMIT) return
    log.items.push(item)
    this.schedulePersist(key)
  }

  private schedulePersist(key: string): void {
    const log = this.logs.get(key)
    if (log === undefined || log.timer !== undefined) return
    log.timer = setTimeout(() => {
      log.timer = undefined
      this.write(key, log.items)
    }, STREAM_PERSIST_DELAY_MS)
  }

  /** Replay while the Host is unreachable; the next generation attempt opens the recorded one. */
  private enter(): void {
    if (this.episode !== undefined || this.disposed) return
    this.episode = new AbortController()
    console.warn('[offline-replay] Host unreachable; showing recorded data')
    this.connection.holdNetworkAvailable(true)
    this.connection.reconnect()
    this.scheduleProbe()
  }

  /** Return to the live Host; the reconnect replaces the recorded generation, and streams served from the record end. */
  private leave(): void {
    const episode = this.episode
    if (episode === undefined || this.disposed) return
    this.episode = undefined
    clearTimeout(this.probeTimer)
    console.warn('[offline-replay] Host reachable; reconnecting')
    this.connection.holdNetworkAvailable(false)
    this.connection.reconnect()
    episode.abort(new RemoteStreamCarrierError('the Host is reachable again'))
  }

  private scheduleProbe(): void {
    clearTimeout(this.probeTimer)
    this.probeTimer = setTimeout(() => { this.check() }, PROBE_INTERVAL_MS)
  }

  /** Probe the Host once; enter or leave replay by the outcome. Concurrent requests share one probe. */
  private check(): void {
    if (this.disposed || this.probing !== undefined) return
    this.probing = this.environment.probe(AbortSignal.timeout(PROBE_TIMEOUT_MS))
      .catch((_unreachable: unknown) => false)
      .then((reachable) => {
        this.probing = undefined
        if (reachable) this.leave()
        else if (this.episode !== undefined) this.scheduleProbe()
        else this.enter()
      })
  }

  private async read(key: string): Promise<unknown> {
    try {
      return await this.store.get(key)
    } catch (error) {
      console.warn('[offline-replay] read failed:', error)
      return undefined
    }
  }

  private write(key: string, value: unknown): void {
    this.store.put(key, value).catch((error: unknown) => {
      console.warn('[offline-replay] write failed:', error)
    })
  }
}

function callKey(endpoint: string, args: unknown): string {
  return `call ${endpoint} ${stableJson(args)}`
}

function streamKey(endpoint: string, payload: unknown): string {
  return `stream ${endpoint} ${stableJson(payload)}`
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) => {
    if (typeof field !== 'object' || field === null || Array.isArray(field)) return field
    return Object.fromEntries(Object.entries(field).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
  })
}

const DATABASE = 'dsh-offline-replay'
const OBJECT_STORE = 'records'

/**
 * Open the page's IndexedDB record store, one database per origin.
 * @returns the store, or undefined when IndexedDB is unavailable.
 */
export function openIndexedDbReplayStore(): OfflineReplayStore | undefined {
  if (typeof indexedDB === 'undefined') return undefined
  let database: Promise<IDBDatabase> | undefined
  const open = (): Promise<IDBDatabase> => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => { request.result.createObjectStore(OBJECT_STORE) }
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => {
        database = undefined
        reject(request.error ?? new Error('offline replay: IndexedDB open failed'))
      }
    })
    return database
  }
  const run = async <T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open()
    return new Promise<T>((resolve, reject) => {
      const request = operation(db.transaction(OBJECT_STORE, mode).objectStore(OBJECT_STORE))
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(request.error ?? new Error('offline replay: IndexedDB request failed')) }
    })
  }
  return {
    get: key => run('readonly', store => store.get(key)),
    put: async (key, value) => { await run('readwrite', store => store.put(value, key)) },
  }
}

/** Statuses a proxy in front of a stopped Host answers with instead of failing the request. */
const GATEWAY_FAILURE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])

/**
 * Browser reachability signals for {@link OfflineReplay}.
 * @param probeUrl - Host URL answered with any HTTP status while the Host runs;
 * a 502, 503 or 504 answer counts as an unreachable Host.
 * @returns the environment, or undefined outside a browser window.
 */
export function browserReplayEnvironment(probeUrl: string): OfflineReplayEnvironment | undefined {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return undefined
  return {
    probe: async (signal) => {
      // POST bypasses the page's service worker, which answers GETs from its cache.
      const response = await fetch(probeUrl, { method: 'POST', cache: 'no-store', signal })
      return !GATEWAY_FAILURE_STATUSES.has(response.status)
    },
    online: () => navigator.onLine,
    watch: (listener) => {
      const online = (): void => { listener(true) }
      const offline = (): void => { listener(false) }
      window.addEventListener('online', online)
      window.addEventListener('offline', offline)
      return () => {
        window.removeEventListener('online', online)
        window.removeEventListener('offline', offline)
      }
    },
  }
}

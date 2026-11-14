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

/**
 * Whether a stream records only its opening item or its complete item log since
 * that opening (see {@link REPLAYED_STREAMS}).
 */
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
 * Session follow is not recorded: the browser's local thread copy serves held
 * transcripts. While replaying, a follow that offers a resume point stays open
 * without items, so its Session keeps the window it holds until the Host is
 * back; a follow without one fails as a carrier failure, so a thread with
 * nothing to show reports it.
 */
const REPLAYED_STREAMS: ReadonlyMap<string, StreamRecording> = new Map([
  ['$events', 'opening'],
  ['job/list', 'log'],
  ['session/control', 'log'],
  ['workspace/follow', 'log'],
])

/** Upper bound on one stream log; later items of the same opening are not recorded. */
const STREAM_LOG_LIMIT = 20_000
const STREAM_PERSIST_DELAY_MS = 1_000
/** One stream's items since its latest opening, with its pending persistence and fold. */
interface StreamLog {
  readonly items: unknown[]
  timer: ReturnType<typeof setTimeout> | undefined
  /** Settles once the opening item holds the earlier record's folded blocks. */
  folding: Promise<void> | undefined
}

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

/** Observable boolean: `getSnapshot` is stable until the value changes. */
export interface OfflineReplayObservable {
  getSnapshot(): boolean
  /**
   * @param listener - called after each change of the snapshot.
   * @returns the unsubscriber.
   */
  subscribe(listener: () => void): () => void
}

/** Records Host reads and answers them while the Host is unreachable. */
export class OfflineReplay {
  /** Present while calls are answered from the record; aborting it ends every stream served from the record. */
  private episode: AbortController | undefined
  private disposed = false
  private probing: Promise<void> | undefined
  private probeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly listeners = new Set<() => void>()
  private readonly logs = new Map<string, StreamLog>()
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

  /** Observable form of {@link OfflineReplay.active}; the object keeps its identity and notifies on `enter` and `leave`. */
  readonly offline: OfflineReplayObservable = {
    getSnapshot: () => this.active,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
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
    const key = streamKey(endpoint, payload)
    const episode = this.episode
    if (episode !== undefined) return this.replay(recording, key, resumesHeldWindow(endpoint, payload), signal, episode.signal)
    return this.record(recording, key, signal, live(), endpoint === 'session/control' && namesKnown(payload))
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
      this.persist(key, log)
    }
    this.logs.clear()
  }

  private async * replay(
    recording: StreamRecording | undefined,
    key: string,
    held: boolean,
    signal: AbortSignal,
    episode: AbortSignal,
  ): AsyncIterable<unknown> {
    const recorded = recording === undefined ? undefined : await this.read(key)
    if (!Array.isArray(recorded) && !held) {
      throw new RemoteStreamCarrierError('the Host is unreachable and no offline copy exists')
    }
    for (const item of Array.isArray(recorded) ? recorded : []) {
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
    relative: boolean,
  ): AsyncIterable<unknown> {
    let opened = false
    try {
      for await (const item of source) {
        if (!opened) {
          opened = true
          if (recording !== undefined) this.restartLog(key, item, relative)
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

  /**
   * Start a new log with an opening item.
   * @param key - record key.
   * @param item - the opening item.
   * @param relative - whether the opening is a control baseline that restates only
   *   what changed since the checkpoints its request named; the earlier record is
   *   folded into it (see {@link foldControlBaseline}) so the record still describes
   *   every Session.
   */
  private restartLog(key: string, item: unknown, relative: boolean): void {
    const previous = this.logs.get(key)
    clearTimeout(previous?.timer)
    const log: StreamLog = { items: [item], timer: undefined, folding: undefined }
    if (relative) {
      const earlier = previous === undefined
        ? this.read(key).then((stored): readonly unknown[] => Array.isArray(stored) ? stored as readonly unknown[] : [])
        : (previous.folding ?? Promise.resolve()).then(() => previous.items)
      log.folding = earlier.then((items) => { log.items.splice(0, 1, ...foldControlBaseline(items, item)) })
    }
    this.logs.set(key, log)
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
      this.persist(key, log)
    }, STREAM_PERSIST_DELAY_MS)
  }

  private persist(key: string, log: StreamLog): void {
    if (log.folding === undefined) this.write(key, log.items)
    else void log.folding.then(() => { this.write(key, log.items) })
  }

  /** Replay while the Host is unreachable; the next generation attempt opens the recorded one. */
  private enter(): void {
    if (this.episode !== undefined || this.disposed) return
    this.episode = new AbortController()
    console.warn('[offline-replay] Host unreachable; showing recorded data')
    this.notify()
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
    this.notify()
    this.connection.holdNetworkAvailable(false)
    this.connection.reconnect()
    episode.abort(new RemoteStreamCarrierError('the Host is reachable again'))
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
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
  return `stream ${endpoint} ${stableJson(endpoint === 'session/control' ? withoutKnown(payload) : payload)}`
}

/**
 * Drop the checkpoints a control opening names: they change with every
 * generation, while the recorded baseline answers any of them.
 * @param payload - wire payload of one stream opening.
 * @returns the payload as recorded, or the payload itself when it carries no checkpoints.
 */
function withoutKnown(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.args) || !isRecord(payload.args.request)) return payload
  const request = Object.fromEntries(
    Object.entries(payload.args.request).filter(([key]) => key !== 'known'),
  )
  return { ...payload, args: { ...payload.args, request } }
}

/**
 * @param payload - wire payload of one control opening.
 * @returns whether the opening names checkpoints, so its baseline omits the Sessions they cover.
 */
function namesKnown(payload: unknown): boolean {
  if (!isRecord(payload) || !isRecord(payload.args) || !isRecord(payload.args.request)) return false
  const known = payload.args.request.known
  return Array.isArray(known) && known.length > 0
}

/**
 * Complete a relative control baseline from the earlier record. A Session with
 * a block in the earlier baseline gets that block, updated by the record's
 * later projection frames; a block a frame changed loses its link, so a page
 * seeded from it cannot claim the Host's checkpoint for values the Host never
 * sent as one block. A Session known only from frames keeps its newest frame per
 * key after the baseline: a block would replace every value the page holds for
 * it, including list-cached ones, while a frame changes only its key. The new
 * baseline's own blocks replace both.
 * @param earlier - the earlier record's items, opening first.
 * @param opening - the new opening item.
 * @returns the items that replace the opening: a complete baseline followed by
 *   the carried frames, or the opening alone when it is not a baseline or
 *   nothing earlier completes it.
 */
function foldControlBaseline(earlier: readonly unknown[], opening: unknown): unknown[] {
  if (!isBaselineFrame(opening) || !isRecord(opening.value.projections)) return [opening]
  const restated = opening.value.projections
  const blocks = new Map<string, Readonly<Record<string, unknown>>>()
  const frames = new Map<string, ProjectionFrame>()
  for (const item of earlier) {
    if (isBaselineFrame(item) && isRecord(item.value.projections)) {
      for (const [sessionId, block] of Object.entries(item.value.projections)) {
        if (isRecord(block)) blocks.set(sessionId, block)
      }
    } else if (isProjectionFrame(item) && !Object.hasOwn(restated, item.sessionId)) {
      const block = blocks.get(item.sessionId)
      if (block === undefined) {
        const key = JSON.stringify([item.sessionId, item.key])
        if (item.seq > (frames.get(key)?.seq ?? -1)) frames.set(key, item)
        continue
      }
      const asOfSeq = typeof block.asOfSeq === 'number' ? block.asOfSeq : -1
      if (item.seq <= asOfSeq) continue
      const values = isRecord(block.values) ? block.values : {}
      blocks.set(item.sessionId, { asOfSeq: item.seq, values: { ...values, [item.key]: item.value } })
    }
  }
  if (blocks.size === 0 && frames.size === 0) return [opening]
  const { retained: _covered, ...value } = opening.value
  return [
    { ...opening, value: { ...value, projections: { ...Object.fromEntries(blocks), ...restated } } },
    ...frames.values(),
  ]
}

/** One recorded control frame that replaces a single projection key of one Session. */
interface ProjectionFrame {
  readonly type: 'projection'
  readonly sessionId: string
  readonly key: string
  readonly value: unknown
  readonly seq: number
}

function isBaselineFrame(item: unknown): item is { readonly type: 'baseline'; readonly value: Readonly<Record<string, unknown>> } {
  return isRecord(item) && item.type === 'baseline' && isRecord(item.value)
}

function isProjectionFrame(item: unknown): item is ProjectionFrame {
  return isRecord(item) && item.type === 'projection' && typeof item.sessionId === 'string'
    && typeof item.key === 'string' && typeof item.seq === 'number'
}

/** Whether a stream request is a Session follow that resumes a window its caller already holds. */
function resumesHeldWindow(endpoint: string, payload: unknown): boolean {
  if (endpoint !== 'session/follow' || !isRecord(payload) || !isRecord(payload.args) || !isRecord(payload.args.request)) return false
  return payload.args.request.resume !== undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) => {
    if (typeof field !== 'object' || field === null || Array.isArray(field)) return field
    return Object.fromEntries(Object.entries(field).sort(([left], [right]) => left < right ? -1 : 1))
  })
}

const DATABASE = 'dsh-offline-replay'
const OBJECT_STORE = 'records'

/**
 * Open the page's IndexedDB record store, one database per origin.
 *
 * The database opens at whatever version it has. A database without the record
 * object store holds no records; the store adds it once per page by upgrading
 * to the next version, which keeps any records another page's repair wrote in
 * the meantime. If that repair fails, the store warns once and, for the rest of
 * the page, finds no record and drops every write; the next page load tries
 * again. A connection the browser closes, or that another page's upgrade or
 * deletion asks to close, is replaced on the next call, and a failed open is
 * retried on the next call.
 * @returns the store, or undefined when IndexedDB is unavailable.
 */
export function openIndexedDbReplayStore(): OfflineReplayStore | undefined {
  if (typeof indexedDB === 'undefined') return undefined
  const factory = indexedDB
  let database: Promise<IDBDatabase | undefined> | undefined
  let repaired = false
  const forget = (connection: Promise<IDBDatabase | undefined>): void => {
    if (database === connection) database = undefined
  }
  const reportUnavailable = (error: unknown): void => {
    console.warn('[offline-replay] the record database cannot be repaired; this page keeps no offline records until it reloads:', error)
  }
  const connect = async (): Promise<IDBDatabase | undefined> => {
    const db = await openRecordDatabase(factory, undefined)
    if (db.objectStoreNames.contains(OBJECT_STORE)) return db
    db.close()
    if (repaired) {
      reportUnavailable(new Error('offline replay: the record object store is missing again after this page added it'))
      return undefined
    }
    repaired = true
    console.warn(`[offline-replay] the record database has no "${OBJECT_STORE}" object store and so holds no records; adding the store`)
    let upgraded: IDBDatabase
    try {
      upgraded = await openRecordDatabase(factory, db.version + 1)
    } catch (error) {
      reportUnavailable(error)
      return undefined
    }
    if (upgraded.objectStoreNames.contains(OBJECT_STORE)) return upgraded
    upgraded.close()
    reportUnavailable(new Error('offline replay: the record object store is still missing after the upgrade'))
    return undefined
  }
  const connection = (): Promise<IDBDatabase | undefined> => {
    if (database !== undefined) return database
    const opening: Promise<IDBDatabase | undefined> = connect().then((db) => {
      if (db !== undefined) {
        db.onclose = () => { forget(opening) }
        db.onversionchange = () => {
          db.close()
          forget(opening)
        }
      }
      return db
    }, (error: unknown) => {
      forget(opening)
      throw error
    })
    database = opening
    return opening
  }
  const run = async <T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
    reconnect = true,
  ): Promise<T | undefined> => {
    const current = connection()
    const db = await current
    if (db === undefined) return undefined
    let request: IDBRequest<T>
    try {
      request = operation(db.transaction(OBJECT_STORE, mode).objectStore(OBJECT_STORE))
    } catch (error) {
      // A connection the browser closed before its close event arrived.
      if (!reconnect || !(error instanceof Error && error.name === 'InvalidStateError')) throw error
      forget(current)
      return await run(mode, operation, false)
    }
    return await new Promise<T>((resolve, reject) => {
      request.onsuccess = () => { resolve(request.result) }
      /* v8 ignore next -- an error event always sets the request's error */
      request.onerror = () => { reject(request.error ?? new Error('offline replay: IndexedDB request failed')) }
    })
  }
  return {
    get: key => run('readonly', store => store.get(key)),
    put: async (key, value) => { await run('readwrite', store => store.put(value, key)) },
  }
}

/**
 * Open the record database, creating the record object store in any upgrade.
 * @param factory - the page's IndexedDB factory.
 * @param version - the version to upgrade to, or undefined to open the current one.
 * @returns the connection. It rejects when another page keeps the database open
 *   at its older version, and an upgrade that completes after that is closed again.
 */
function openRecordDatabase(factory: IDBFactory, version: number | undefined): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = version === undefined ? factory.open(DATABASE) : factory.open(DATABASE, version)
    let blocked = false
    request.onupgradeneeded = () => { request.result.createObjectStore(OBJECT_STORE) }
    request.onsuccess = () => {
      if (blocked) request.result.close()
      else resolve(request.result)
    }
    /* v8 ignore next -- an error event always sets the request's error */
    request.onerror = () => { reject(request.error ?? new Error('offline replay: IndexedDB open failed')) }
    request.onblocked = () => {
      blocked = true
      reject(new Error('offline replay: another page keeps the record database open at its older version'))
    }
  })
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

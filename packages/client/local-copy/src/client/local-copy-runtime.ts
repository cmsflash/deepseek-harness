/** Page half of the local copy: owns the worker and forwards the history source (§4.4 step 10). */

import type {
  SessionHistorySource,
  SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { DeviceClass, LocalCopySettings } from './settings.ts'
import type {
  LocalCopyListedThread,
  LocalCopyMethod,
  LocalCopyParams,
  LocalCopyRequest,
  LocalCopyRequestId,
  LocalCopyValue,
} from './protocol.ts'

/** Minimal worker surface the runtime drives. */
export interface WorkerHandle {
  postMessage(message: unknown): void
  terminate(): void
  onmessage: ((event: { readonly data: unknown }) => void) | null
}

/** Creates the dedicated worker from the embedded IIFE source. */
export type SpawnWorker = () => WorkerHandle

/** Session-list store the runtime sends to the worker on every change. */
export interface SessionListSource {
  getSnapshot(): SessionListState
  subscribe(listener: () => void): () => void
}

/** Offline replay activity, exposed by the Gateway Remote. */
export interface OfflineSource {
  getSnapshot(): boolean
  subscribe(listener: () => void): () => void
}

/** Page visibility the worker pauses on (phone). */
export interface VisibilitySource {
  hidden(): boolean
  subscribe(listener: () => void): () => void
}

/** Console the runtime logs its one-time lines to. */
export interface RuntimeLogger {
  info(message: string): void
}

/** Environment inputs of the runtime beyond the worker itself. */
export interface LocalCopyRuntimeOptions {
  readonly linesUrl: string
  readonly device: DeviceClass
  readonly settings: LocalCopySettings
  readonly spawn: SpawnWorker
  readonly list: SessionListSource
  readonly offline: OfflineSource
  readonly visibility: VisibilitySource
  readonly persist: () => Promise<boolean> | boolean
  readonly logger: RuntimeLogger
}

/** A request the worker answered with a failure, carrying the worker's error code. */
export class LocalCopyRequestError extends Error {
  /**
   * @param code - the worker's error code: the name of the innermost failure, such as `QuotaExceededError`.
   * @param detail - the worker's error message.
   */
  constructor(readonly code: string, detail: string) {
    super(`local copy: the worker request failed (${code}): ${detail}`)
    this.name = 'LocalCopyRequestError'
  }
}

/** One outstanding request to the worker. */
interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

/**
 * The page's local-copy holder: starts one worker per tab, registers nothing
 * itself, and implements the `SessionHistorySource` the Sessions service reads.
 */
export class LocalCopyRuntime {
  private readonly worker: WorkerHandle
  private nextId: LocalCopyRequestId = 0
  private readonly pending = new Map<LocalCopyRequestId, Pending>()
  private readonly unsubscribes: (() => void)[] = []
  private persistLogged = false
  private disposed = false
  private started = false

  /** The copy Sessions read before asking the Host (§3 C6). */
  readonly source: SessionHistorySource = {
    opening: (sessionId, window) => this.request('opening', { sessionId, window }),
    page: (sessionId, request) => this.request('page', { sessionId, request }),
    interval: (sessionId, request) => this.request('interval', { sessionId, request }),
    elided: (sessionId, request) => this.request('elided', { sessionId, request }),
    append: (sessionId, lines) => { this.post('append', { sessionId, lines }) },
    opened: (sessionId) => { this.post('opened', { sessionId }) },
    diverged: (sessionId) => { this.post('diverged', { sessionId }) },
  }

  /**
   * @param options - the page environment: lines route, device, funds, and observables.
   */
  constructor(private readonly options: LocalCopyRuntimeOptions) {
    this.worker = this.options.spawn()
    this.worker.onmessage = (event) => { this.receive(event.data) }
  }

  /** Send `init`, the schedule, the page state, and start observing both. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.post('init', {
      linesUrl: this.options.linesUrl,
      phone: this.options.device === 'phone',
      scope: this.options.settings.scope,
      chunkBytes: this.options.settings.chunkBytes,
      minPauseMs: this.options.settings.minPauseMs,
      diskBudgetBytes: this.options.settings.diskBudgetBytes,
    })
    const sendState = () => {
      this.post('state', { offline: this.options.offline.getSnapshot(), hidden: this.options.visibility.hidden() })
    }
    this.unsubscribes.push(
      this.options.list.subscribe(() => { this.sendSchedule() }),
      this.options.offline.subscribe(sendState),
      this.options.visibility.subscribe(sendState),
    )
    this.sendSchedule()
    sendState()
  }

  /** Terminate the worker and stop observing; in-flight requests reject. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.worker.onmessage = null
    this.worker.terminate()
    for (const pending of this.pending.values()) {
      pending.reject(new Error('local copy: the worker was terminated'))
    }
    this.pending.clear()
  }

  /** Send the currently listed ordinary, unarchived threads with their Host activity: the download scope and the refresh trigger. */
  private sendSchedule(): void {
    const state = this.options.list.getSnapshot()
    const listed = state.ids.flatMap((id): LocalCopyListedThread[] => {
      const summary = state.byId[id]
      return summary?.origin === 'subagent' || summary?.blank === true || summary === undefined
        ? []
        : [{ sessionId: id, activityAt: summary.updatedAt, activitySeq: summary.projectionsAsOfSeq ?? -1, running: summary.running }]
    })
    this.post('schedule', { listed })
  }

  /** Post one fire-and-forget worker call. */
  private post<M extends LocalCopyMethod>(method: M, params: LocalCopyParams[M]): void {
    if (this.disposed) return
    this.nextId += 1
    const request = { id: this.nextId, method, params } as LocalCopyRequest
    this.worker.postMessage(request)
  }

  /**
   * Post one request/response worker call.
   * @param method - worker method.
   * @param params - method parameters.
   * @returns the worker's reply value.
   */
  private request<M extends LocalCopyMethod>(method: M, params: LocalCopyParams[M]): Promise<LocalCopyValue[M]> {
    if (this.disposed) return Promise.reject(new Error('local copy: the worker was terminated'))
    this.nextId += 1
    const id = this.nextId
    const request = { id, method, params } as LocalCopyRequest
    return new Promise<LocalCopyValue[M]>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => { resolve(value as LocalCopyValue[M]) }, reject })
      this.worker.postMessage(request)
    })
  }

  /** Route one worker message: a reply or a thread notification. */
  private receive(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const received = message as Record<string, unknown>
    if (received['type'] === 'thread' && typeof received['sessionId'] === 'string'
      && (received['state'] === 'downloading' || received['state'] === 'complete' || received['state'] === 'unverifiable' || received['state'] === 'paused')
      && typeof received['head'] === 'number' && typeof received['cursorSeen'] === 'number') {
      this.threadComplete(received['state'])
      return
    }
    if (typeof received['id'] !== 'number' || typeof received['ok'] !== 'boolean') return
    const pending = this.pending.get(received['id'])
    if (pending === undefined) return
    this.pending.delete(received['id'])
    if (!received['ok']) {
      pending.reject(requestError(received['error']))
      return
    }
    pending.resolve(received['value'])
  }

  /** The first complete thread asks the browser to keep the copy across pressure. */
  private threadComplete(state: string): void {
    if (state !== 'complete' || this.persistLogged) return
    this.persistLogged = true
    void (async (): Promise<void> => {
      try {
        const kept = await this.options.persist()
        this.options.logger.info(`local copy: navigator.storage.persist() -> ${String(kept)}`)
      } catch {
        this.options.logger.info('local copy: navigator.storage.persist() was refused')
      }
    })()
  }
}

/** The failure one worker reply reports, or a generic one when the reply carries no valid detail. */
function requestError(error: unknown): LocalCopyRequestError {
  if (typeof error === 'object' && error !== null) {
    const { code, message } = error as Record<string, unknown>
    if (typeof code === 'string' && typeof message === 'string') return new LocalCopyRequestError(code, message)
  }
  return new LocalCopyRequestError('error', 'the reply carried no error detail')
}

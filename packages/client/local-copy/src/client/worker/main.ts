/** Worker body of the local copy: message dispatch, migration, downloader and page reads (§2.13). */

import type { LockHost } from './downloader.ts'
import { LocalCopyDownloader } from './downloader.ts'
import { localElided, localInterval, localOpening, localPage } from './pages.ts'
import { LocalCopyStore } from './store.ts'
import type { LocalCopyMethod, LocalCopyRequest, LocalCopyRequestId, LocalCopyResponse, LocalCopyValue } from '../protocol.ts'

/** The worker-side surface the main body binds to. */
export interface WorkerScope {
  postMessage(message: unknown): void
  onmessage: ((event: { readonly data: unknown }) => void) | null
  readonly indexedDB?: IDBFactory | undefined
  readonly keyRange?: typeof IDBKeyRange | undefined
  readonly fetch: typeof fetch
  readonly locks?: LockHost | undefined
  readonly onLine: () => boolean
}

/** Foreign database and store the offline replay recorded follow streams in (§2.13). */
const REPLAY_DATABASE = 'dsh-offline-replay'
const REPLAY_STORE = 'records'

/**
 * Install the local-copy worker on one scope.
 * @param scope - the worker global this body runs against.
 * @returns a stop handle clearing the listener; the download loop stops with it.
 */
export function localCopyWorkerMain(scope: WorkerScope): { readonly stop: () => void } {
  if (scope.indexedDB === undefined || scope.keyRange === undefined) {
    console.info('local copy: the worker has no IndexedDB, so no copy is kept')
    return { stop: () => {} }
  }
  const store = new LocalCopyStore({ indexedDB: scope.indexedDB, keyRange: scope.keyRange })
  const state = { offline: false }
  const downloader = new LocalCopyDownloader(store, {
    fetch: scope.fetch,
    locks: scope.locks,
    onLine: scope.onLine,
    now: () => Date.now(),
  }, (notification) => { scope.postMessage(notification) })

  const reply = async (id: LocalCopyRequestId, work: () => Promise<unknown>): Promise<void> => {
    try {
      const value = await work()
      scope.postMessage({ id, ok: true, value: value as LocalCopyValue[LocalCopyMethod] } satisfies LocalCopyResponse)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      scope.postMessage({ id, ok: false, error: { code: errorCode(error), message } } satisfies LocalCopyResponse)
    }
  }

  const accept = (message: LocalCopyRequest): Promise<void> => {
    switch (message.method) {
      case 'init':
        return reply(message.id, async () => {
          await migrateOfflineReplay(store)
          downloader.init(message.params)
        })
      case 'opening':
        return reply(message.id, () => localOpening(store, message.params.sessionId, message.params.window, state.offline))
      case 'page':
        return reply(message.id, () => localPage(store, message.params.sessionId, message.params.request))
      case 'interval':
        return reply(message.id, () => localInterval(store, message.params.sessionId, message.params.request))
      case 'elided':
        return reply(message.id, () => localElided(store, message.params.sessionId, message.params.request))
      case 'append':
        return reply(message.id, () => downloader.append(message.params.sessionId, message.params.lines))
      case 'opened':
        return reply(message.id, () => downloader.opened(message.params.sessionId))
      case 'diverged':
        return reply(message.id, () => downloader.diverged(message.params.sessionId))
      case 'schedule':
        return reply(message.id, () => {
          downloader.schedule(message.params.listed)
          return Promise.resolve()
        })
      case 'state':
        return reply(message.id, () => {
          state.offline = message.params.offline
          downloader.setOffline(message.params.offline)
          downloader.setHidden(message.params.hidden)
          return Promise.resolve()
        })
      case 'usage':
        return reply(message.id, () => store.usage())
      case 'clear':
        return reply(message.id, () => store.clear())
    }
  }

  // One ordered queue keeps per-session append order and durable reads deterministic.
  let queue: Promise<void> = Promise.resolve()
  const handle = (event: { readonly data: unknown }) => {
    const message = event.data
    if (!isRequest(message)) return
    const requested = message
    queue = queue.then(() => accept(requested))
  }
  scope.onmessage = handle
  return {
    stop: () => {
      downloader.dispose()
      if (scope.onmessage === handle) scope.onmessage = null
    },
  }
}

/** One-time migration of recorded follow openings (§2.13). */
async function migrateOfflineReplay(store: LocalCopyStore): Promise<void> {
  if (await store.readMeta('migratedOfflineReplay') === true) return
  const ids = await store.migrateForeignFollowKeys(REPLAY_DATABASE, REPLAY_STORE)
  const at = Date.now()
  for (const [index, sessionId] of ids.entries()) {
    await store.ensureThread(sessionId, at - index)
  }
  await store.writeMeta('migratedOfflineReplay', true)
}

/** Runtime shape check of one page request. */
function isRequest(message: unknown): message is LocalCopyRequest {
  if (typeof message !== 'object' || message === null) return false
  const request = message as Record<string, unknown>
  return typeof request['id'] === 'number' && typeof request['method'] === 'string'
    && (request['params'] === undefined || typeof request['params'] === 'object')
}

/** The name of a failure's innermost `cause`, such as the browser's `QuotaExceededError`; `error` for a thrown non-Error. */
function errorCode(error: unknown): string {
  let code = 'error'
  for (let current = error; current instanceof Error; current = current.cause) code = current.name
  return code
}

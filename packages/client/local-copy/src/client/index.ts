/**
 * Browser half of the local thread copy plugin.
 *
 * One worker per tab keeps a chain-verified copy of every ordinary thread's
 * stored log lines in IndexedDB and serves complete threads' history from
 * there; the Sessions service reads this copy before it asks the Host (§2.1).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionHistorySource } from '@deepseek-ai/dsh-api-session-controller/client'
import workerSource from './worker/index.ts?raw'
import { LocalCopyRuntime, type WorkerHandle } from './local-copy-runtime.ts'
import { deviceClass, localCopyConfigOverride, resolveLocalCopySettings, type LocalCopyConfig } from './settings.ts'

export { Config, type LocalCopyConfig } from './settings.ts'

/** The sessions object layer and the Remote whose offline state pauses downloads. */
export const inject = ['sessions', 'remote']

/**
 * Start the local-copy worker and register it as the Sessions history source.
 * @param ctx - Client plugin context.
 * @param config - schema-validated plugin config; the browser half cannot receive profile values.
 */
export function apply(ctx: Context, config: LocalCopyConfig = {}): void {
  const skip = (reason: string) => {
    console.info(`local copy: ${reason}, so no copy is kept`)
  }
  if ('dshDesktop' in globalThis) {
    skip('the Desktop app keeps its own storage')
    return
  }
  const cryptoApi = (globalThis as { readonly crypto?: { readonly subtle?: unknown } }).crypto
  if (cryptoApi === undefined || cryptoApi.subtle === undefined) {
    skip('an insecure context provides no WebCrypto')
    return
  }
  if (typeof window.Worker === 'undefined') {
    skip('the browser provides no Web Worker')
    return
  }
  const device = deviceClass({ matchMedia: query => globalThis.matchMedia(query), screen: globalThis.screen })
  const override = localStorageOverride()
  const settings = resolveLocalCopySettings(device, { ...config, ...override })
  if (!settings.enabled) {
    skip('the copy is disabled in localStorage dsh.localCopy')
    return
  }
  const sessions = ctx.sessions
  const remote = ctx.remote
  let stopped = false
  let runtime: LocalCopyRuntime | undefined
  ctx.effect(() => () => {
    stopped = true
    runtime?.dispose()
  }, 'local-copy: worker and history source')
  const ready = probeIndexedDb().then((available): LocalCopyRuntime | undefined => {
    if (!available) {
      skip('IndexedDB is unavailable')
      return undefined
    }
    if (stopped) return undefined
    const created = new LocalCopyRuntime({
      linesUrl: new URL('api/session/lines', document.baseURI).href,
      device,
      settings,
      spawn: (): WorkerHandle => spawnWorker(),
      list: sessions.list,
      offline: remote.$offline,
      visibility: documentVisibility(),
      persist: () => navigator.storage.persist(),
      logger: { info: (message) => { console.info(message) } },
    })
    runtime = created
    created.start()
    return created
  })
  /* A Session opened before the probe settles must still ask the copy: Sessions take the source at creation. */
  const source: SessionHistorySource = {
    opening: async (id, window) => (await ready)?.source.opening(id, window),
    page: async (id, request) => (await ready)?.source.page(id, request),
    interval: async (id, request) => (await ready)?.source.interval(id, request),
    elided: async (id, request) => (await ready)?.source.elided(id, request),
    append: (id, lines) => { void ready.then((created) => { created?.source.append(id, lines) }) },
    opened: (id) => { void ready.then((created) => { created?.source.opened(id) }) },
    diverged: (id) => { void ready.then((created) => { created?.source.diverged(id) }) },
  }
  ctx.effect(() => ctx.sessions.registerHistorySource(source, {
    memoryBudgetBytes: settings.memoryBudgetBytes,
    warmFollowGraceMs: settings.warmFollowGraceMs,
    readerLoadGraceMs: settings.readerLoadGraceMs,
  }))
}

/** Create the worker from the embedded IIFE bundle and drop its Blob URL. */
function spawnWorker(): WorkerHandle {
  const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
  try {
    const worker = new Worker(url, { name: 'dsh-local-copy' })
    const handle = {
      postMessage: (message: unknown) => { worker.postMessage(message) },
      terminate: () => { worker.terminate() },
      onmessage: null as ((event: { readonly data: unknown }) => void) | null,
    }
    worker.onmessage = (event) => { handle.onmessage?.(event) }
    return handle
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Page visibility inputs from the document. */
function documentVisibility(): { hidden(): boolean; subscribe(listener: () => void): () => void } {
  return {
    hidden: () => document.visibilityState === 'hidden',
    subscribe: (listener) => {
      document.addEventListener('visibilitychange', listener)
      return () => { document.removeEventListener('visibilitychange', listener) }
    },
  }
}

/** Read and validate the localStorage tuning override; an invalid value warns and ignores. */
function localStorageOverride(): LocalCopyConfig {
  let raw: string | null
  try {
    raw = globalThis.localStorage.getItem('dsh.localCopy') ?? null
  } catch {
    return {}
  }
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn('local copy: localStorage dsh.localCopy is not JSON; the default settings apply')
    return {}
  }
  const override = localCopyConfigOverride(parsed)
  if (override === undefined) {
    console.warn('local copy: localStorage dsh.localCopy is invalid; the default settings apply')
    return {}
  }
  return override
}

/** Whether this origin's IndexedDB opens for private data. */
async function probeIndexedDb(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false
  const database = await new Promise<IDBDatabase | undefined>((resolve) => {
    try {
      const request = indexedDB.open('dsh-local-copy-probe', 1)
      request.onupgradeneeded = () => { request.result.createObjectStore('probe') }
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { resolve(undefined) }
      /* v8 ignore next -- the probe opens at version 1, so it never upgrades past an existing database */
      request.onblocked = () => { resolve(undefined) }
    } catch {
      resolve(undefined)
    }
  })
  if (database === undefined) return false
  database.close()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('dsh-local-copy-probe')
    request.onsuccess = () => { resolve() }
    /* v8 ignore next 2 -- deleting the probe database cannot fail in a healthy user agent */
    request.onerror = () => { resolve() }
    request.onblocked = () => { resolve() }
  })
  return true
}

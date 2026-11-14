/** Page half of the plugin: apply guards, source registration, and HMR disposal (§4.4 step 10). */

// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionHistorySource } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply } from '../src/client/index.ts'

/** The init message's params, cropped to the fields asserted here. */
interface InitParams {
  phone: boolean
  scope: string
  linesUrl: string
}

/** One registered history-source pair. */
interface Registration {
  source: unknown
  options: unknown
}

/** The Sessions surface this suite exercises. */
interface SessionsDouble {
  readonly registered: Registration[]
  registerHistorySource(source: unknown, options: unknown): () => void
  readonly list: {
    getSnapshot: () => {
      readonly ids: string[]
      readonly byId: Record<string, { readonly updatedAt: number; readonly blank: boolean; readonly origin?: string }>
    }
    subscribe: (listener: () => void) => () => void
  }
}

/** Build one Sessions double recording registrations in place. */
function sessionsDouble(): SessionsDouble {
  const registered: Registration[] = []
  const double: SessionsDouble = {
    registered,
    registerHistorySource(source: unknown, options: unknown): () => void {
      registered.push({ source, options })
      return () => {
        const kept = registered.filter((entry: Registration) => entry.source !== source)
        registered.length = 0
        registered.push(...kept)
      }
    },
    list: {
      getSnapshot: () => ({
        ids: ['session-1'],
        byId: { 'session-1': { updatedAt: 42, blank: false } },
      }),
      subscribe: () => () => {},
    },
  }
  return double
}

/** A worker global double recording posts until terminated. */
interface WorkerScopeDouble {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: unknown): void
  terminate(): void
  posted: unknown[]
  terminated: boolean
}

let currentWorker: WorkerScopeDouble | undefined

const originalIndexedDb = globalThis.indexedDB
const originalWorker = globalThis.Worker

/** One Worker constructor whose instances mirror the linked scope double. */
const createWorkerDouble = (scope: () => WorkerScopeDouble | undefined) => {
  function WorkerDouble(): void {}
  const proto = WorkerDouble.prototype as { postMessage: (message: unknown) => void; terminate: () => void; onmessage: unknown }
  proto.postMessage = (message: unknown): void => { scope()?.postMessage(message) }
  proto.terminate = (): void => { scope()?.terminate() }
  proto.onmessage = null
  return WorkerDouble
}

beforeEach(() => {
  const worker: WorkerScopeDouble = {
    onmessage: null,
    posted: [],
    terminated: false,
    postMessage: (message: unknown): void => { worker.posted.push(message) },
    terminate: (): void => { worker.terminated = true },
  }
  currentWorker = worker
  globalThis.indexedDB = new IDBFactory()
  Object.defineProperty(window, 'Worker', { value: createWorkerDouble(() => currentWorker), configurable: true })
  Object.defineProperty(window, 'matchMedia', { value: vi.fn().mockReturnValue({ matches: false }), configurable: true })
})

afterEach(() => {
  globalThis.indexedDB = originalIndexedDb
  Object.defineProperty(window, 'Worker', { value: originalWorker, configurable: true })
  Object.defineProperty(window, 'matchMedia', { value: undefined, configurable: true })
  vi.restoreAllMocks()
})

describe('local copy page half', () => {
  it('registers the history source and disposes with the fiber', async () => {
    const remoteService: Record<string, unknown> = { $offline: { getSnapshot: () => false, subscribe: () => () => {} } }
    const ctx = new Context()
    ctx.provide('remote', remoteService)
    const sessions = sessionsDouble()
    ctx.provide('sessions', sessions as never)
    const fiber = ctx.plugin({
      apply: (pluginCtx: Context) => {
        apply(pluginCtx)
      },
    })
    await fiber
    expect(sessions.registered).toHaveLength(1)
    await vi.waitFor(() => {
      expect(currentWorker?.posted.length).toBeGreaterThan(0)
    })
    const [first] = sessions.registered
    expect(first).toMatchObject({
      options: { memoryBudgetBytes: 104_857_600, warmFollowGraceMs: 30_000, readerLoadGraceMs: 30_000 },
    })
    const init = currentWorker?.posted.find((message): message is { method: string; params: InitParams } =>
      typeof message === 'object' && message !== null && 'method' in message && 'params' in message)
    expect(init?.params).toMatchObject({ phone: false, scope: 'all' })
    expect(init?.params.linesUrl).toContain('api/session/lines')
    expect(currentWorker?.terminated).toBe(false)
    await fiber.dispose()
    expect(currentWorker?.terminated).toBe(true)
    expect(sessions.registered).toHaveLength(0)
  })

  it('passes the localStorage timing overrides with the history source', async () => {
    window.localStorage.setItem('dsh.localCopy', '{"warmFollowGraceMs":5000,"readerLoadGraceMs":0}')
    try {
      const ctx = new Context()
      ctx.provide('remote', { $offline: { getSnapshot: () => false, subscribe: () => () => {} } })
      const sessions = sessionsDouble()
      ctx.provide('sessions', sessions as never)
      const fiber = ctx.plugin({ apply: (pluginCtx: Context) => { apply(pluginCtx) } })
      await fiber
      expect(sessions.registered[0]).toMatchObject({ options: { warmFollowGraceMs: 5_000, readerLoadGraceMs: 0 } })
      await fiber.dispose()
    } finally {
      window.localStorage.clear()
    }
  })

  it('forwards every source call to the worker once the probe settles', async () => {
    const remoteService: Record<string, unknown> = { $offline: { getSnapshot: () => false, subscribe: () => () => {} } }
    const ctx = new Context()
    const sessions = sessionsDouble()
    ctx.provide('sessions', sessions as never)
    ctx.provide('remote', remoteService)
    const fiber = ctx.plugin({ apply: (pluginCtx: Context) => { apply(pluginCtx) } })
    await fiber
    const source = sessions.registered[0]!.source as SessionHistorySource
    const sessionId = 's' as SessionId
    const window = { maxMessages: 10, turnWindow: { minMessages: 1, minTurns: 1 }, stepDetail: 'full', full: false } as const
    void source.opening(sessionId, window).catch(() => {})
    void source.page(sessionId, { ...window, throughSeq: 5 }).catch(() => {})
    void source.interval(sessionId, { fromSeq: 0, throughSeq: 5, full: false }).catch(() => {})
    void source.elided(sessionId, { turn: 1, throughSeq: 5, full: false }).catch(() => {})
    source.append(sessionId, [])
    source.opened(sessionId)
    source.diverged(sessionId)
    await vi.waitFor(() => {
      const methods = (currentWorker?.posted ?? []).map(message => (message as { method: string }).method)
      expect(methods).toEqual(expect.arrayContaining(['opening', 'page', 'interval', 'elided', 'append', 'opened', 'diverged']))
    })
    await fiber.dispose()
  })

  it('answers every source call without a copy while IndexedDB is unavailable', async () => {
    const remoteService: Record<string, unknown> = { $offline: { getSnapshot: () => false, subscribe: () => () => {} } }
    const ctx = new Context()
    const sessions = sessionsDouble()
    ctx.provide('sessions', sessions as never)
    ctx.provide('remote', remoteService)
    Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const fiber = ctx.plugin({ apply: (pluginCtx: Context) => { apply(pluginCtx) } })
      await fiber
      const source = sessions.registered[0]!.source as SessionHistorySource
      const sessionId = 's' as SessionId
      const window = { maxMessages: 10, turnWindow: { minMessages: 1, minTurns: 1 }, stepDetail: 'full', full: false } as const
      await expect(source.opening(sessionId, window)).resolves.toBeUndefined()
      await expect(source.page(sessionId, { ...window, throughSeq: 5 })).resolves.toBeUndefined()
      await expect(source.interval(sessionId, { fromSeq: 0, throughSeq: 5, full: false })).resolves.toBeUndefined()
      await expect(source.elided(sessionId, { turn: 1, throughSeq: 5, full: false })).resolves.toBeUndefined()
      source.append(sessionId, [])
      source.opened(sessionId)
      source.diverged(sessionId)
      await Promise.resolve()
      expect(currentWorker?.posted).toEqual([])
      await fiber.dispose()
    } finally {
      info.mockRestore()
    }
  })

  it('skips registration when the browser provides no Web Worker', async () => {
    const remoteService: Record<string, unknown> = { $offline: { getSnapshot: () => false, subscribe: () => () => {} } }
    const ctx = new Context()
    const sessions = sessionsDouble()
    ctx.provide('sessions', sessions as never)
    ctx.provide('remote', remoteService)
    Object.defineProperty(window, 'Worker', { value: undefined, configurable: true })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const fiber = ctx.plugin({
        apply: (pluginCtx: Context) => {
          apply(pluginCtx)
        },
      })
      await fiber
      await fiber.dispose()
      expect(sessions.registered).toHaveLength(0)
      expect(info).toHaveBeenCalledWith('local copy: the browser provides no Web Worker, so no copy is kept')
    } finally {
      Object.defineProperty(window, 'Worker', { value: createWorkerDouble(() => currentWorker), configurable: true })
      info.mockRestore()
    }
  })

  it('skips registration when localStorage disables the copy', async () => {
    const remoteService: Record<string, unknown> = { $offline: { getSnapshot: () => false, subscribe: () => () => {} } }
    const ctx = new Context()
    const sessions = sessionsDouble()
    ctx.provide('sessions', sessions as never)
    ctx.provide('remote', remoteService)
    window.localStorage.setItem('dsh.localCopy', '{"enabled":false}')
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const fiber = ctx.plugin({
        apply: (pluginCtx: Context) => {
          apply(pluginCtx)
        },
      })
      await fiber
      await fiber.dispose()
      expect(sessions.registered).toHaveLength(0)
      expect(info).toHaveBeenCalledWith('local copy: the copy is disabled in localStorage dsh.localCopy, so no copy is kept')
    } finally {
      window.localStorage.clear()
      info.mockRestore()
    }
  })

  it('skips registration on the Desktop app and logs one line', async () => {
    const remoteService: Record<string, unknown> = { $offline: { getSnapshot: () => false, subscribe: () => () => {} } }
    const ctx = new Context()
    const sessions = sessionsDouble()
    ctx.provide('sessions', sessions as never)
    ctx.provide('remote', remoteService)
    Object.defineProperty(globalThis, 'dshDesktop', { value: true, configurable: true })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const fiber = ctx.plugin({
        apply: (pluginCtx: Context) => {
          apply(pluginCtx)
        },
      })
      await fiber
      await fiber.dispose()
      expect(sessions.registered).toHaveLength(0)
      expect(info).toHaveBeenCalledTimes(1)
    } finally {
      delete (globalThis as { dshDesktop?: boolean }).dshDesktop
    }
  })

  it('skips registration when the browser provides no WebCrypto', async () => {
    const remoteService: Record<string, unknown> = { $offline: { getSnapshot: () => false, subscribe: () => () => {} } }
    const ctx = new Context()
    const sessions = sessionsDouble()
    ctx.provide('sessions', sessions as never)
    ctx.provide('remote', remoteService)
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const fiber = ctx.plugin({
        apply: (pluginCtx: Context) => {
          apply(pluginCtx)
        },
      })
      await fiber
      await fiber.dispose()
      expect(sessions.registered).toHaveLength(0)
      expect(info).toHaveBeenCalledWith('local copy: an insecure context provides no WebCrypto, so no copy is kept')
    } finally {
      if (originalCrypto === undefined) delete (globalThis as { crypto?: unknown }).crypto
      else Object.defineProperty(globalThis, 'crypto', originalCrypto)
      info.mockRestore()
    }
  })

  it('skips registration when IndexedDB is absent outright', async () => {
    const remoteService: Record<string, unknown> = { $offline: { getSnapshot: () => false, subscribe: () => () => {} } }
    const ctx = new Context()
    const sessions = sessionsDouble()
    ctx.provide('sessions', sessions as never)
    ctx.provide('remote', remoteService)
    Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const fiber = ctx.plugin({
        apply: (pluginCtx: Context) => {
          apply(pluginCtx)
        },
      })
      await fiber
      await fiber.dispose()
      expect(sessions.registered).toHaveLength(0)
      expect(info).toHaveBeenCalledWith('local copy: IndexedDB is unavailable, so no copy is kept')
    } finally {
      info.mockRestore()
    }
  })

  it('skips registration when the IndexedDB probe cannot open its database', async () => {
    const remoteService: Record<string, unknown> = { $offline: { getSnapshot: () => false, subscribe: () => () => {} } }
    const factory = new IDBFactory()
    // A future-version probe database makes the probe's own open fail outright.
    await new Promise<void>((resolve) => {
      const request = factory.open('dsh-local-copy-probe', 7)
      request.onupgradeneeded = () => { request.result.createObjectStore('probe') }
      request.onsuccess = () => { request.result.close(); resolve() }
    })
    globalThis.indexedDB = factory
    const ctx = new Context()
    const sessions = sessionsDouble()
    ctx.provide('sessions', sessions as never)
    ctx.provide('remote', remoteService)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const fiber = ctx.plugin({
        apply: (pluginCtx: Context) => {
          apply(pluginCtx)
        },
      })
      await fiber
      await vi.waitFor(() => {
        expect(info).toHaveBeenCalledWith('local copy: IndexedDB is unavailable, so no copy is kept')
      })
      await fiber.dispose()
      expect(sessions.registered).toHaveLength(0)
    } finally {
      info.mockRestore()
    }
  })

  it('skips registration when the IndexedDB probe cannot even open', async () => {
    const remoteService: Record<string, unknown> = { $offline: { getSnapshot: () => false, subscribe: () => () => {} } }
    const ctx = new Context()
    const sessions = sessionsDouble()
    ctx.provide('sessions', sessions as never)
    ctx.provide('remote', remoteService)
    const throwing = Object.create(globalThis.indexedDB) as IDBFactory
    throwing.open = (): IDBOpenDBRequest => { throw new Error('the disk refused') }
    globalThis.indexedDB = throwing
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const fiber = ctx.plugin({
        apply: (pluginCtx: Context) => {
          apply(pluginCtx)
        },
      })
      await fiber
      await vi.waitFor(() => {
        expect(info).toHaveBeenCalledWith('local copy: IndexedDB is unavailable, so no copy is kept')
      })
      await fiber.dispose()
      expect(sessions.registered).toHaveLength(0)
    } finally {
      info.mockRestore()
    }
  })

  it('keeps a blocked probe deletion from stopping the registration', async () => {
    const remoteService: Record<string, unknown> = { $offline: { getSnapshot: () => false, subscribe: () => () => {} } }
    const factory = new IDBFactory()
    // Another open probe connection that never reacts to the deletion blocks it.
    await new Promise<void>((resolve) => {
      const request = factory.open('dsh-local-copy-probe', 1)
      request.onupgradeneeded = () => { request.result.createObjectStore('probe') }
      request.onsuccess = () => { resolve() }
    })
    globalThis.indexedDB = factory
    const ctx = new Context()
    const sessions = sessionsDouble()
    ctx.provide('sessions', sessions as never)
    ctx.provide('remote', remoteService)
    const fiber = ctx.plugin({
      apply: (pluginCtx: Context) => {
        apply(pluginCtx)
      },
    })
    await fiber
    expect(sessions.registered).toHaveLength(1)
    await vi.waitFor(() => {
      expect(currentWorker?.posted.length).toBeGreaterThan(0)
    })
    await fiber.dispose()
    expect(currentWorker?.terminated).toBe(true)
  })

  it('stops before the IndexedDB probe answers and never starts a worker', async () => {
    const remoteService: Record<string, unknown> = { $offline: { getSnapshot: () => false, subscribe: () => () => {} } }
    const ctx = new Context()
    const sessions = sessionsDouble()
    ctx.provide('sessions', sessions as never)
    ctx.provide('remote', remoteService)
    const fiber = ctx.plugin({
      apply: (pluginCtx: Context) => {
        apply(pluginCtx)
      },
    })
    await fiber
    await fiber.dispose()
    for (let round = 0; round < 8; round++) await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(sessions.registered).toHaveLength(0)
    expect(currentWorker?.posted).toEqual([])
  })

  it('applies default settings when localStorage cannot be read', async () => {
    const remoteService: Record<string, unknown> = { $offline: { getSnapshot: () => false, subscribe: () => () => {} } }
    const ctx = new Context()
    const sessions = sessionsDouble()
    ctx.provide('sessions', sessions as never)
    ctx.provide('remote', remoteService)
    const getItem = vi.spyOn(window.Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('storage is in a broke state', 'InvalidStateError')
    })
    try {
      const fiber = ctx.plugin({
        apply: (pluginCtx: Context) => {
          apply(pluginCtx)
        },
      })
      await fiber
      await vi.waitFor(() => {
        expect(sessions.registered).toHaveLength(1)
      })
      await fiber.dispose()
    } finally {
      getItem.mockRestore()
    }
  })

  it('warns once over localStorage overrides that are not JSON or not valid', async () => {
    const remoteService: Record<string, unknown> = { $offline: { getSnapshot: () => false, subscribe: () => () => {} } }
    for (const raw of ['not json', '{"enabled":"yes"}']) {
      window.localStorage.setItem('dsh.localCopy', raw)
      const ctx = new Context()
      const sessions = sessionsDouble()
      ctx.provide('sessions', sessions as never)
      ctx.provide('remote', remoteService)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const fiber = ctx.plugin({
          apply: (pluginCtx: Context) => {
            apply(pluginCtx)
          },
        })
        await fiber
        await vi.waitFor(() => {
          expect(sessions.registered).toHaveLength(1)
        })
        expect(warn).toHaveBeenCalledTimes(1)
        await fiber.dispose()
      } finally {
        warn.mockRestore()
        window.localStorage.clear()
      }
    }
  })

  it('forwards worker frames and keeps storage after the first complete thread', async () => {
    const remoteService: Record<string, unknown> = { $offline: { getSnapshot: () => false, subscribe: () => () => {} } }
    const instances: Array<{ onmessage: ((event: { readonly data: unknown }) => void) | null; terminated: boolean }> = []
    class WorkerCapture {
      onmessage: ((event: { readonly data: unknown }) => void) | null = null
      terminated = false
      constructor() { instances.push(this) }
      postMessage(): void {}
      terminate(): void { this.terminated = true }
    }
    Object.defineProperty(window, 'Worker', { value: WorkerCapture, configurable: true })
    const persist = vi.fn(() => true)
    Object.defineProperty(navigator, 'storage', { value: { persist }, configurable: true })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const ctx = new Context()
    const sessions = sessionsDouble()
    ctx.provide('sessions', sessions as never)
    ctx.provide('remote', remoteService)
    const fiber = ctx.plugin({
      apply: (pluginCtx: Context) => {
        apply(pluginCtx)
      },
    })
    await fiber
    await vi.waitFor(() => {
      expect(sessions.registered).toHaveLength(1)
      expect(instances).toHaveLength(1)
    })
    const frame = { data: { type: 'thread', sessionId: 'session-1', state: 'complete', head: 3, cursorSeen: 3 } }
    instances[0]?.onmessage?.(frame)
    instances[0]?.onmessage?.(frame)
    await vi.waitFor(() => {
      expect(persist).toHaveBeenCalledTimes(1)
    })
    expect(info).toHaveBeenCalledWith('local copy: navigator.storage.persist() -> true')
    await fiber.dispose()
    await vi.waitFor(() => {
      expect(instances[0]?.terminated).toBe(true)
    })
    persist.mockRestore()
    info.mockRestore()
  })
})

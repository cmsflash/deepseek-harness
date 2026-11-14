/** The page's local-copy runtime: worker lifecycle, request/reply, notifications (§2.2). */

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { LocalCopyRuntime, type LocalCopyRuntimeOptions } from '../src/client/local-copy-runtime.ts'

/** One fake worker handle capturing posts until terminated. */
/** One session-list row the harness publishes. */
interface ListedRow {
  readonly id: SessionId
  readonly updatedAt: number
  readonly blank?: boolean
  readonly origin?: 'subagent'
  readonly running?: boolean
  readonly projectionsAsOfSeq?: number
}

interface RecordedWorker {
  handle: {
    postMessage(message: unknown): void
    terminate(): void
    onmessage: ((event: { readonly data: unknown }) => void) | null
  }
  posted: unknown[]
  terminated: boolean
}

/** Build one runtime with its worker, observables, and logger recorded. */
function harness(): {
  runtime: LocalCopyRuntime
  worker: RecordedWorker
  infos: string[]
  emitList: (rows?: readonly ListedRow[]) => void
  emitOffline: () => void
  emitVisibility: () => void
  persistResults: Array<boolean | Error>
} {
  const worker: RecordedWorker = {
    handle: {
      postMessage: (message: unknown): void => { worker.posted.push(message) },
      terminate: (): void => { worker.terminated = true },
      onmessage: null,
    },
    posted: [],
    terminated: false,
  }
  const infos: string[] = []
  const persistResults: Array<boolean | Error> = []
  const listListeners: Array<() => void> = []
  const offlineListeners: Array<() => void> = []
  const visibilityListeners: Array<() => void> = []
  const summaries: Record<SessionId, SessionListState['byId'][SessionId]> = {}
  const sessionRt = brandString<SessionId>('session-rt')
  const state = {
    list: {
      ids: [] as SessionId[],
      byId: summaries,
      phase: 'ready' as const,
      projectionsBySession: {},
    },
    offline: false,
    hidden: false,
  }
  const options: LocalCopyRuntimeOptions = {
    linesUrl: 'http://harness.test/api/session/lines',
    device: 'desktop',
    settings: {
      enabled: true,
      scope: 'all',
      memoryBudgetBytes: 104_857_600,
      diskBudgetBytes: 0,
      chunkBytes: 1_048_576,
      minPauseMs: 100,
      warmFollowGraceMs: 30_000,
      readerLoadGraceMs: 30_000,
    },
    spawn: () => worker.handle,
    list: {
      getSnapshot: () => state.list,
      subscribe: (listener: () => void) => {
        listListeners.push(listener)
        return () => {
          const kept = listListeners.filter((entry: () => void) => entry !== listener)
          listListeners.length = 0
          listListeners.push(...kept)
        }
      },
    },
    offline: {
      getSnapshot: () => state.offline,
      subscribe: (listener: () => void) => {
        offlineListeners.push(listener)
        return () => {
          const kept = offlineListeners.filter((entry: () => void) => entry !== listener)
          offlineListeners.length = 0
          offlineListeners.push(...kept)
        }
      },
    },
    visibility: {
      hidden: () => state.hidden,
      subscribe: (listener: () => void) => {
        visibilityListeners.push(listener)
        return () => {
          const kept = visibilityListeners.filter((entry: () => void) => entry !== listener)
          visibilityListeners.length = 0
          visibilityListeners.push(...kept)
        }
      },
    },
    persist: () => {
      const result = persistResults.shift()
      if (result === undefined) return true
      if (result instanceof Error) throw result
      return result
    },
    logger: { info: (message: string) => { infos.push(message) } },
  }
  return {
    runtime: new LocalCopyRuntime(options),
    worker,
    infos,
    persistResults,
    emitList: (rows?: readonly ListedRow[]) => {
      const entries = rows ?? [{ id: sessionRt, updatedAt: 12 }]
      const listed: Record<SessionId, SessionListState['byId'][SessionId]> = {}
      for (const row of entries) {
        listed[row.id] = {
          id: row.id, displayTitle: 'RT', running: row.running ?? false, retainedBy: {}, updatedAt: row.updatedAt, blank: row.blank ?? false,
          ...(row.origin === undefined ? {} : { origin: row.origin }),
          ...(row.projectionsAsOfSeq === undefined ? {} : { projectionsAsOfSeq: row.projectionsAsOfSeq }),
        }
      }
      state.list = { ...state.list, ids: entries.map(row => row.id), byId: listed }
      for (const listener of listListeners) listener()
    },
    emitOffline: () => { state.offline = true; for (const listener of offlineListeners) listener() },
    emitVisibility: () => { state.hidden = true; for (const listener of visibilityListeners) listener() },
  }
}

/** Reply to the last posted request with one value. */
function reply(worker: RecordedWorker, value: unknown, ok = true): void {
  const request = worker.posted.at(-1) as { id: number } | undefined
  if (request !== undefined) worker.handle.onmessage?.({ data: { id: request.id, ok, value } })
}

/** Answer the newest posted request with a failure reply carrying `error`. */
function replyError(worker: RecordedWorker, error: unknown): void {
  const request = worker.posted.at(-1) as { id: number } | undefined
  if (request !== undefined) worker.handle.onmessage?.({ data: { id: request.id, ok: false, error } })
}

/** The posted frame's method name. */
const methodOf = (message: unknown): string => (message as { method: string }).method

describe('local copy runtime', () => {
  it('starts by sending init, schedule, and state, and follows observable changes', () => {
    const h = harness()
    h.runtime.start()
    expect(h.worker.posted.map(methodOf)).toEqual(['init', 'schedule', 'state'])
    h.emitList()
    h.emitOffline()
    h.emitVisibility()
    const methods = h.worker.posted.map(methodOf)
    expect(methods).toEqual(['init', 'schedule', 'state', 'schedule', 'state', 'state'])
    const schedule = h.worker.posted[3] as { params: { listed: unknown[] } }
    expect(schedule.params.listed).toEqual([{ sessionId: 'session-rt', activityAt: 12, activitySeq: -1, running: false }])
    h.emitList([{ id: brandString<SessionId>('session-rt'), updatedAt: 13, running: true, projectionsAsOfSeq: 30 }])
    expect((h.worker.posted.at(-1) as { params: { listed: unknown[] } }).params.listed)
      .toEqual([{ sessionId: 'session-rt', activityAt: 13, activitySeq: 30, running: true }])
    const state = h.worker.posted[5] as { params: { offline: boolean; hidden: boolean } }
    expect(state.params).toEqual({ offline: true, hidden: true })
  })

  it('answers source reads through request/reply and posts fire-and-forget calls', async () => {
    const h = harness()
    h.runtime.start()
    const source = h.runtime.source
    const opening = source.opening(brandString<SessionId>('session-rt'), { maxMessages: 10, full: false })
    reply(h.worker, { records: [], hasMore: false })
    await expect(opening).resolves.toEqual({ records: [], hasMore: false })
    const failure = source.page(brandString<SessionId>('session-rt'), { maxMessages: 10, throughSeq: 0, full: false })
    reply(h.worker, undefined, false)
    await expect(failure).rejects.toMatchObject({
      name: 'LocalCopyRequestError',
      code: 'error',
      message: 'local copy: the worker request failed (error): the reply carried no error detail',
    })
    source.append(brandString<SessionId>('session-rt'), [])
    source.opened(brandString<SessionId>('session-rt'))
    source.diverged(brandString<SessionId>('session-rt'))
    const tail = h.worker.posted.slice(-3).map(methodOf)
    expect(tail).toEqual(['append', 'opened', 'diverged'])
  })

  it('asks the browser to keep storage after the first complete thread and only once', async () => {
    const h = harness()
    h.runtime.start()
    h.worker.handle.onmessage?.({
      data: { type: 'thread', sessionId: 'session-rt', state: 'downloading', head: 4, cursorSeen: 4 },
    })
    expect(h.infos).toEqual([])
    h.worker.handle.onmessage?.({
      data: { type: 'thread', sessionId: 'session-rt', state: 'complete', head: 9, cursorSeen: 9 },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(h.infos).toEqual(['local copy: navigator.storage.persist() -> true'])
    h.worker.handle.onmessage?.({
      data: { type: 'thread', sessionId: 'session-rt', state: 'complete', head: 10, cursorSeen: 10 },
    })
    expect(h.infos).toHaveLength(1)
  })

  it('logs a refusal when the browser rejects the persistence request', async () => {
    const h = harness()
    h.persistResults.push(new Error('refused'))
    h.runtime.start()
    h.worker.handle.onmessage?.({
      data: { type: 'thread', sessionId: 'session-rt', state: 'complete', head: 1, cursorSeen: 1 },
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.infos).toEqual(['local copy: navigator.storage.persist() was refused'])
  })

  it('ignores malformed frames and unknown reply ids', () => {
    const h = harness()
    h.runtime.start()
    expect(() => h.worker.handle.onmessage?.({ data: 'not an object' })).not.toThrow()
    expect(() => h.worker.handle.onmessage?.({ data: { type: 'thread', state: 'weird' } })).not.toThrow()
    expect(() => h.worker.handle.onmessage?.({ data: { id: 99, ok: true } })).not.toThrow()
  })

  it('terminating rejects in-flight reads and silences further posts', async () => {
    const h = harness()
    h.runtime.start()
    const pending = h.runtime.source.opening(brandString<SessionId>('session-rt'), { maxMessages: 10, full: false })
    h.runtime.dispose()
    await expect(pending).rejects.toThrow('local copy: the worker was terminated')
    expect(h.worker.terminated).toBe(true)
    expect(h.worker.handle.onmessage).toBeNull()
    const after = h.runtime.source.interval(brandString<SessionId>('session-rt'), { fromSeq: 0, throughSeq: 1, full: false })
    await expect(after).rejects.toThrow('local copy: the worker was terminated')
    h.runtime.dispose()
    const posts = h.worker.posted.length
    h.emitList()
    expect(h.worker.posted).toHaveLength(posts)
  })

  it('answers interval and elided reads through request/reply', async () => {
    const h = harness()
    h.runtime.start()
    const interval = h.runtime.source.interval(brandString<SessionId>('session-rt'), { fromSeq: 1, throughSeq: 2, full: false })
    reply(h.worker, [1, 2])
    await expect(interval).resolves.toEqual([1, 2])
    const elided = h.runtime.source.elided(brandString<SessionId>('session-rt'), { turn: 1, throughSeq: 2, full: false })
    replyError(h.worker, { code: 'InvalidStateError', message: 'The database connection is closing.' })
    await expect(elided).rejects.toMatchObject({
      code: 'InvalidStateError',
      message: 'local copy: the worker request failed (InvalidStateError): The database connection is closing.',
    })
    const malformed = h.runtime.source.elided(brandString<SessionId>('session-rt'), { turn: 1, throughSeq: 2, full: false })
    replyError(h.worker, { code: 7 })
    await expect(malformed).rejects.toMatchObject({ code: 'error' })
  })

  it('ignores start after start and after dispose', () => {
    const h = harness()
    h.runtime.start()
    const posts = h.worker.posted.length
    h.runtime.start()
    h.runtime.dispose()
    h.runtime.start()
    expect(h.worker.posted).toHaveLength(posts)
  })

  it('omits subagent and blank threads from the schedule it sends', () => {
    const h = harness()
    h.runtime.start()
    h.emitList([
      { id: brandString<SessionId>('session-rt'), updatedAt: 7 },
      { id: brandString<SessionId>('session-sub'), updatedAt: 8, origin: 'subagent' },
      { id: brandString<SessionId>('session-blank'), updatedAt: 9, blank: true },
    ])
    const schedule = h.worker.posted.at(-1) as { params: { listed: { sessionId: string }[] } }
    expect(schedule.params.listed.map(entry => entry.sessionId)).toEqual(['session-rt'])
  })

  it('drops fire-and-forget posts after the worker is terminated', () => {
    const h = harness()
    h.runtime.start()
    h.runtime.dispose()
    const posts = h.worker.posted.length
    h.runtime.source.append(brandString<SessionId>('session-rt'), [])
    h.runtime.source.opened(brandString<SessionId>('session-rt'))
    h.runtime.source.diverged(brandString<SessionId>('session-rt'))
    expect(h.worker.posted).toHaveLength(posts)
  })

  it('accepts unverifiable and paused thread notifications without asking for persistence', async () => {
    const h = harness()
    h.runtime.start()
    h.worker.handle.onmessage?.({
      data: { type: 'thread', sessionId: 'session-rt', state: 'unverifiable', head: 2, cursorSeen: 2 },
    })
    h.worker.handle.onmessage?.({
      data: { type: 'thread', sessionId: 'session-rt', state: 'paused', head: 2, cursorSeen: 2 },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(h.infos).toEqual([])
  })
})

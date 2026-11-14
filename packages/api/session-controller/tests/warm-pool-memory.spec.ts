/** Warm released generations and the device-wide window memory budget, as units. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WarmSessionPool, type WarmPoolHooks } from '../src/client/sessions/warm-pool.ts'
import {
  WindowMemoryBudget, type BudgetedPage, type BudgetedSession,
} from '../src/client/sessions/window-budget.ts'

type TestRecord = { readonly id: string }

/** The reader-load grace the cases configure unless they choose their own. */
const READER_LOAD_GRACE_MS = 30_000

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function hooks(log: string[]): WarmPoolHooks<TestRecord> {
  return {
    suspend: (record) => { log.push(`suspend:${record.id}`) },
    revive: (record) => { log.push(`revive:${record.id}`) },
  }
}

function sessionOf(record: TestRecord): SessionId {
  return record.id as SessionId
}

describe('WarmSessionPool', () => {
  it('keeps a released generation and revives the same record on retain without firing the grace', () => {
    const log: string[] = []
    const pool = new WarmSessionPool<TestRecord>({ graceMs: 1_000, ...hooks(log) })
    const record: TestRecord = { id: 'kept' }
    pool.add(sessionOf(record), record)
    expect(pool.records()).toEqual([{ sessionId: record.id, record }])

    const revived = pool.take(sessionOf(record))
    expect(revived).toBe(record)
    expect(log).toEqual(['revive:kept'])
    expect(vi.getTimerCount()).toBe(0)
    expect(pool.take(sessionOf(record))).toBeUndefined()
  })

  it('suspends the record once the grace passes and revives on retain', () => {
    const log: string[] = []
    const pool = new WarmSessionPool<TestRecord>({ graceMs: 30, ...hooks(log) })
    const record: TestRecord = { id: 'warm' }
    pool.add(sessionOf(record), record)

    vi.advanceTimersByTime(31)
    expect(log).toEqual(['suspend:warm'])

    expect(pool.take(sessionOf(record))).toBe(record)
    expect(log).toEqual(['suspend:warm', 'revive:warm'])
  })

  it('evicting removes a warmed generation without reviving it and cancels the grace', () => {
    const log: string[] = []
    const pool = new WarmSessionPool<TestRecord>({ graceMs: 30, ...hooks(log) })
    const record: TestRecord = { id: 'evicted' }
    pool.add(sessionOf(record), record)

    expect(pool.evict(sessionOf(record))).toBe(record)
    expect(pool.evict(sessionOf(record))).toBeUndefined()
    vi.advanceTimersByTime(31)
    expect(log).toEqual([])
  })

  it('drains every warmed generation with its identity and stops all grace timers', () => {
    const log: string[] = []
    const pool = new WarmSessionPool<TestRecord>({ graceMs: 30, ...hooks(log) })
    const first: TestRecord = { id: 'one' }
    const second: TestRecord = { id: 'two' }
    pool.add(sessionOf(first), first)
    pool.add(sessionOf(second), second)

    const drained = [...pool.drain()].sort((left, right) => left.sessionId.localeCompare(right.sessionId))
    expect(drained).toEqual([
      { sessionId: 'one', record: first },
      { sessionId: 'two', record: second },
    ])
    vi.advanceTimersByTime(31)
    expect(log).toEqual([])
    expect(pool.records()).toEqual([])
  })
})

/** One mutable stub page. */
interface StubPage {
  from: number
  to: number
  viewedAt: number | null
  loadedAt: number | null
  bytes: number
}

/** Page data a case lists; `loadedAt` defaults to null. */
interface StubPageInput {
  readonly from: number
  readonly to: number
  readonly viewedAt: number | null
  readonly loadedAt?: number
  readonly bytes: number
}

/** BudgetedSession built from mutable page data for eviction cases. */
class StubSession implements BudgetedSession {
  pageList: StubPage[] = []
  bytesTotal: number
  readonly warm: boolean
  readonly sessionId: SessionId
  range: { readonly from: number; readonly to: number } | undefined
  readonly trimmed: number[] = []
  disposeRequested = false
  /** Whether trimming is refused, as while an older-history load runs. */
  refuse = false
  /** Called after each trim, as a window publication would. */
  onTrim: () => void = () => {}

  constructor(config: {
    readonly id: string
    readonly warm: boolean
    readonly pages: readonly StubPageInput[]
    readonly viewport?: { readonly from: number; readonly to: number }
  }) {
    this.sessionId = config.id as SessionId
    this.warm = config.warm
    this.range = config.viewport
    this.bytesTotal = config.pages.reduce((sum, page) => sum + page.bytes, 0)
    this.pageList = config.pages.map(page => ({ ...page, loadedAt: page.loadedAt ?? null }))
  }

  bytes(): number {
    return this.bytesTotal
  }

  pages(): readonly BudgetedPage[] {
    return this.pageList
  }

  viewport(): { readonly from: number; readonly to: number } | undefined {
    return this.range
  }

  trimHead(pageCount: number): boolean {
    if (this.refuse || pageCount <= 0 || pageCount > this.pageList.length || this.pageList.length === 0) return false
    const dropped = this.pageList.slice(0, pageCount)
    const droppedBytes = dropped.reduce((sum, page) => sum + page.bytes, 0)
    this.trimmed.push(pageCount)
    this.bytesTotal -= droppedBytes
    this.pageList = this.pageList.slice(pageCount)
    this.onTrim()
    return true
  }

  /** Prepend one page the reader just loaded. */
  load(page: { readonly from: number; readonly to: number; readonly bytes: number }): void {
    this.pageList = [{ ...page, viewedAt: null, loadedAt: Date.now() }, ...this.pageList]
    this.bytesTotal += page.bytes
  }
}

/** Stubs the reported bytes and drains the idle clock the budget schedules on. */
async function runBudget(options: {
  readonly memoryBudgetBytes: number
  readonly sessions: readonly StubSession[]
  readonly disposeWarm?: (sessionId: SessionId) => void
  readonly readerLoadGraceMs?: number
}): Promise<WindowMemoryBudget> {
  const budget = new WindowMemoryBudget({
    memoryBudgetBytes: options.memoryBudgetBytes,
    readerLoadGraceMs: options.readerLoadGraceMs ?? READER_LOAD_GRACE_MS,
    sessions: () => options.sessions,
    disposeWarm: options.disposeWarm ?? (() => {}),
  })
  budget.recheck()
  await vi.advanceTimersByTimeAsync(2_000)
  return budget
}

describe('WindowMemoryBudget', () => {
  it('evicts the globally oldest-viewed warm page and stops at the 90 percent floor', async () => {
    const warm = new StubSession({
      id: 'w', warm: true,
      pages: [
        { from: 0, to: 9, viewedAt: 100, bytes: 60 },
        { from: 10, to: 19, viewedAt: 400, bytes: 60 },
      ],
    })
    const referenced = new StubSession({
      id: 'r', warm: false,
      pages: [{ from: 0, to: 40, viewedAt: 900, bytes: 20 }],
      viewport: { from: 10, to: 40 },
    })
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    await runBudget({ memoryBudgetBytes: 100, sessions: [warm, referenced] })

    expect(warm.trimmed).toEqual([1])
    expect(referenced.trimmed).toEqual([])
    expect(warm.pageList).toHaveLength(1)
    expect(debug).toHaveBeenCalledWith('[local-copy] memory 80/100 bytes after evicting 1 pages')
  })

  it('evicts a warm Session\'s oldest page before an older-viewed referenced page', async () => {
    const warm = new StubSession({
      id: 'w', warm: true,
      pages: [{ from: 0, to: 9, viewedAt: 900, bytes: 60 }],
    })
    const referenced = new StubSession({
      id: 'r', warm: false,
      pages: [
        { from: 0, to: 9, viewedAt: 100, bytes: 40 },
        { from: 10, to: 19, viewedAt: 900, bytes: 20 },
      ],
      viewport: { from: 10, to: 19 },
    })
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    await runBudget({ memoryBudgetBytes: 100, sessions: [referenced, warm] })

    expect(warm.trimmed).toEqual([1])
    expect(referenced.trimmed).toEqual([])
  })

  it('trims only a Session\'s oldest page, never a later page with the pages before it', async () => {
    const referenced = new StubSession({
      id: 'r', warm: false,
      pages: [
        { from: 0, to: 9, viewedAt: 500, bytes: 60 },
        { from: 10, to: 19, viewedAt: 100, bytes: 60 },
        { from: 20, to: 29, viewedAt: 900, bytes: 10 },
      ],
      viewport: { from: 20, to: 29 },
    })
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    await runBudget({ memoryBudgetBytes: 100, sessions: [referenced] })

    expect(referenced.trimmed).toEqual([1])
    expect(referenced.pageList.map(page => page.from)).toEqual([10, 20])
  })

  it('keeps ranking a never-viewed page first after a viewed one', async () => {
    const unviewed = new StubSession({ id: 'a', warm: true, pages: [{ from: 0, to: 9, viewedAt: null, bytes: 60 }] })
    const viewed = new StubSession({ id: 'b', warm: true, pages: [{ from: 0, to: 9, viewedAt: 50, bytes: 60 }] })
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    await runBudget({ memoryBudgetBytes: 100, sessions: [viewed, unviewed] })

    expect([unviewed.trimmed, viewed.trimmed]).toEqual([[1], []])
  })

  it('breaks a tie in last view by the page that ends first', async () => {
    const sessions = [['a', 10, 19], ['b', 0, 9], ['c', 20, 29]].map(([id, from, to]) => new StubSession({
      id: String(id), warm: true, pages: [{ from: Number(from), to: Number(to), viewedAt: 100, bytes: 40 }],
    }))
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    await runBudget({ memoryBudgetBytes: 100, sessions })

    expect(sessions.map(session => session.trimmed)).toEqual([[], [1], []])
  })

  it('protects a loaded page for the configured reader-load grace', async () => {
    const referenced = new StubSession({
      id: 'r', warm: false,
      pages: [{ from: 10, to: 19, viewedAt: 100, bytes: 40 }],
      viewport: { from: 10, to: 19 },
    })
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    referenced.load({ from: 0, to: 9, bytes: 80 })
    await runBudget({ memoryBudgetBytes: 100, sessions: [referenced], readerLoadGraceMs: 5_000 })
    expect(referenced.trimmed).toEqual([])

    await vi.advanceTimersByTimeAsync(3_100)
    expect(referenced.trimmed).toEqual([1])
  })

  it('disposes a warm Session whose evictable pages are all gone', async () => {
    const warm = new StubSession({
      id: 'w', warm: true,
      pages: [{ from: 0, to: 9, viewedAt: 100, bytes: 120 }],
    })
    const disposed: SessionId[] = []
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    await runBudget({
      memoryBudgetBytes: 100,
      sessions: [warm],
      disposeWarm: (sessionId) => { disposed.push(sessionId) },
    })

    expect(warm.pageList).toHaveLength(0)
    expect(disposed).toEqual(['w' as SessionId])
    expect(debug).toHaveBeenCalledTimes(1)
  })

  it('never touches a referenced Session that reported no viewport', async () => {
    const referenced = new StubSession({
      id: 'r', warm: false,
      pages: [{ from: 0, to: 9, viewedAt: 100, bytes: 120 }],
    })
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    await runBudget({ memoryBudgetBytes: 100, sessions: [referenced] })

    expect(referenced.trimmed).toEqual([])
    expect(debug).not.toHaveBeenCalled()
  })

  it('evicts a referenced page wholly before the viewport and never the viewport page', async () => {
    const referenced = new StubSession({
      id: 'r', warm: false,
      pages: [
        { from: 0, to: 9, viewedAt: 100, bytes: 60 },
        { from: 10, to: 19, viewedAt: 200, bytes: 60 },
      ],
      viewport: { from: 10, to: 19 },
    })
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    await runBudget({ memoryBudgetBytes: 100, sessions: [referenced] })

    expect(referenced.trimmed).toEqual([1])
    expect(referenced.pageList).toEqual([{ from: 10, to: 19, viewedAt: 200, loadedAt: null, bytes: 60 }])
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('memory 60/100'))
  })

  it('ranks a never-viewed page first when equal warm sessions compete', async () => {
    const viewed = new StubSession({
      id: 'a', warm: true,
      pages: [{ from: 0, to: 9, viewedAt: 50, bytes: 60 }],
    })
    const unviewed = new StubSession({
      id: 'b', warm: true,
      pages: [{ from: 0, to: 9, viewedAt: null, bytes: 60 }],
    })
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    await runBudget({ memoryBudgetBytes: 100, sessions: [viewed, unviewed] })

    expect(unviewed.trimmed).toEqual([1])
    expect(viewed.trimmed).toEqual([])
    expect(debug).toHaveBeenCalledExactlyOnceWith('[local-copy] memory 60/100 bytes after evicting 1 pages')
  })

  it('keeps a page the reader just loaded before the viewport until its protection ends', async () => {
    const referenced = new StubSession({
      id: 'r', warm: false,
      pages: [
        { from: 10, to: 19, viewedAt: null, bytes: 50 },
        { from: 20, to: 29, viewedAt: 100, bytes: 40 },
      ],
      viewport: { from: 20, to: 29 },
    })
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const budget = await runBudget({ memoryBudgetBytes: 100, sessions: [referenced] })
    expect(referenced.trimmed).toEqual([])

    referenced.load({ from: 0, to: 9, bytes: 50 })
    budget.recheck()
    await vi.advanceTimersByTimeAsync(2_000)
    budget.recheck()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(referenced.trimmed).toEqual([])
    expect(referenced.bytes()).toBe(140)

    await vi.advanceTimersByTimeAsync(READER_LOAD_GRACE_MS)
    expect(referenced.trimmed).toEqual([1])
    expect(referenced.pageList.map(page => page.from)).toEqual([10, 20])
    expect(debug).toHaveBeenCalledExactlyOnceWith('[local-copy] memory 90/100 bytes after evicting 1 pages')
  })

  it('protects the run of pages a newer load reaches and evicts only what lies before an expired one', async () => {
    const now = Date.now()
    const referenced = new StubSession({
      id: 'r', warm: false,
      pages: [
        { from: 0, to: 9, viewedAt: null, loadedAt: now - READER_LOAD_GRACE_MS, bytes: 50 },
        { from: 10, to: 19, viewedAt: null, loadedAt: now - 1_000, bytes: 50 },
        { from: 20, to: 29, viewedAt: 100, bytes: 40 },
      ],
      viewport: { from: 20, to: 29 },
    })
    const warm = new StubSession({
      id: 'w', warm: true,
      pages: [{ from: 0, to: 9, viewedAt: 500, loadedAt: now, bytes: 30 }],
    })
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    await runBudget({ memoryBudgetBytes: 100, sessions: [referenced, warm] })

    expect(referenced.trimmed).toEqual([1])
    expect(warm.trimmed).toEqual([1])
    expect(referenced.pageList.map(page => page.from)).toEqual([10, 20])
  })

  it('reschedules for the earliest protection end and stops after dispose', async () => {
    const now = Date.now()
    const reader = new StubSession({
      id: 'a', warm: false,
      pages: [{ from: 10, to: 19, viewedAt: 100, bytes: 10 }],
      viewport: { from: 10, to: 19 },
    })
    const other = new StubSession({
      id: 'b', warm: false,
      pages: [
        { from: 0, to: 9, viewedAt: null, loadedAt: now + 5_000, bytes: 90 },
        { from: 10, to: 19, viewedAt: 100, bytes: 10 },
      ],
      viewport: { from: 10, to: 19 },
    })
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const budget = await runBudget({ memoryBudgetBytes: 100, sessions: [other, reader] })

    reader.load({ from: 0, to: 9, bytes: 60 })
    budget.recheck()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(reader.trimmed).toEqual([])

    await vi.advanceTimersByTimeAsync(READER_LOAD_GRACE_MS - 2_000 + 100)
    expect(reader.trimmed).toEqual([1])
    expect(other.trimmed).toEqual([])

    budget.dispose()
    budget.recheck()
    await vi.advanceTimersByTimeAsync(2 * READER_LOAD_GRACE_MS)
    expect(other.trimmed).toEqual([])
  })

  it('stops when a Session refuses to trim and passes again once its total moves', async () => {
    const referenced = new StubSession({
      id: 'r', warm: false,
      pages: [
        { from: 0, to: 9, viewedAt: 100, bytes: 60 },
        { from: 10, to: 19, viewedAt: 200, bytes: 60 },
      ],
      viewport: { from: 10, to: 19 },
    })
    referenced.refuse = true
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const budget = new WindowMemoryBudget({
      memoryBudgetBytes: 100, readerLoadGraceMs: READER_LOAD_GRACE_MS, sessions: () => [referenced], disposeWarm: () => {},
    })
    budget.recheck()
    await vi.advanceTimersByTimeAsync(10)
    expect(referenced.trimmed).toEqual([])

    referenced.refuse = false
    referenced.bytesTotal += 1
    await vi.advanceTimersByTimeAsync(1_000)
    expect(referenced.trimmed).toEqual([1])
  })

  it('leaves the next pass to a window change that arrives during eviction', async () => {
    const warm = new StubSession({
      id: 'w', warm: true,
      pages: [
        { from: 0, to: 9, viewedAt: 100, bytes: 60 },
        { from: 10, to: 19, viewedAt: 200, bytes: 60 },
      ],
    })
    const pinned = new StubSession({
      id: 'p', warm: false,
      pages: [{ from: 0, to: 9, viewedAt: 300, bytes: 95 }],
      viewport: { from: 0, to: 9 },
    })
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const budget = new WindowMemoryBudget({
      memoryBudgetBytes: 100,
      readerLoadGraceMs: READER_LOAD_GRACE_MS,
      sessions: () => [warm, pinned],
      disposeWarm: () => {},
    })
    warm.onTrim = () => { budget.recheck() }
    budget.recheck()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(warm.trimmed).toEqual([1, 1])
    expect(pinned.trimmed).toEqual([])
    budget.dispose()
  })
})

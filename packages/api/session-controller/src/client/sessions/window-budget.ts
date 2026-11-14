/** Device-wide cap on event-text bytes held by live Client Sessions. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { scheduleIdle } from './schedule.ts'

/** Eviction stops once the held total reaches this share of the budget. */
const EVICTION_FLOOR = 0.9

/** One window page the budget ranks by its last read. */
export interface BudgetedPage {
  /** First seq the page covers. */
  readonly from: number
  /** Last seq the page covers. */
  readonly to: number
  /** Wall time of the reader's last view; null while never viewed. */
  readonly viewedAt: number | null
  /** Wall time the reader's own older-history load added the page; null for every other page. */
  readonly loadedAt: number | null
}

/** The seq range a Session's reader reported as visible. */
export interface ViewedRange {
  readonly from: number
  readonly to: number
}

/** One live Session the device memory budget accounts and evicts. */
export interface BudgetedSession {
  readonly sessionId: SessionId
  /** Whether the Session is retained only by the warm pool. */
  readonly warm: boolean
  /** @returns bytes of event text this Session currently holds. */
  bytes(): number
  /** @returns the window's pages, seq-ascending. */
  pages(): readonly BudgetedPage[]
  /** @returns the reader's last reported range, or undefined before any report. */
  viewport(): ViewedRange | undefined
  /**
   * Drop the oldest pages from the window.
   * @param pageCount - number of oldest pages to drop.
   * @returns whether any page was dropped; false while a window load blocks trimming.
   */
  trimHead(pageCount: number): boolean
}

/** One Session's oldest page, the only page of it a run may evict. */
interface EvictionCandidate {
  readonly session: BudgetedSession
  readonly page: BudgetedPage
}

/**
 * Eviction ranking between two Sessions' oldest pages: warm Sessions first,
 * then the page viewed longest ago, where never viewed sorts first because a
 * page no reader saw is the least valuable to hold.
 */
function evictsBefore(left: EvictionCandidate, right: EvictionCandidate): boolean {
  if (left.session.warm !== right.session.warm) return left.session.warm
  const leftAt = left.page.viewedAt ?? 0
  const rightAt = right.page.viewedAt ?? 0
  if (leftAt !== rightAt) return leftAt < rightAt
  return left.page.to < right.page.to
}

/** The run's next page to evict, and when the earliest protected page that blocked a session stops being protected. */
interface EvictionScan {
  readonly candidate: EvictionCandidate | undefined
  readonly protectedUntil: number | undefined
}

/**
 * Cap the summed event-text bytes of all live Sessions at a device budget.
 * Run by window changes and follow-ups, it evicts one Session's oldest page at
 * a time, never a later page before it: warm Sessions' oldest pages first,
 * then referenced Sessions' oldest pages that lie wholly before their last
 * reported viewport, each group ordered by the page's last view. It never
 * evicts a page at or after a viewport, anything of a referenced Session that
 * reported no viewport, or a referenced page the reader loaded within the
 * reader-load grace, which then shields every page after it. Such a page may
 * hold the total above the budget until its protection ends, when the budget
 * runs again. Every run that evicts logs one `console.debug` line with the
 * held total, which validation reads.
 */
export class WindowMemoryBudget {
  private scheduled = false
  private lastRun: { readonly total: number } | undefined
  private protectionTimer: { readonly at: number; readonly handle: ReturnType<typeof setTimeout> } | undefined
  private remeasureTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private readonly options: {
      /** Device-wide bytes of event text live Sessions may hold. */
      readonly memoryBudgetBytes: number
      /**
       * How long a page the reader loaded stays out of eviction. Loading older
       * history keeps the viewport where it was, so a fresh page lies wholly
       * before it until the reader scrolls there.
       */
      readonly readerLoadGraceMs: number
      /** Sessions to account, live and warm. */
      readonly sessions: () => readonly BudgetedSession[]
      /** Fully dispose a warm Session whose evictable pages are gone. */
      readonly disposeWarm: (sessionId: SessionId) => void
    },
  ) {}

  /** Schedule one idle eviction pass within a second, collapsing rapid window changes. */
  recheck(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    scheduleIdle(() => {
      this.scheduled = false
      if (!this.disposed) this.evict()
    })
  }

  /** Stop every scheduled pass; the budget never runs again. */
  dispose(): void {
    this.disposed = true
    if (this.protectionTimer !== undefined) clearTimeout(this.protectionTimer.handle)
    if (this.remeasureTimer !== undefined) clearTimeout(this.remeasureTimer)
    this.protectionTimer = undefined
    this.remeasureTimer = undefined
  }

  private evict(): void {
    const floor = Math.floor(this.options.memoryBudgetBytes * EVICTION_FLOOR)
    let total = this.total()
    let evicted = 0
    let protectedUntil: number | undefined
    while (total > floor) {
      const scan = this.oldestEvictable()
      protectedUntil = scan.protectedUntil
      const candidate = scan.candidate
      if (candidate === undefined) break
      if (!candidate.session.trimHead(1)) break
      evicted += 1
      if (candidate.session.warm && candidate.session.pages().length === 0) {
        this.options.disposeWarm(candidate.session.sessionId)
      }
      total = this.total()
    }
    if (evicted > 0) {
      console.debug(`[local-copy] memory ${String(total)}/${String(this.options.memoryBudgetBytes)} bytes after evicting ${String(evicted)} pages`)
    }
    // Reading may have been measured only after the window settled; when the
    // reported total keeps moving above the floor, measure again before both
    // totals and evictability settle and the loop ends.
    this.lastRun = { total }
    if (total <= floor) return
    if (protectedUntil !== undefined) this.recheckAt(protectedUntil)
    this.remeasure()
  }

  private remeasure(): void {
    if (this.scheduled) return
    this.scheduled = true
    this.remeasureTimer = setTimeout(() => {
      this.remeasureTimer = undefined
      this.scheduled = false
      const total = this.total()
      if (total === this.lastRun?.total) return
      this.evict()
    }, 1000)
  }

  /** Run once more when the earliest blocking protection ends. */
  private recheckAt(at: number): void {
    if (this.protectionTimer !== undefined) {
      if (this.protectionTimer.at <= at) return
      clearTimeout(this.protectionTimer.handle)
    }
    const handle = setTimeout(() => {
      this.protectionTimer = undefined
      // A pending remeasure would otherwise skip the pass: the total is unchanged.
      this.lastRun = undefined
      this.recheck()
    }, Math.max(0, at - Date.now()))
    this.protectionTimer = { at, handle }
  }

  private total(): number {
    let total = 0
    for (const session of this.options.sessions()) total += session.bytes()
    return total
  }

  /**
   * The first evictable oldest page across Sessions by {@link evictsBefore}.
   * Only a Session's oldest page is a candidate, since trimming drops every
   * page before the one it reaches. A referenced Session with no viewport, or
   * whose oldest page reaches it or is under load protection, offers nothing.
   */
  private oldestEvictable(): EvictionScan {
    const now = Date.now()
    const sessions = [...this.options.sessions()]
    sessions.sort((left, right) => left.sessionId < right.sessionId ? -1 : 1)
    let best: EvictionCandidate | undefined
    let protectedUntil: number | undefined
    for (const session of sessions) {
      const page = session.pages()[0]
      if (page === undefined) continue
      if (!session.warm) {
        const viewport = session.viewport()
        if (viewport === undefined || page.to >= viewport.from) continue
        const until = page.loadedAt === null ? undefined : page.loadedAt + this.options.readerLoadGraceMs
        if (until !== undefined && until > now) {
          protectedUntil = Math.min(protectedUntil ?? until, until)
          continue
        }
      }
      const candidate = { session, page }
      if (best === undefined || evictsBefore(candidate, best)) best = candidate
    }
    return { candidate: best, protectedUntil }
  }
}

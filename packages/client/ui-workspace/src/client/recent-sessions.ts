/** Sessions the main view left most recently, kept retained so returning to one reuses its loaded history. */

import type { ISessions, SessionReference, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A Session the main view left recently, kept so returning to it reuses its live generation. */
    recentView: unknown
  }
}

/**
 * Holds one `recentView` reference to each of the Sessions the main view left most recently,
 * most recent first. Returning to a kept Session reuses its live generation, with its loaded
 * history, open history stream, and binding-owned view state, instead of opening it again.
 */
export class RecentSessions {
  private kept: readonly SessionReference[] = []

  /**
   * @param sessions - Session Controller that issues the references.
   * @param capacity - how many left Sessions stay retained; 0 retains none.
   */
  constructor(
    private readonly sessions: Pick<ISessions, 'retain'>,
    private readonly capacity: number,
  ) {}

  /**
   * Retain a Session the main view is leaving, releasing the least recently left one beyond
   * capacity. Call it while the main view still holds the Session, so its generation carries over.
   * @param target - the target the main view displayed.
   */
  keep(target: SessionTarget): void {
    if (this.capacity === 0) return
    const reference = this.sessions.retain(target, { source: 'recentView' })
    this.release(reference.sessionId)
    const kept = [reference, ...this.kept]
    this.kept = kept.slice(0, this.capacity)
    for (const evicted of kept.slice(this.capacity)) evicted.release()
  }

  /**
   * Release the kept reference of one Session, if any.
   * @param sessionId - Session the main view entered.
   */
  release(sessionId: SessionId): void {
    this.releaseWhere(id => id === sessionId)
  }

  /**
   * Release every kept reference whose Session matches.
   * @param matches - selects the Sessions to release.
   */
  releaseWhere(matches: (sessionId: SessionId) => boolean): void {
    const released = this.kept.filter(reference => matches(reference.sessionId))
    if (released.length === 0) return
    this.kept = this.kept.filter(reference => !released.includes(reference))
    for (const reference of released) reference.release()
  }

  /** Release every kept reference. */
  clear(): void {
    const released = this.kept
    this.kept = []
    for (const reference of released) reference.release()
  }
}

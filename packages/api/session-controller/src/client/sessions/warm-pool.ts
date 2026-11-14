/** Released Sessions kept warm while a local copy history source is registered. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** What the warm pool needs from the Session owner to move a generation in and out. */
export interface WarmPoolHooks<Record> {
  /**
   * Stop the record's live follow so a warm generation stops drawing on the
   * Host; the record's window stays exactly as the reader last saw it.
   * @param record - the generation entering suspension.
   */
  suspend(record: Record): void
  /**
   * Resume following a suspended record from its held window.
   * @param record - the generation leaving the pool.
   */
  revive(record: Record): void
}

interface WarmEntry<Record> {
  record: Record
  releasedAt: number
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * Owns released Sessions for one registered local copy. A warm record is out
 * of the allocator's live map: no retained generation exists, borrowing
 * returns undefined, and a later retain through {@link take} revives the same
 * Session under a new generation. After the grace period the follow stream is
 * suspended while the window stays; a revived record resumes it, so a return
 * is one resumed opening.
 */
export class WarmSessionPool<Record> {
  private readonly entries = new Map<SessionId, WarmEntry<Record>>()

  constructor(
    private readonly options: { readonly graceMs: number } & WarmPoolHooks<Record>,
  ) {}

  /**
   * Keep one released generation warm.
   * @param id - the Session identity.
   * @param record - the generation whose last reference was just released.
   */
  add(id: SessionId, record: Record): void {
    this.takeEntry(id)
    const entry: WarmEntry<Record> = { record, releasedAt: Date.now(), timer: undefined }
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      this.options.suspend(entry.record)
    }, this.options.graceMs)
    this.entries.set(id, entry)
  }

  /**
   * Return a warmed generation to the allocator and resume its follow.
   * @param id - the Session identity.
   * @returns the revived generation, or undefined when none is warm.
   */
  take(id: SessionId): Record | undefined {
    const record = this.takeEntry(id)?.record
    if (record === undefined) return undefined
    this.options.revive(record)
    return record
  }

  /**
   * Remove a warmed generation without reviving it; the caller retires it.
   * @param id - the Session identity.
   * @returns the generation, or undefined when none is warm.
   */
  evict(id: SessionId): Record | undefined {
    return this.takeEntry(id)?.record
  }

  /**
   * Every warm generation with its identity, for the device memory budget.
   * @returns every warm generation as a copy, in no particular order.
   */
  records(): readonly { readonly sessionId: SessionId; readonly record: Record }[] {
    return [...this.entries].map(([sessionId, entry]) => ({ sessionId, record: entry.record }))
  }

  /**
   * Stop keeping every generation warm. Suspended records keep their windows
   * until the caller's drop retires them.
   * @returns every warm generation with its identity, in no particular order.
   */
  drain(): readonly { readonly sessionId: SessionId; readonly record: Record }[] {
    const drained = this.records()
    for (const entry of this.entries.values()) this.clearTimer(entry)
    this.entries.clear()
    return drained
  }

  private takeEntry(id: SessionId): WarmEntry<Record> | undefined {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    this.clearTimer(entry)
    this.entries.delete(id)
    return entry
  }

  /** A cancelled wait must not suspend the generation it was keeping warm. */
  private clearTimer(entry: WarmEntry<Record>): void {
    if (entry.timer === undefined) return
    clearTimeout(entry.timer)
    entry.timer = undefined
  }
}

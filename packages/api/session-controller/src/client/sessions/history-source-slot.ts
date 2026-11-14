/** One guarded installation slot for the Client-local Session history source. */

import type {
  SessionHistorySource, SessionHistorySourceOptions,
} from '../contract/history-source.ts'

/** One registration held by {@link SessionHistorySourceSlot.register}. */
export interface SessionHistorySourceRegistration {
  readonly source: SessionHistorySource
  readonly options: SessionHistorySourceOptions
}

/**
 * Hold the single Session history source ClientSessions accepts: the first
 * registration occupies the slot, a second one throws, and each disposer
 * removes exactly its own registration. Production and the test-support
 * double share it, so both enforce the same registration lifecycle.
 */
export class SessionHistorySourceSlot {
  private held: SessionHistorySourceRegistration | undefined

  /**
   * Install the one history source this slot accepts.
   * @param source - the local-copy history source.
   * @param options - device budgets the source's Sessions honor.
   * @returns the disposer that removes exactly this registration when it still
   *   holds the slot, and reports whether it did.
   */
  register(source: SessionHistorySource, options: SessionHistorySourceOptions): () => boolean {
    if (this.held !== undefined) throw new Error('history source already registered')
    const registration: SessionHistorySourceRegistration = { source, options }
    this.held = registration
    return () => {
      if (this.held !== registration) return false
      this.held = undefined
      return true
    }
  }
}

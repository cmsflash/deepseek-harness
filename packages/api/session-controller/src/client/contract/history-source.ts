/** Copy-backed Session history that Client Sessions read before asking the Host. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionChainLink, SessionHistoryRecord, SessionPageRequest, StepDigest } from '../../types.ts'

/** One record read from the local copy. */
export interface LocalHistoryRecord extends SessionHistoryRecord {
  /** Bytes of stored event text this record holds in memory after stripping. */
  readonly bytes: number
  /** The recorded stream was cut to its first-token prefix; the full event stays on disk. */
  readonly stripped?: true
  /** SHA-256 hex of the `request/header` header JSON; identical headers share it. */
  readonly headerKey?: string
}

/** One page read from the local copy, shaped like a Host page. */
export interface LocalHistoryPage {
  readonly records: readonly LocalHistoryRecord[]
  readonly hasMore: boolean
  readonly digests?: readonly StepDigest[]
  /** Last seq the page covers; the copy's head for an opening. */
  readonly cursor: number
  /** An opening read from a copy that does not yet hold the whole log; set only on openings. */
  readonly partial?: true
}

/** Window fields of a local read; `full` turns off stripping and collapse. */
export type LocalHistoryWindow = Pick<SessionPageRequest, 'maxMessages' | 'turnWindow' | 'stepDetail'> & { readonly full: boolean }

/**
 * A browser copy of Session logs, installed through `ISessions.registerHistorySource`.
 * Sessions treat a rejected read like `undefined` and read from the Host.
 */
export interface SessionHistorySource {
  /**
   * Read the newest window of a complete copy, or of a partial copy while the Host is unreachable.
   * @param sessionId - the Session to open.
   * @param window - the opening window.
   * @returns the page, marked `partial` when the copy is partial, or `undefined` to open from the Host.
   */
  opening(sessionId: SessionId, window: LocalHistoryWindow): Promise<LocalHistoryPage | undefined>
  /**
   * Read one older page at a cut.
   * @param sessionId - the Session.
   * @param request - the window, the exclusive `beforeSeq` and the inclusive cut.
   * @returns the page, or `undefined` when the copy does not cover it.
   */
  page(
    sessionId: SessionId,
    request: LocalHistoryWindow & { readonly beforeSeq?: number; readonly throughSeq: number },
  ): Promise<LocalHistoryPage | undefined>
  /**
   * Read every event of an inclusive interval.
   * @param sessionId - the Session.
   * @param request - the interval and whether to keep heavy parts.
   * @returns the records, or `undefined` when the copy does not cover the interval.
   */
  interval(
    sessionId: SessionId,
    request: { readonly fromSeq: number; readonly throughSeq: number; readonly full: boolean },
  ): Promise<readonly LocalHistoryRecord[] | undefined>
  /**
   * Read the events a collapsed page withheld from one turn.
   * @param sessionId - the Session.
   * @param request - the turn, the window head, the cut and whether to keep heavy parts.
   * @returns the records, or `undefined` when the copy does not cover the turn.
   */
  elided(
    sessionId: SessionId,
    request: {
      readonly turn: number
      readonly fromSeq?: number
      readonly throughSeq: number
      readonly full: boolean
    },
  ): Promise<readonly LocalHistoryRecord[] | undefined>
  /**
   * Offer stored lines that arrived live or in a resumed opening, in seq order.
   * @param sessionId - the Session.
   * @param lines - consecutive stored lines with the Host's links.
   */
  append(sessionId: SessionId, lines: readonly { readonly seq: number; readonly line: string; readonly link: SessionChainLink }[]): void
  /**
   * Record that the Session was opened on this device, which raises its download priority.
   * @param sessionId - the Session.
   */
  opened(sessionId: SessionId): void
  /**
   * Report that a Host snapshot replaced a window this copy opened, so the copy is checked and repaired.
   * @param sessionId - the Session.
   */
  diverged(sessionId: SessionId): void
}

/** Device budgets supplied with a history source. */
export interface SessionHistorySourceOptions {
  /** Device-wide bytes of event text that live Sessions may hold in memory. */
  readonly memoryBudgetBytes: number
  /** How long a released Session keeps following before it suspends. */
  readonly warmFollowGraceMs: number
  /** How long a page the reader's own older-history load added stays out of eviction. */
  readonly readerLoadGraceMs: number
}

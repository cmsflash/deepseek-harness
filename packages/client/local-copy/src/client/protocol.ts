/** Messages between the local-copy page half and its worker. */

import type { LocalHistoryPage, LocalHistoryRecord, LocalHistoryWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionChainLink } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LocalCopyScope } from './settings.ts'

/** One stored line the page observed live or in a resumed opening. */
export interface LocalCopyLine {
  readonly seq: number
  readonly line: string
  readonly link: SessionChainLink
}

/** One thread of the session list with the Host activity the list reports for it. */
export interface LocalCopyListedThread {
  readonly sessionId: SessionId
  /** Latest prompt time, epoch ms. */
  readonly activityAt: number
  /** Watermark seq of the list row's projection values, which the Host log has reached; −1 when the row carries none. */
  readonly activitySeq: number
  readonly running: boolean
}

/** Device inputs the worker needs once at start. */
export interface LocalCopyInit {
  /** Absolute route URL the worker fetches stored lines from (a Blob worker cannot resolve relative ones). */
  readonly linesUrl: string
  readonly phone: boolean
  readonly scope: LocalCopyScope
  readonly chunkBytes: number
  readonly minPauseMs: number
  readonly diskBudgetBytes: number
}

/** Storage totals the `usage` request reports. */
export interface LocalCopyUsage {
  readonly threads: number
  readonly downloading: number
  readonly complete: number
  readonly unverifiable: number
  readonly paused: number
  readonly lineBytes: number
}

/** Worker methods that mirror `SessionHistorySource`, plus its own controls. */
export type LocalCopyMethod =
  | 'init'
  | 'opening'
  | 'page'
  | 'interval'
  | 'elided'
  | 'append'
  | 'opened'
  | 'diverged'
  | 'schedule'
  | 'state'
  | 'usage'
  | 'clear'

/** Request parameters per worker method. */
export interface LocalCopyParams {
  readonly init: LocalCopyInit
  readonly opening: { readonly sessionId: SessionId; readonly window: LocalHistoryWindow }
  readonly page: {
    readonly sessionId: SessionId
    readonly request: LocalHistoryWindow & { readonly beforeSeq?: number; readonly throughSeq: number }
  }
  readonly interval: {
    readonly sessionId: SessionId
    readonly request: { readonly fromSeq: number; readonly throughSeq: number; readonly full: boolean }
  }
  readonly elided: {
    readonly sessionId: SessionId
    readonly request: { readonly turn: number; readonly fromSeq?: number; readonly throughSeq: number; readonly full: boolean }
  }
  readonly append: { readonly sessionId: SessionId; readonly lines: readonly LocalCopyLine[] }
  readonly opened: { readonly sessionId: SessionId }
  readonly diverged: { readonly sessionId: SessionId }
  readonly schedule: { readonly listed: readonly LocalCopyListedThread[] }
  readonly state: { readonly offline: boolean; readonly hidden: boolean }
  readonly usage: undefined
  readonly clear: undefined
}

/** Reply value per worker method. */
export interface LocalCopyValue {
  readonly init: void
  readonly opening: LocalHistoryPage | undefined
  readonly page: LocalHistoryPage | undefined
  readonly interval: readonly LocalHistoryRecord[] | undefined
  readonly elided: readonly LocalHistoryRecord[] | undefined
  readonly append: void
  readonly opened: void
  readonly diverged: void
  readonly schedule: void
  readonly state: void
  readonly usage: LocalCopyUsage
  readonly clear: void
}

/** One request/response pair id. */
export type LocalCopyRequestId = number

/** One request the page posts to the worker. */
export type LocalCopyRequest = {
  readonly id: LocalCopyRequestId
} & {
  readonly [M in LocalCopyMethod]: { readonly method: M; readonly params: LocalCopyParams[M] }
}[LocalCopyMethod]

/** One reply the worker posts for a request. */
export type LocalCopyResponse = { readonly id: LocalCopyRequestId; readonly ok: true; readonly value: LocalCopyValue[LocalCopyMethod] }
  | { readonly id: LocalCopyRequestId; readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Thread progress the worker reports to the page. */
export interface LocalCopyThreadNotification {
  readonly type: 'thread'
  readonly sessionId: SessionId
  readonly state: 'downloading' | 'complete' | 'unverifiable' | 'paused'
  readonly head: number
  readonly cursorSeen: number
}

/** Every message direction the page and worker exchange. */
export type LocalCopyWorkerMessage = LocalCopyResponse | LocalCopyThreadNotification

/** Extract the union of request objects (helper for both sides' dispatch maps). */
export type LocalCopyRequestOf<M extends LocalCopyMethod> = Extract<LocalCopyRequest, { method: M }>

/**
 * Interrupted Sessions and the bulk `Continue.` that resumes them. A Session
 * is interrupted when its latest turn failed, was closed as `interrupted`
 * after the Host stopped mid-turn, or was cancelled because its Agent was
 * disposed by a Host stop or plugin reload, and it is an ordinary, unarchived
 * Session that is not running. A user's Stop and every other end are final.
 */
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { LatestTurnState } from '@deepseek-ai/dsh-api-session-controller/types'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InterruptedSessionsState } from '../contract/slots.ts'

/**
 * Whether `Continue.` resumes a latest turn.
 * @param turn - the Session's `latestTurn` projection value; undefined while unknown.
 * @returns true for a failed, interrupted, or disposal-cancelled end.
 */
export function continuable(turn: LatestTurnState | null | undefined): boolean {
  if (turn === undefined || turn === null) return false
  switch (turn.status) {
    case 'error':
    case 'interrupted':
      return true
    case 'aborted':
      return turn.cancelCause === 'disposed'
    // Open turns, completions, other cancellations, and plugin-defined ends stay as they are.
    default:
      return false
  }
}

function interrupted(summary: SessionSummary | undefined, archived: ReadonlySet<SessionId>): boolean {
  return summary !== undefined && summary.origin !== 'subagent' && !summary.running
    && !archived.has(summary.id) && continuable(summary.projectionValues?.latestTurn)
}

/**
 * Select the interrupted Sessions.
 * @param list - Session list snapshot carrying running state and projection values.
 * @param archived - registry-global archived Session ids.
 * @returns interrupted Session ids in Host-list order.
 */
export function interruptedSessionIds(list: SessionListState, archived: ReadonlySet<SessionId>): SessionId[] {
  return list.ids.filter(id => interrupted(list.byId[id], archived))
}

/** Outcome of one bulk continue that sent at least one prompt. */
export interface ContinueOutcome {
  /** Prompts the Host admitted. */
  readonly continued: number
  /** Prompts that failed. */
  readonly failed: number
}

/** Interrupted-Session source plus the bulk continue over it. */
export interface InterruptedSessions {
  /** Current state; a snapshot keeps its identity until its content changes. */
  readonly state: HostObservable<InterruptedSessionsState>
  /**
   * Send `Continue.` to each interrupted Session in turn, skipping any that
   * stopped qualifying meanwhile; no-op while a bulk continue is sending.
   * @returns completion after the outcome is reported.
   */
  continueAll(): Promise<void>
  /**
   * Keep Sessions that were sent `Continue.` out of the state until the list
   * shows them running, so the new turn's start cannot be read as the old
   * interruption. Call once for the owner's lifetime.
   * @returns the disposer.
   */
  watch(): () => void
}

function sameIds(left: readonly SessionId[], right: readonly SessionId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/**
 * Create the interrupted-Session source and its bulk continue.
 * @param list - Session list source.
 * @param workspaces - Workspace source carrying the archived set.
 * @param prompt - sends `Continue.` to one Session and resolves whether the Host admitted it; never rejects.
 * @param report - receives the outcome of each bulk continue that sent a prompt.
 * @returns the source, the bulk continue, and the running watcher.
 */
export function createInterruptedSessions(
  list: HostObservable<SessionListState>,
  workspaces: HostObservable<Pick<WorkspaceSnapshot, 'archivedSessionIds'>>,
  prompt: (sessionId: SessionId) => Promise<boolean>,
  report: (outcome: ContinueOutcome) => void,
): InterruptedSessions {
  const sent = new Set<SessionId>()
  let continuing = false
  let revision = 0
  const listeners = new Set<() => void>()
  const changed = (): void => {
    revision++
    for (const listener of [...listeners]) listener()
  }
  const archived = (): ReadonlySet<SessionId> => new Set(workspaces.getSnapshot().archivedSessionIds)
  let cache: {
    list: SessionListState
    workspaces: Pick<WorkspaceSnapshot, 'archivedSessionIds'>
    revision: number
    value: InterruptedSessionsState
  } | undefined

  const state: HostObservable<InterruptedSessionsState> = {
    getSnapshot: () => {
      const listSnapshot = list.getSnapshot()
      const workspaceSnapshot = workspaces.getSnapshot()
      if (cache?.list === listSnapshot && cache.workspaces === workspaceSnapshot && cache.revision === revision) {
        return cache.value
      }
      const sessionIds = interruptedSessionIds(listSnapshot, archived()).filter(id => !sent.has(id))
      const value = cache !== undefined && cache.value.continuing === continuing && sameIds(cache.value.sessionIds, sessionIds)
        ? cache.value
        : { sessionIds, continuing }
      cache = { list: listSnapshot, workspaces: workspaceSnapshot, revision, value }
      return value
    },
    subscribe: (listener) => {
      listeners.add(listener)
      const unsubscribeList = list.subscribe(listener)
      const unsubscribeWorkspaces = workspaces.subscribe(listener)
      return () => {
        listeners.delete(listener)
        unsubscribeList()
        unsubscribeWorkspaces()
      }
    },
  }

  return {
    state,
    async continueAll() {
      if (continuing) return
      const targets = state.getSnapshot().sessionIds
      if (targets.length === 0) return
      continuing = true
      changed()
      let continued = 0
      let failed = 0
      try {
        for (const sessionId of targets) {
          if (!interrupted(list.getSnapshot().byId[sessionId], archived())) continue
          if (await prompt(sessionId)) {
            sent.add(sessionId)
            continued++
          } else {
            failed++
          }
          changed()
        }
      } finally {
        continuing = false
        changed()
      }
      if (continued + failed > 0) report({ continued, failed })
    },
    watch: () => list.subscribe(() => {
      const { byId } = list.getSnapshot()
      let released = false
      for (const sessionId of sent) {
        const summary = byId[sessionId]
        if (summary === undefined || summary.running) {
          sent.delete(sessionId)
          released = true
        }
      }
      if (released) changed()
    }),
  }
}

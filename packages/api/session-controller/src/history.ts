/** Shared Session history pagination, step detail, address validation and wire conversion. */

import {
  isAppendSurfaceEvent,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset as SessionLogOffsetType,
  SessionSeqCursor,
} from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import type { TurnTokenUsage } from '@deepseek-ai/dsh-token-meter/turn-usage'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { collapseSteps } from './step-collapse.ts'
import type {
  SessionAddress,
  SessionEventEntry,
  SessionExpandStepsRequest,
  SessionHistoryRecord,
  SessionPageRequest,
  SessionStepDetail,
  SessionWireEvent,
  StepDigest,
} from './types.ts'

/** Message budget applied when a history request omits `maxMessages`. */
export const DEFAULT_MAX_MESSAGES = 50
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * Reject an invalid message budget or turn window.
 * @param request - history window fields.
 */
export function validateHistoryWindow(request: Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'>): void {
  if (request.maxMessages !== undefined
    && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
    throw new RemoteError('gateway/bad-request', 'maxMessages must be a positive safe integer', {})
  }
  const window = request.turnWindow
  if (window !== undefined) {
    if (!Number.isSafeInteger(window.minMessages) || window.minMessages <= 0
      || window.minMessages > (request.maxMessages ?? DEFAULT_MAX_MESSAGES)) {
      throw new RemoteError('gateway/bad-request', 'turnWindow.minMessages must be a positive safe integer no greater than maxMessages', {})
    }
    if (!Number.isSafeInteger(window.minTurns) || window.minTurns <= 0) {
      throw new RemoteError('gateway/bad-request', 'turnWindow.minTurns must be a positive safe integer', {})
    }
  }
}

/**
 * Reject an invalid exact-interval head, or one combined with a page window or collapsed detail.
 * A head past an omitted cut is rejected once the read resolves that cut.
 * @param request - history request fields.
 */
export function validateHistoryInterval(request: Omit<SessionPageRequest, 'address'>): void {
  if (request.fromSeq === undefined) return
  if (!Number.isSafeInteger(request.fromSeq)
    || request.fromSeq < 0
    || Object.is(request.fromSeq, -0)
    || (request.throughSeq !== undefined && request.fromSeq > request.throughSeq + 1)) {
    throw new RemoteError('gateway/bad-request', 'fromSeq must be a non-negative safe integer at or before throughSeq + 1', {})
  }
  if (request.beforeSeq !== undefined || request.maxMessages !== undefined || request.turnWindow !== undefined
    || request.stepDetail === 'collapsed') {
    throw new RemoteError(
      'gateway/bad-request',
      'an exact history interval cannot use a message budget, a turn window, beforeSeq, or collapsed detail',
      {},
    )
  }
}

/**
 * Reject an invalid cut, turn, or window head of a step expansion.
 * @param request - expansion request fields.
 */
export function validateExpandStepsRequest(request: SessionExpandStepsRequest): void {
  if (!Number.isSafeInteger(request.throughSeq)
    || request.throughSeq < -1
    || Object.is(request.throughSeq, -0)) {
    throw new RemoteError('gateway/bad-request', 'throughSeq must be an integer greater than or equal to -1', {})
  }
  if (!Number.isSafeInteger(request.turn) || request.turn < 0 || Object.is(request.turn, -0)) {
    throw new RemoteError('gateway/bad-request', 'turn must be a non-negative safe integer', {})
  }
  if (request.fromSeq !== undefined
    && (!Number.isSafeInteger(request.fromSeq) || request.fromSeq < 0 || Object.is(request.fromSeq, -0))) {
    throw new RemoteError('gateway/bad-request', 'fromSeq must be a non-negative safe integer', {})
  }
}

/**
 * Select the Session whose log an address names.
 * @param address - ordinary Session or direct-subagent address.
 * @returns the Session whose log the address reads.
 */
export function addressId(address: SessionAddress): SessionId {
  return address.kind === 'session' ? address.sessionId : address.childSessionId
}

/**
 * Reject an address that does not match the observed Session.
 * @param address - ordinary Session or direct-subagent address.
 * @param header - observed Session header.
 * @param inheritedEventCount - observed fork-inherited event count.
 * @param projections - observed projections; subagent addresses require them.
 */
export function validateAddress(
  address: SessionAddress,
  header: SessionHeader,
  inheritedEventCount: SessionLogOffsetType,
  projections: SessionObservation['projections'],
): void {
  if (address.kind === 'session') {
    if (header.origin === 'subagent') {
      throw new RemoteError('session/agent-busy', 'subagent Sessions require their durable parent address', {
        reason: 'use subagent delivery for this child session',
      })
    }
    return
  }
  if (header.origin !== 'subagent' || header.parentSession !== address.parentSessionId) {
    throw new RemoteError('subagent/unauthorized', 'subagent does not belong to the supplied parent', {
      childSessionId: address.childSessionId,
    })
  }
  const identity = projections?.values.subagent
  if (identity === null) {
    throw new RemoteError('subagent/catalog-diagnostic', 'subagent descriptor is corrupt', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'corrupt',
    })
  }
  if (identity === undefined || identity.seq < inheritedEventCount) {
    throw new RemoteError('subagent/catalog-diagnostic', 'subagent descriptor is unavailable', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'unsupported',
    })
  }
  if (address.mode !== 'unknown' && identity.mode !== address.mode) {
    throw new RemoteError('subagent/unauthorized', 'subagent mode does not match the supplied address', {
      childSessionId: address.childSessionId,
    })
  }
}

/**
 * Reject a missing Session using its address-specific error.
 * @param address - ordinary Session or direct-subagent address.
 * @returns never; this operation always throws.
 * @throws RemoteError `session/not-found` or `subagent/not-found`.
 */
export function rejectNotFound(address: SessionAddress): never {
  if (address.kind === 'session') {
    throw new RemoteError('session/not-found', `session "${address.sessionId}" not found`, { sessionId: address.sessionId })
  }
  throw new RemoteError('subagent/not-found', 'subagent is unavailable', {
    parentSessionId: address.parentSessionId,
    childSessionId: address.childSessionId,
  })
}

/**
 * Cut one message-aligned backwards page from a contiguous event prefix.
 * @param events - contiguous events starting at seq 0.
 * @param beforeSeq - exclusive upper offset of an older page.
 * @param maxMessages - message budget.
 * @param throughSeq - inclusive log cut.
 * @param turnWindow - optional turn-boundary stop rule.
 * @returns the page events and whether older events remain.
 */
export function paginate(
  events: readonly SessionEvent[],
  beforeSeq: SessionLogOffsetType | undefined,
  maxMessages: number,
  throughSeq: SessionSeqCursor,
  turnWindow?: SessionPageRequest['turnWindow'],
): { readonly events: SessionEvent[]; readonly hasMore: boolean } {
  const end = SessionLogOffset(Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1))
  let count = 0
  let turns = 0
  let cut = SessionLogOffset(0)
  for (let index = end - 1; index >= 0; index--) {
    const event = events[index] as SessionEvent
    if (turnWindow !== undefined && event.type === 'turn/start') {
      turns++
      if (count >= turnWindow.minMessages && turns >= turnWindow.minTurns) {
        cut = SessionLogOffset(index)
        break
      }
    }
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count++
    const sources = event.sourceEventSeqs
    let groupStart = event.seq
    if (sources !== undefined) {
      for (const source of sources) {
        if (source < groupStart) groupStart = source
      }
    }
    if (count >= maxMessages) {
      cut = SessionLogOffset(groupStart)
      break
    }
  }
  return { events: events.slice(cut, end), hasMore: cut > 0 }
}

/**
 * Convert a committed event to its wire entry.
 * @param event - committed Session event.
 * @param turnUsage - whole-turn accounting for a `turn/end`; reads that do not compute it omit the field.
 * @returns the wire event entry.
 */
export function entryFor(event: SessionEvent, turnUsage?: TurnTokenUsage | null): SessionEventEntry {
  return {
    type: 'event',
    // Session.append validates and freezes event data as JSON before publication.
    event: event as unknown as SessionWireEvent,
    ...event.type === 'turn/end' && turnUsage !== undefined ? { turnUsage } : {},
  }
}

/**
 * Encode one bounded logical page without changing its pagination cut.
 * @param events - page events.
 * @param usage - complete-turn accounting keyed by each served end sequence.
 * @returns the wire records.
 */
export function pageRecords(
  events: readonly SessionEvent[],
  usage?: ReadonlyMap<number, TurnTokenUsage | null>,
): SessionHistoryRecord[] {
  return events.map(event => entryFor(event, usage?.get(event.seq)))
}

/**
 * Encode one paginated range at the requested step detail. Under `collapsed`,
 * elidable step interiors leave the records and return as digests; retention is
 * decided over `scope`, the whole log through the cut, so a turn split across
 * pages keeps the same steps whole on each. A page that would keep nothing (a
 * one-message page inside one elidable step) is served whole instead, so every
 * page carries at least one record.
 * @param page - the contiguous page events.
 * @param scope - every event through the cut.
 * @param detail - requested step detail; omitted means `full`.
 * @param usage - complete-turn accounting keyed by each served end sequence.
 * @returns the page records, plus digests when steps were elided.
 */
export function detailPage(
  page: readonly SessionEvent[],
  scope: readonly SessionEvent[],
  detail: SessionStepDetail | undefined,
  usage: ReadonlyMap<number, TurnTokenUsage | null>,
): { readonly records: SessionHistoryRecord[]; readonly digests?: readonly StepDigest[] } {
  if (detail !== 'collapsed') return { records: pageRecords(page, usage) }
  const collapsed = collapseSteps(page, scope)
  if (collapsed.digests.length === 0 || collapsed.events.length === 0) return { records: pageRecords(page, usage) }
  return { records: coveringRecords(page, collapsed.events, usage), digests: collapsed.digests }
}

/**
 * Encode the kept events of a collapsed page so their inclusive ranges partition
 * the page's seq range: each record stands for the withheld events before it,
 * and the last record also for those after it.
 * @param page - the complete contiguous page the kept events were drawn from.
 * @param kept - the events the collapsed page serves, ascending by seq; non-empty.
 * @param usage - complete-turn accounting keyed by each served end sequence.
 * @returns records whose coverage joins end to end from the page's first seq to its last.
 */
function coveringRecords(
  page: readonly SessionEvent[],
  kept: readonly SessionEvent[],
  usage: ReadonlyMap<number, TurnTokenUsage | null>,
): SessionHistoryRecord[] {
  const pageStart = (page[0] as SessionEvent).seq
  const pageEnd = (page.at(-1) as SessionEvent).seq
  return kept.map((event, index) => {
    const from = index === 0 ? pageStart : (kept[index - 1] as SessionEvent).seq + 1
    const to = index === kept.length - 1 ? pageEnd : event.seq
    const record = entryFor(event, usage.get(event.seq))
    return from === event.seq && to === event.seq ? record : { ...record, covers: { from, to } }
  })
}

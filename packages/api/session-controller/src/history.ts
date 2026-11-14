/** Shared Session history address validation and chain-link conversion. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionLogChain } from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset as SessionLogOffsetType,
} from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { TurnTokenUsage } from '@deepseek-ai/dsh-token-meter/turn-usage'
import { DEFAULT_MAX_MESSAGES, entryFor } from './history-shared/paging.ts'
import type {
  SessionAddress,
  SessionChainLink,
  SessionEventEntry,
  SessionExpandStepsRequest,
  SessionHistoryRecord,
  SessionLineEntry,
  SessionPageRequest,
} from './types.ts'

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
 * Brand the observed log's chain link of one event position for the wire.
 * @param chain - the observed Session log chain, when the Host keeps one.
 * @param seq - event position the record stands for.
 * @returns the chain link, or `undefined` when no chain covers `seq`.
 */
export function chainLink(chain: SessionLogChain | undefined, seq: number): SessionChainLink | undefined {
  const link = chain?.linkAt(seq)
  return link === undefined ? undefined : brandString<SessionChainLink>(link)
}

/**
 * Bind a chain to the position-to-link lookup shared history code takes.
 * @param chain - the observed Session log chain, when the Host keeps one.
 * @returns the lookup, or `undefined` without a chain.
 */
export function linkAtOf(
  chain: SessionLogChain | undefined,
): ((seq: number) => SessionChainLink | undefined) | undefined {
  if (chain === undefined) return undefined
  return (seq) => {
    const link = chain.linkAt(seq)
    return link === undefined ? undefined : brandString<SessionChainLink>(link)
  }
}

const WIRE_LINE_DECODER = new TextDecoder('utf-8', { fatal: true })

/**
 * Encode one event whose stored line the chain checked as a wire line entry, or
 * as its event record when the stored bytes are not UTF-8.
 * @param event - the event the line stands for.
 * @param bytes - the checked stored line without its newline.
 * @param link - the event's Session log chain link.
 * @param usage - whole-turn accounting on a `turn/end`; `undefined` omits the field.
 * @returns the line entry, or the event entry when the bytes cannot be sent as text.
 */
export function lineEntry(
  event: SessionEvent,
  bytes: Uint8Array,
  link: SessionChainLink,
  usage: TurnTokenUsage | null | undefined,
): SessionLineEntry | SessionEventEntry {
  let line: string | undefined
  try {
    line = WIRE_LINE_DECODER.decode(bytes)
  } catch {
    // Stored JSONL lines are UTF-8 text (JSON.stringify escapes lone surrogates), so a
    // failed decode names bytes that were never a stored line of the log format.
  }
  if (line === undefined) return entryFor(event, usage, link)
  return {
    type: 'line',
    seq: event.seq,
    line,
    link,
    ...event.type === 'turn/end' && usage !== undefined ? { turnUsage: usage } : {},
  }
}

/**
 * Encode one exact interval's events as wire records, serving each event as its
 * stored line when the chain checks the backend encoding, and as an event
 * record otherwise.
 * @param events - the interval's events, ascending by seq.
 * @param usage - whole-turn accounting keyed by each served end sequence.
 * @param chain - the observed Session log chain, when the Host keeps one.
 * @returns one record per event, in event order.
 */
export function lineRecords(
  events: readonly SessionEvent[],
  usage: ReadonlyMap<number, TurnTokenUsage | null>,
  chain: SessionLogChain | undefined,
): (SessionHistoryRecord | SessionLineEntry)[] {
  return events.map((event) => {
    const bytes = chain?.storedLine?.(event)
    const link = chainLink(chain, event.seq)
    if (bytes === undefined || link === undefined) {
      return entryFor(event, usage.get(event.seq), link)
    }
    return lineEntry(event, bytes, link, usage.get(event.seq))
  })
}

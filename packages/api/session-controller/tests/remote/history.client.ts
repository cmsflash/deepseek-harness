/** Pure history response builders for assembled Session tests. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import type {
  SessionAddress, SessionAssistantStreamBaseline, SessionChainLink, SessionFollowFrame, SessionFollowRequest,
  SessionHistoryRecord, SessionPage, SessionEventsPage, SessionProjectionBaseline, SessionWireHeader,
} from '../../src/types.ts'
import { historyRecordLastSeq } from '../../src/client/sessions/history-records.ts'

/**
 * The Session log chain link a Host sends with the record of one event. The
 * Client never interprets a link, so a distinct value shaped like a digest is
 * enough for scripted responses.
 * @param seq - event position in the log.
 * @returns 64 lowercase hexadecimal characters.
 */
export function linkFor(seq: number): SessionChainLink {
  return brandString<SessionChainLink>(seq.toString(16).padStart(64, '0'))
}

/**
 * Give every record the link of the last event it stands for.
 * @param records - records of one page, ascending.
 * @returns the same records carrying their links.
 */
export function linkRecords(records: readonly SessionHistoryRecord[]): readonly SessionHistoryRecord[] {
  return records.map(record => ({ ...record, link: linkFor(historyRecordLastSeq(record)) }))
}

/**
 * Cut a history page at the Host cursor, preserving its other fields.
 * @param page - scripted history page.
 * @param throughSeq - inclusive final sequence.
 * @returns the page without records beyond the cursor, each carrying its link.
 */
export function pageThrough(page: SessionPage, throughSeq: number): SessionEventsPage {
  return {
    ...page,
    cursor: throughSeq,
    records: linkRecords(page.records.filter(record => historyRecordLastSeq(record) <= throughSeq)),
  }
}

function wireHeader(address: SessionAddress): SessionWireHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: address.kind === 'session' ? address.sessionId : address.childSessionId,
    createdAt: 0,
    isSeeded: false,
    ...(address.kind === 'subagent' ? { origin: 'subagent', parentSession: address.parentSessionId } : {}),
  }
}

/**
 * Build the opening follow frame for a Session or addressed child.
 * @param page - history and optional projection baseline.
 * @param request - addressed follow request.
 * @param cursor - opening cursor; defaults to the history tail, or -1 when empty.
 * @param assistantStream - baseline included only when the request opts in.
 * @returns the opening frame.
 */
export function followSnapshot(
  page: SessionPage & { readonly projections?: SessionProjectionBaseline },
  request: SessionFollowRequest,
  cursor = page.records.length === 0 ? -1 : historyRecordLastSeq(page.records.at(-1)!),
  assistantStream: SessionAssistantStreamBaseline = { revision: 0 },
): Extract<SessionFollowFrame, { type: 'snapshot' }> {
  return {
    type: 'snapshot',
    header: wireHeader(request.address),
    cursor,
    records: pageThrough(page, cursor).records,
    hasMore: page.hasMore,
    ...(page.digests === undefined ? {} : { digests: page.digests }),
    projections: page.projections ?? { asOfSeq: cursor, values: {} },
    ...(request.assistantStream === true ? { assistantStream } : {}),
  }
}

/**
 * Build the opening that continues the window a follow request offers to resume.
 * @param request - addressed follow request carrying a resume point.
 * @param records - every record after the resume point.
 * @param assistantStream - baseline included only when the request opts in.
 * @returns the resumed opening, whose records carry their links.
 */
export function followResumed(
  request: SessionFollowRequest,
  records: readonly SessionHistoryRecord[],
  assistantStream: SessionAssistantStreamBaseline = { revision: 0 },
): Extract<SessionFollowFrame, { type: 'resumed' }> {
  const resume = request.resume
  if (resume === undefined) throw new Error('the follow request offers no resume point')
  const cursor = records.at(-1)?.event.seq ?? resume.afterSeq
  return {
    type: 'resumed',
    header: wireHeader(request.address),
    after: resume.afterSeq,
    cursor,
    records: linkRecords(records),
    projections: { asOfSeq: cursor, values: {} },
    ...(request.assistantStream === true ? { assistantStream } : {}),
  }
}

/** Message-aligned page cuts and wire records over one contiguous event run. */

import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { SessionLogOffset, type SessionEvent, type SessionLogOffset as SessionLogOffsetType, type SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { TurnTokenUsage } from '@deepseek-ai/dsh-token-meter/turn-usage'
import { collapseSteps } from './step-collapse.ts'
import type {
  SessionChainLink,
  SessionEventEntry,
  SessionHistoryRecord,
  SessionPageRequest,
  SessionStepDetail,
  SessionWireEvent,
  StepDigest,
} from '../types.ts'

/** Message budget applied when a history request omits `maxMessages`. */
export const DEFAULT_MAX_MESSAGES = 50
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * Cut one message-aligned backwards page from a contiguous event run.
 *
 * A stop rule keeps a message's `sourceEventSeqs` group whole over the whole
 * log, so a group whose sources start below `events[0]` is reported as
 * `truncated` rather than cut.
 * @param events - contiguous events starting at seq `firstSeq`.
 * @param beforeSeq - exclusive upper offset of an older page.
 * @param maxMessages - message budget.
 * @param throughSeq - inclusive log cut.
 * @param turnWindow - optional turn-boundary stop rule.
 * @param firstSeq - seq of `events[0]`; the log itself starts at seq 0, and the Host passes the whole log.
 * @returns the page events and whether older events remain, or `truncated` when the run does not reach far enough back to cut the page.
 */
export function paginate(
  events: readonly SessionEvent[],
  beforeSeq: SessionLogOffsetType | undefined,
  maxMessages: number,
  throughSeq: SessionSeqCursor,
  turnWindow?: SessionPageRequest['turnWindow'],
  firstSeq = 0,
): { readonly events: SessionEvent[]; readonly hasMore: boolean; readonly truncated: boolean } {
  const end = SessionLogOffset(Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1))
  let count = 0
  let turns = 0
  let cut = SessionLogOffset(firstSeq)
  let stopped = false
  for (let index = end - 1; index >= firstSeq; index--) {
    const event = events[index - firstSeq] as SessionEvent
    if (turnWindow !== undefined && event.type === 'turn/start') {
      turns++
      if (count >= turnWindow.minMessages && turns >= turnWindow.minTurns) {
        cut = SessionLogOffset(index)
        stopped = true
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
      stopped = true
      break
    }
  }
  if (firstSeq > 0 && (!stopped || cut < firstSeq)) {
    return { events: [], hasMore: false, truncated: true }
  }
  return { events: events.slice(cut - firstSeq, end - firstSeq), hasMore: cut > 0, truncated: false }
}

/**
 * Convert a committed event to its wire entry.
 * @param event - committed Session event.
 * @param turnUsage - whole-turn accounting for a `turn/end`; reads that do not compute it omit the field.
 * @param link - the event's Session log chain link, when the Host keeps a chain that covers it.
 * @returns the wire event entry.
 */
export function entryFor(
  event: SessionEvent, turnUsage?: TurnTokenUsage | null, link?: SessionChainLink,
): SessionEventEntry {
  return {
    type: 'event',
    // Session.append validates and freezes event data as JSON before publication.
    event: event as unknown as SessionWireEvent,
    ...event.type === 'turn/end' && turnUsage !== undefined ? { turnUsage } : {},
    ...link === undefined ? {} : { link },
  }
}

/**
 * Encode one bounded logical page without changing its pagination cut.
 * @param events - page events.
 * @param usage - complete-turn accounting keyed by each served end sequence.
 * @param linkAt - link of an event position, when the caller has one.
 * @returns the wire records.
 */
export function pageRecords(
  events: readonly SessionEvent[],
  usage?: ReadonlyMap<number, TurnTokenUsage | null>,
  linkAt?: (seq: number) => SessionChainLink | undefined,
): SessionHistoryRecord[] {
  return events.map(event => entryFor(event, usage?.get(event.seq), linkAt?.(event.seq)))
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
 * @param linkAt - link of an event position, when the caller has one.
 * @returns the page records, plus digests when steps were elided.
 */
export function detailPage(
  page: readonly SessionEvent[],
  scope: readonly SessionEvent[],
  detail: SessionStepDetail | undefined,
  usage: ReadonlyMap<number, TurnTokenUsage | null>,
  linkAt?: (seq: number) => SessionChainLink | undefined,
): { readonly records: SessionHistoryRecord[]; readonly digests?: readonly StepDigest[] } {
  if (detail !== 'collapsed') return { records: pageRecords(page, usage, linkAt) }
  const collapsed = collapseSteps(page, scope)
  if (collapsed.digests.length === 0 || collapsed.events.length === 0) return { records: pageRecords(page, usage, linkAt) }
  return { records: coveringRecords(page, collapsed.events, usage, linkAt), digests: collapsed.digests }
}

/**
 * Encode the kept events of a collapsed page so their inclusive ranges partition
 * the page's seq range: each record stands for the withheld events before it,
 * and the last record also for those after it.
 * @param page - the complete contiguous page the kept events were drawn from.
 * @param kept - the events the collapsed page serves, ascending by seq; non-empty.
 * @param usage - complete-turn accounting keyed by each served end sequence.
 * @param linkAt - link of an event position, when the caller has one.
 * @returns records whose coverage joins end to end from the page's first seq to its last.
 */
function coveringRecords(
  page: readonly SessionEvent[],
  kept: readonly SessionEvent[],
  usage: ReadonlyMap<number, TurnTokenUsage | null>,
  linkAt?: (seq: number) => SessionChainLink | undefined,
): SessionHistoryRecord[] {
  const pageStart = (page[0] as SessionEvent).seq
  const pageEnd = (page.at(-1) as SessionEvent).seq
  return kept.map((event, index) => {
    const from = index === 0 ? pageStart : (kept[index - 1] as SessionEvent).seq + 1
    const to = index === kept.length - 1 ? pageEnd : event.seq
    const record = entryFor(event, usage.get(event.seq), linkAt?.(to))
    return from === event.seq && to === event.seq ? record : { ...record, covers: { from, to } }
  })
}

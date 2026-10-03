/** Client range access and type narrowing for aligned Session history records. */

import type {
  SessionHistoryCoverage, SessionHistoryRecord,
} from '../../types.ts'
import type { SessionEventLikeEntry } from '../contract/events.ts'

/**
 * Narrow aligned wire records to their Client event types without allocation.
 * @param records - validated history transport records.
 * @returns the same record array with typed inner events.
 */
export function historyEntries(
  records: readonly SessionHistoryRecord[],
): readonly SessionEventLikeEntry[] {
  return records as unknown as readonly SessionEventLikeEntry[]
}

/**
 * Select only interiors covered by the captured history pages. A range read
 * may also contain a live Assistant settlement whose end frame has not arrived;
 * that event must stay owned by the Assistant stream rather than enter via splice.
 * @param records - validated full-detail records.
 * @param window - immutable window captured before the read.
 * @returns historical interiors eligible for insertion into that window.
 */
export function historyInteriorEntries(
  records: readonly SessionHistoryRecord[],
  window: readonly SessionEventLikeEntry[],
): readonly SessionEventLikeEntry[] {
  const ranges: SessionHistoryCoverage[] = []
  for (const entry of window) {
    if (entry.type !== 'event' || entry.covers === undefined) continue
    const { from, to } = entry.covers
    const { seq } = entry.event
    if (from < seq) ranges.push({ from, to: seq - 1 })
    if (to > seq) ranges.push({ from: seq + 1, to })
  }
  let index = 0
  return historyEntries(records.filter(({ event }) => {
    let range = ranges[index]
    while (range !== undefined && range.to < event.seq) range = ranges[++index]
    return range !== undefined && range.from <= event.seq
  }))
}

/**
 * Read the first logical sequence represented by one wire record, including
 * withheld events a collapsed-page record stands for.
 * @param record - validated Session event.
 * @returns inclusive first Session sequence.
 */
export function historyRecordFirstSeq(record: SessionHistoryRecord): number {
  return record.covers?.from ?? record.event.seq
}

/**
 * Read the final logical sequence represented by one wire record, including
 * withheld events a collapsed-page record stands for.
 * @param record - validated Session event.
 * @returns inclusive final Session sequence.
 */
export function historyRecordLastSeq(record: SessionHistoryRecord): number {
  return record.covers?.to ?? record.event.seq
}

/**
 * Read the first logical sequence a page's records stand for.
 * @param records - one page's records, ascending.
 * @returns the covered head, or undefined for an empty page.
 */
export function historyPageFirstSeq(records: readonly SessionHistoryRecord[]): number | undefined {
  const head = records[0]
  return head === undefined ? undefined : historyRecordFirstSeq(head)
}

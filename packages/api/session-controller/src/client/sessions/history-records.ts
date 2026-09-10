/** Client range access and type narrowing for aligned Session history records. */

import type {
  SessionHistoryRecord,
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

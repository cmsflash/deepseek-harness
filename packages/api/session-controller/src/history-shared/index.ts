/**
 * Pure history paging, step collapse and turn accounting shared by the Host
 * and the browser's local copy.
 *
 * @module @deepseek-ai/dsh-api-session-controller/history-shared
 */

export { collapseSteps, elidedEventsOfTurn, type CollapsedPage } from './step-collapse.ts'
export { HistoryTurnUsage, historyTurnUsage } from './turn-usage.ts'
export { DEFAULT_MAX_MESSAGES, paginate, entryFor, pageRecords, detailPage } from './paging.ts'
export { assertSessionWireEvent, decodeStoredLine } from './wire-event.ts'

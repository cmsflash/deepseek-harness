/** UI Workspace-owned projection of descendant counts and spend from Session summaries. */

import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-token-meter/client'

interface LineageEntry {
  readonly id: SessionId
  readonly parentId?: SessionId
  readonly origin?: 'subagent'
  readonly running: boolean
  readonly projectionValues?: SessionSummary['projectionValues']
}

/** Descendant totals for one possible parent Session. */
export interface SubagentDescendantSummary {
  readonly count: number
  readonly runningCount: number
  /** Summed {@link ownCostUsd} of every descendant. */
  readonly costUsd: number
}

/**
 * Billed spend of the attempts one Session made itself; unpriced attempts and
 * rows without usage values count as zero.
 * @param entry - Session summary carrying its current projection values.
 * @returns non-negative USD spend excluding any fork-inherited prefix.
 */
export function ownCostUsd(entry: Pick<LineageEntry, 'projectionValues'>): number {
  const values = entry.projectionValues
  // A cold row checkpointed before `ownTokenUsage` existed carries only
  // `tokenUsage`. The list serves cached values only for unseeded Sessions,
  // whose complete-log total is their own spend.
  return (values?.ownTokenUsage ?? values?.tokenUsage)?.costUsd ?? 0
}

/* jscpd:ignore-start -- UI Subagent and UI Workspace independently project their own views. */
/**
 * Index uninterrupted subagent descendants under each ancestor.
 * @param summaries - Session summaries keyed by id.
 * @returns descendant totals keyed by possible parent id.
 */
export function indexSubagentDescendants(
  summaries: Readonly<Record<SessionId, LineageEntry>>,
): ReadonlyMap<SessionId, SubagentDescendantSummary> {
  const indexed = new Map<SessionId, { count: number; runningCount: number; costUsd: number }>()
  for (const descendant of Object.values(summaries)) {
    if (descendant.origin !== 'subagent') continue
    const costUsd = ownCostUsd(descendant)
    const seen = new Set<SessionId>()
    let current: LineageEntry | undefined = descendant
    while (current?.origin === 'subagent' && current.parentId !== undefined && !seen.has(current.id)) {
      seen.add(current.id)
      const aggregate = indexed.get(current.parentId)
      if (aggregate === undefined) {
        indexed.set(current.parentId, { count: 1, runningCount: descendant.running ? 1 : 0, costUsd })
      } else {
        aggregate.count += 1
        if (descendant.running) aggregate.runningCount += 1
        aggregate.costUsd += costUsd
      }
      current = summaries[current.parentId]
    }
  }
  return indexed
}
/* jscpd:ignore-end */

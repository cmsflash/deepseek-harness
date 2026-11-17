/**
 * Session rows nested under Session rows: places the already ordered rows of
 * one list under their parents, using the parent links the Workspace model
 * publishes and the expansion the browser saved.
 */
import type { WorkspaceSessionParents } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Parent links as the Workspace model publishes them: child Session id to the Session it nests under. */
export type SessionParents = WorkspaceSessionParents

/** Saved expansion by parent Session id; an absent id reads as expanded. */
export type SessionExpansion = Readonly<Record<string, boolean>>

/** What the nesting reads from a row. */
export interface NestableRow {
  readonly id: SessionId
  readonly blank: boolean
}

/** One row placed in the nested tree of one list. */
export interface NestedSession<Row extends NestableRow> {
  readonly row: Row
  /** 0 at the top level of the list; one more than the row it nests under. */
  readonly depth: number
  /** Direct children among the list's rows, rendered or not. */
  readonly childCount: number
  /** False when the saved expansion of this row is false. */
  readonly expanded: boolean
  /** Direct children in list order; empty while `expanded` is false. */
  readonly children: readonly NestedSession<Row>[]
}

/** One list's nesting. */
export interface SessionNesting<Row extends NestableRow> {
  /** Top-level rows in list order. */
  readonly roots: readonly NestedSession<Row>[]
  /** For every nested row of the list: the row it nests under. Acyclic. */
  readonly parents: ReadonlyMap<SessionId, SessionId>
}

/** Ids of the rows that lie on a parent cycle, a self link included. Each link is followed once. */
function cycleRowIds(rows: readonly NestableRow[], sessionParents: SessionParents): Set<SessionId> {
  const onCycle = new Set<SessionId>()
  const settled = new Set<SessionId>()
  for (const row of rows) {
    const path: SessionId[] = []
    const position = new Map<SessionId, number>()
    let next: SessionId | undefined = row.id
    while (next !== undefined && !settled.has(next) && !position.has(next)) {
      position.set(next, path.length)
      path.push(next)
      next = sessionParents[next]
    }
    const loopStart = next === undefined ? undefined : position.get(next)
    if (loopStart !== undefined) for (const id of path.slice(loopStart)) onCycle.add(id)
    for (const id of path) settled.add(id)
  }
  return onCycle
}

/**
 * Nest the rows of one list under their parents.
 *
 * A row nests only under a non-blank row of the same list. A blank row, a row
 * whose parent is absent from the list, and every row on a parent cycle
 * (a self link included) stay at the top level, so no row is ever dropped.
 * A row is never re-attached to a more distant ancestor. The work grows with
 * the number of rows, not with the depth of the nesting, and no step recurses.
 * @param rows - the list's visible rows, already ordered; roots and each parent's children keep this order.
 * @param sessionParents - parent links, which may name Sessions outside the list.
 * @param expansion - saved expansion by parent Session id.
 * @returns the top-level entries and the accepted links.
 */
export function nestSessions<Row extends NestableRow>(
  rows: readonly Row[],
  sessionParents: SessionParents,
  expansion: SessionExpansion,
): SessionNesting<Row> {
  const byId = new Map(rows.map(row => [row.id, row]))
  const onCycle = cycleRowIds(rows, sessionParents)
  const parents = new Map<SessionId, SessionId>()
  const childRows = new Map<SessionId, Row[]>()
  const rootRows: Row[] = []
  for (const row of rows) {
    const parentId: SessionId | undefined = row.blank ? undefined : sessionParents[row.id]
    const parent = parentId === undefined ? undefined : byId.get(parentId)
    if (parentId === undefined || parent === undefined || parent.blank || onCycle.has(row.id)) {
      rootRows.push(row)
      continue
    }
    parents.set(row.id, parentId)
    const siblings = childRows.get(parentId)
    if (siblings === undefined) childRows.set(parentId, [row])
    else siblings.push(row)
  }
  const roots: NestedSession<Row>[] = []
  const pending = rootRows.map(row => ({ row, depth: 0, siblings: roots })).reverse()
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    const direct = childRows.get(item.row.id) ?? []
    const expanded = expansion[item.row.id] ?? true
    const children: NestedSession<Row>[] = []
    item.siblings.push({ row: item.row, depth: item.depth, childCount: direct.length, expanded, children })
    if (!expanded) continue
    for (const row of direct.toReversed()) pending.push({ row, depth: item.depth + 1, siblings: children })
  }
  return { roots, parents }
}

/**
 * Ancestors of one row inside one list's nesting, nearest first.
 * @param sessionId - the row to start from.
 * @param parents - child-to-parent links, normally the accepted links of a {@link SessionNesting}.
 * @returns the ancestor ids, each once: the walk stops where a link returns to the row or to an ancestor
 * already listed. Empty for a top-level or unknown row.
 */
export function nestingAncestorIds(sessionId: SessionId, parents: ReadonlyMap<SessionId, SessionId>): SessionId[] {
  const ancestors = new Set<SessionId>()
  for (
    let next = parents.get(sessionId);
    next !== undefined && next !== sessionId && !ancestors.has(next);
    next = parents.get(next)
  ) ancestors.add(next)
  return [...ancestors]
}

/**
 * The rendered rows of these entries in display order: each entry's row, then its rendered descendants.
 * @param entries - entries to flatten, with their rendered descendants.
 * @returns the rows, without recursion at any nesting depth.
 */
export function nestedRows<Row extends NestableRow>(entries: readonly NestedSession<Row>[]): Row[] {
  const rows: Row[] = []
  const pending = entries.toReversed()
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    rows.push(entry.row)
    pending.push(...entry.children.toReversed())
  }
  return rows
}

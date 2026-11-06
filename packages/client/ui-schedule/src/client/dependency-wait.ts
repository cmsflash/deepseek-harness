/**
 * Dependency waits as the browser shows them. A wait is an active Host task
 * whose catalog entry carries `dependencyWait`, so the shared catalog says
 * which Sessions wait and on what.
 */
import type { SessionDependencyWait, SessionDependencyWaits } from '@deepseek-ai/dsh-client-ui-session/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CatalogSnapshot } from './catalog-source.ts'

const NO_WAITS: readonly ScheduleCatalogEntry[] = []

/**
 * Select one Session's active dependency waits.
 * @param snapshot - shared Host catalog snapshot.
 * @param sessionId - Session whose waits are selected.
 * @returns its active wait tasks in catalog order; empty until a read has settled.
 */
export function sessionWaits(
  snapshot: CatalogSnapshot<ScheduleCatalogEntry>,
  sessionId: SessionId,
): readonly ScheduleCatalogEntry[] {
  if (!snapshot.settled) return NO_WAITS
  return snapshot.records.filter(record =>
    record.sessionId === sessionId && record.status === 'active' && record.dependencyWait !== undefined)
}

function waitsOf(snapshot: CatalogSnapshot<ScheduleCatalogEntry>): Map<SessionId, SessionDependencyWait> {
  const waits = new Map<SessionId, SessionDependencyWait>()
  if (!snapshot.settled) return waits
  for (const record of snapshot.records) {
    if (record.status !== 'active' || record.dependencyWait === undefined || waits.has(record.sessionId)) continue
    waits.set(record.sessionId, record.dependencyWait)
  }
  return waits
}

function sameWaits(left: SessionDependencyWaits, right: SessionDependencyWaits): boolean {
  if (left.size !== right.size) return false
  for (const [sessionId, wait] of left) {
    const other = right.get(sessionId)
    if (other === undefined || other.description !== wait.description) return false
  }
  return true
}

/**
 * Project the shared Host catalog onto the Sessions that wait on a dependency.
 * Every delivery republishes the catalog, so the snapshot keeps its identity
 * until a wait starts, ends, or changes its description.
 * @param catalog - the shared Host catalog observable.
 * @returns waits indexed by Session; a Session with several waits shows its first.
 */
export function createDependencyWaitSource(
  catalog: HostObservable<CatalogSnapshot<ScheduleCatalogEntry>>,
): HostObservable<SessionDependencyWaits> {
  let seen: CatalogSnapshot<ScheduleCatalogEntry> | undefined
  let waits: SessionDependencyWaits = new Map()
  return {
    getSnapshot: () => {
      const snapshot = catalog.getSnapshot()
      if (snapshot !== seen) {
        seen = snapshot
        const next = waitsOf(snapshot)
        if (!sameWaits(waits, next)) waits = next
      }
      return waits
    },
    subscribe: listener => catalog.subscribe(listener),
  }
}

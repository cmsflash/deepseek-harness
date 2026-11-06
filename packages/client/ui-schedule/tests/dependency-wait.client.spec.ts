import { describe, expect, it, vi } from 'vitest'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScheduleCatalogEntry, ScheduleDependencyWait, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CatalogSnapshot } from '../src/client/catalog-source.ts'
import { createDependencyWaitSource, sessionWaits } from '../src/client/dependency-wait.ts'

const WAITING = 'waiting-session' as SessionId
const OTHER = 'other-session' as SessionId

function entry(
  id: string,
  sessionId: SessionId,
  dependencyWait?: ScheduleDependencyWait,
  status: 'active' | 'inactive' = 'active',
): ScheduleCatalogEntry {
  return {
    id: id as ScheduleId, sessionId, status, kind: 'every', title: `Task ${id}`, prompt: 'Check',
    everySeconds: 3600, scheduledAt: '2099-01-01T00:00:00.000Z',
    ...(dependencyWait === undefined ? {} : { dependencyWait }),
  }
}

function snapshot(records: readonly ScheduleCatalogEntry[], settled = true): CatalogSnapshot<ScheduleCatalogEntry> {
  return { records, status: 'ready', deleting: [], settled, readRequest: 1, readSettled: settled ? 1 : 0 }
}

function catalogStore(initial: CatalogSnapshot<ScheduleCatalogEntry>) {
  let current = initial
  const listeners = new Set<() => void>()
  const observable: HostObservable<CatalogSnapshot<ScheduleCatalogEntry>> = {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    observable,
    set(next: CatalogSnapshot<ScheduleCatalogEntry>) {
      current = next
      for (const listener of listeners) listener()
    },
    listenerCount: () => listeners.size,
  }
}

describe('sessionWaits', () => {
  it('selects the Session\'s active waits and answers nothing before a read settles', () => {
    const records = [
      entry('wait', WAITING, { description: 'CI' }),
      entry('ended', WAITING, {}, 'inactive'),
      entry('plain', WAITING),
      entry('elsewhere', OTHER, {}),
    ]
    expect(sessionWaits(snapshot(records), WAITING).map(record => record.id)).toEqual(['wait'])
    expect(sessionWaits(snapshot(records, false), WAITING)).toEqual([])
  })
})

describe('createDependencyWaitSource', () => {
  it('maps each waiting Session to its first active wait and ignores ended and ordinary tasks', () => {
    const store = catalogStore(snapshot([
      entry('plain', WAITING),
      entry('ended', OTHER, { description: 'ended' }, 'inactive'),
      entry('first', WAITING, { description: 'Nico' }),
      entry('second', WAITING, { description: 'later' }),
      entry('blank', OTHER, {}),
    ]))
    const source = createDependencyWaitSource(store.observable)
    expect(source.getSnapshot()).toEqual(new Map([[WAITING, { description: 'Nico' }], [OTHER, {}]]))
  })

  it('answers no waits before the first read settles', () => {
    const source = createDependencyWaitSource(catalogStore(snapshot([entry('w', WAITING, {})], false)).observable)
    expect(source.getSnapshot()).toEqual(new Map())
  })

  it('keeps its snapshot while a republished catalog holds the same waits', () => {
    const store = catalogStore(snapshot([entry('w', WAITING, { description: 'CI' })]))
    const source = createDependencyWaitSource(store.observable)
    const first = source.getSnapshot()
    expect(source.getSnapshot()).toBe(first)
    // A delivery republishes the catalog with fresh objects for the same waits.
    store.set(snapshot([entry('w', WAITING, { description: 'CI' }), entry('plain', OTHER)]))
    expect(source.getSnapshot()).toBe(first)

    store.set(snapshot([entry('w', WAITING, { description: 'Review' })]))
    const described = source.getSnapshot()
    expect(described).not.toBe(first)
    expect(described.get(WAITING)).toEqual({ description: 'Review' })
    store.set(snapshot([entry('w', WAITING, { description: 'Review' }), entry('x', OTHER, {})]))
    expect(source.getSnapshot()).not.toBe(described)
    store.set(snapshot([entry('x', OTHER, {}), entry('y', 'third' as SessionId, {})]))
    expect([...source.getSnapshot().keys()]).toEqual([OTHER, 'third'])
  })

  it('subscribes through the catalog', () => {
    const store = catalogStore(snapshot([]))
    const source = createDependencyWaitSource(store.observable)
    const listener = vi.fn()
    const off = source.subscribe(listener)
    expect(store.listenerCount()).toBe(1)
    store.set(snapshot([entry('w', WAITING, {})]))
    expect(listener).toHaveBeenCalledOnce()
    off()
    expect(store.listenerCount()).toBe(0)
  })
})

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScheduleCatalogEntry, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CatalogSnapshot } from '../src/client/catalog-source.ts'
import { DependencyWaitMenuItem, type DependencyWaitMenuItemProps } from '../src/client/DependencyWait.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const SESSION = 'waiting-session' as SessionId

function fixed<T>(value: T): HostObservable<T> {
  return { getSnapshot: () => value, subscribe: () => () => {} }
}

function catalog(records: readonly ScheduleCatalogEntry[]): CatalogSnapshot<ScheduleCatalogEntry> {
  return { records, status: 'ready', deleting: [], settled: true, readRequest: 1, readSettled: 1 }
}

const wait: ScheduleCatalogEntry = {
  id: 'wait' as ScheduleId, sessionId: SESSION, status: 'active', kind: 'every', title: 'Dependency check',
  prompt: 'Check', everySeconds: 3600, scheduledAt: '2099-01-01T00:00:00.000Z', dependencyWait: {},
}

function workspaces(archivedSessionIds: readonly SessionId[] = []): WorkspaceSnapshot {
  return { items: [], archivedSessionIds: [...archivedSessionIds], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }
}

function renderMenuItem(options: { records?: readonly ScheduleCatalogEntry[]; archived?: boolean; zh?: boolean } = {}) {
  const setMenuOpen = vi.fn()
  const startWait = vi.fn()
  const stopWait = vi.fn()
  const props = {
    sessionId: SESSION,
    displayTitle: 'Thread',
    useMenuOpenState: () => [true, setMenuOpen] as const,
    useWorkspaces: bindSnapshotSelector(fixed(workspaces(options.archived === true ? [SESSION] : []))),
    useCatalog: bindSnapshotSelector(fixed(catalog(options.records ?? []))),
    startWait,
    stopWait,
    t: options.zh === true ? makeTranslate(zh, commonZh) : makeTranslate(en, commonEn),
  } as DependencyWaitMenuItemProps
  const view = render(<DependencyWaitMenuItem {...props} />)
  return { view, setMenuOpen, startWait, stopWait }
}

describe('DependencyWaitMenuItem', () => {
  it('starts a wait without asking anything, naming the task in the reader\'s language', () => {
    const { setMenuOpen, startWait, stopWait } = renderMenuItem({ records: [{ ...wait, sessionId: 'other' as SessionId }] })
    fireEvent.click(screen.getByRole('menuitem', { name: en['wait.menu'] }))
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(startWait).toHaveBeenCalledWith(SESSION, 'Dependency check')
    expect(stopWait).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    cleanup()

    const chinese = renderMenuItem({ zh: true })
    fireEvent.click(screen.getByRole('menuitem', { name: zh['wait.menu'] }))
    expect(chinese.startWait).toHaveBeenCalledWith(SESSION, '依赖检查')
  })

  it('stops the wait of a waiting Session', () => {
    const { setMenuOpen, startWait, stopWait } = renderMenuItem({ records: [wait] })
    fireEvent.click(screen.getByRole('menuitem', { name: en['wait.stop'] }))
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(stopWait).toHaveBeenCalledWith(SESSION)
    expect(startWait).not.toHaveBeenCalled()
  })

  it('offers nothing on an archived row', () => {
    const { view } = renderMenuItem({ records: [wait], archived: true })
    expect(view.container.textContent).toBe('')
  })
})

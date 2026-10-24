// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { EnterKeyRow } from '../src/client/settings/EnterKeyRow.tsx'
import type { EnterKeyRowProps } from '../src/client/settings/EnterKeyRow.tsx'
import { ComposerSubmissionPolicy } from '../src/client/input/submission-policy.ts'
import { en } from '../src/client/locales.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function emptySessions() {
  return bindSnapshotSelector(createSnapshotStore<SessionListState>({
    ids: [], byId: {}, phase: 'ready', projectionsBySession: {},
  }))
}

function emptyWorkspaces() {
  return bindSnapshotSelector(createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }))
}

function noPendingInteraction() {
  return bindSnapshotSelector(createSnapshotStore<SessionStatusSnapshot>(new Map()))
}

function mount() {
  const policy = new ComposerSubmissionPolicy()
  const setEnterKey = vi.fn((behavior: 'send' | 'newline') => { policy.setEnterKey(behavior) })
  const props: EnterKeyRowProps = {
    usePanelInfo: selector => selector({ activePanelId: null }),
    useSessions: emptySessions(),
    useSessionStatus: noPendingInteraction(),
    useSessionRetainInfo: () => undefined,
    useResource,
    useWorkspaces: emptyWorkspaces(),
    ...allowAllAccess,
    useEnterKey: bindSnapshotSelector(policy.enterKey),
    setEnterKey,
    t: makeTranslate(en),
  }
  render(<EnterKeyRow {...props} />)
  return { policy, setEnterKey }
}

describe('EnterKeyRow', () => {
  it('explains the browser-local scope and shows Send by default', () => {
    mount()
    expect(screen.getByText('Enter key')).toBeDefined()
    expect(screen.getByText('Applies to this browser only; with New line, send with the Send button or Cmd/Ctrl+Enter')).toBeDefined()
    expect(screen.getByRole('button', { name: /Send/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it('selects New line and follows later preference changes', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: /Send/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'New line' }))
    expect(b.setEnterKey).toHaveBeenCalledWith('newline')
    expect(screen.getByRole('button', { name: /New line/ })).toBeDefined()

    act(() => { b.policy.setEnterKey('send') })
    expect(screen.getByRole('button', { name: /Send/ })).toBeDefined()
  })
})

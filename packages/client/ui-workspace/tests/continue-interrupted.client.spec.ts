import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { describe, expect, it, vi } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { LatestTurnState } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  continuable, createInterruptedSessions, interruptedSessionIds,
} from '../src/client/session-actions/continue-interrupted.ts'

const sid = (id: string) => id as SessionId
const turn = (status: string, cancelCause: string | null = null) => ({ status, cancelCause }) as LatestTurnState
const row = (id: string, latestTurn: LatestTurnState | null = turn('error'), extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, blank: false, updatedAt: 1, retainedBy: {},
  projectionValues: { latestTurn }, ...extra,
})
const listOf = (rows: readonly SessionSummary[]): SessionListState => ({
  ids: rows.map(item => item.id),
  byId: Object.fromEntries(rows.map(item => [item.id, item])),
  phase: 'ready',
  projectionsBySession: {},
})

function bench(rows: readonly SessionSummary[], archivedSessionIds: readonly string[] = []) {
  const list = createSnapshotStore(listOf(rows))
  const workspaces = createSnapshotStore({ archivedSessionIds: archivedSessionIds.map(sid) })
  const prompt = vi.fn(async (_sessionId: SessionId) => true)
  const report = vi.fn()
  const interrupted = createInterruptedSessions(list, workspaces, prompt, report)
  return { list, workspaces, prompt, report, interrupted }
}

describe('continuable', () => {
  it('resumes failed, interrupted, and disposal-cancelled turns only', () => {
    expect(continuable(turn('error'))).toBe(true)
    expect(continuable(turn('interrupted'))).toBe(true)
    expect(continuable(turn('aborted', 'disposed'))).toBe(true)
    for (const settled of [turn('open'), turn('completed'), turn('aborted', 'user'), turn('aborted', 'parent'),
      turn('blocked'), turn('max-tokens'), turn('forked'), null, undefined]) {
      expect(continuable(settled)).toBe(false)
    }
  })
})

describe('interruptedSessionIds', () => {
  it('keeps idle, unarchived, ordinary Sessions in list order', () => {
    const list = listOf([
      row('b'),
      row('running', turn('error'), { running: true }),
      row('archived'),
      row('child', turn('error'), { origin: 'subagent' }),
      row('unknown', turn('error'), { projectionValues: {} }),
      row('a', turn('interrupted')),
    ])
    expect(interruptedSessionIds(list, new Set([sid('archived')]))).toEqual(['b', 'a'])
  })
})

describe('createInterruptedSessions', () => {
  it('keeps a snapshot until the interrupted set changes', () => {
    const b = bench([row('a'), row('done', turn('completed'))])
    const first = b.interrupted.state.getSnapshot()
    expect(first).toEqual({ sessionIds: ['a'], continuing: false })
    b.list.set(listOf([row('a'), row('done', turn('completed'), { updatedAt: 2 })]))
    expect(b.interrupted.state.getSnapshot()).toBe(first)
    b.workspaces.set({ archivedSessionIds: [sid('a')] })
    expect(b.interrupted.state.getSnapshot()).toEqual({ sessionIds: [], continuing: false })
  })

  it('notifies subscribers of list, archive, and sending changes until they unsubscribe', async () => {
    const b = bench([row('a')])
    const listener = vi.fn()
    const unsubscribe = b.interrupted.state.subscribe(listener)
    b.list.set(listOf([row('a'), row('b')]))
    b.workspaces.set({ archivedSessionIds: [sid('b')] })
    expect(listener).toHaveBeenCalledTimes(2)
    await b.interrupted.continueAll()
    expect(listener.mock.calls.length).toBeGreaterThan(2)
    listener.mockClear()
    unsubscribe()
    b.list.set(listOf([row('c')]))
    await b.interrupted.continueAll()
    expect(listener).not.toHaveBeenCalled()
  })

  it('prompts each interrupted Session in turn and hides admitted ones while sending', async () => {
    const b = bench([row('a'), row('b')])
    const seen: (readonly string[])[] = []
    b.prompt.mockImplementation(async () => {
      seen.push(b.interrupted.state.getSnapshot().sessionIds)
      expect(b.interrupted.state.getSnapshot().continuing).toBe(true)
      return true
    })
    await b.interrupted.continueAll()
    expect(b.prompt.mock.calls.map(([sessionId]) => sessionId)).toEqual(['a', 'b'])
    expect(seen).toEqual([['a', 'b'], ['b']])
    expect(b.interrupted.state.getSnapshot()).toEqual({ sessionIds: [], continuing: false })
    expect(b.report).toHaveBeenCalledExactlyOnceWith({ continued: 2, failed: 0 })
  })

  it('keeps failed Sessions offered and reports them', async () => {
    const b = bench([row('a'), row('b')])
    b.prompt.mockResolvedValueOnce(false)
    await b.interrupted.continueAll()
    expect(b.interrupted.state.getSnapshot().sessionIds).toEqual(['a'])
    expect(b.report).toHaveBeenCalledExactlyOnceWith({ continued: 1, failed: 1 })
  })

  it('skips a Session that resumed while earlier prompts were sending', async () => {
    const b = bench([row('a'), row('b')])
    b.prompt.mockImplementationOnce(async () => {
      b.list.set(listOf([row('a'), row('b', turn('error'), { running: true })]))
      return true
    })
    await b.interrupted.continueAll()
    expect(b.prompt.mock.calls.map(([sessionId]) => sessionId)).toEqual(['a'])
    expect(b.report).toHaveBeenCalledExactlyOnceWith({ continued: 1, failed: 0 })
  })

  it('ignores a second request while sending and reports nothing when no prompt went out', async () => {
    const b = bench([row('a')])
    const admitted = Promise.withResolvers<boolean>()
    b.prompt.mockReturnValueOnce(admitted.promise)
    const sending = b.interrupted.continueAll()
    await b.interrupted.continueAll()
    expect(b.prompt).toHaveBeenCalledOnce()
    admitted.resolve(true)
    await sending
    await b.interrupted.continueAll()
    expect(b.prompt).toHaveBeenCalledOnce()

    const resumed = bench([row('a')])
    resumed.prompt.mockClear()
    resumed.list.set(listOf([]))
    await resumed.interrupted.continueAll()
    expect(resumed.report).not.toHaveBeenCalled()
  })

  it('reports nothing when every target resumed before its turn', async () => {
    const b = bench([row('a')])
    const getSnapshot = b.list.getSnapshot.bind(b.list)
    // The target set is read once; the per-Session check then sees it running.
    let reads = 0
    vi.spyOn(b.list, 'getSnapshot').mockImplementation(() => {
      reads++
      return reads > 1 ? listOf([row('a', turn('error'), { running: true })]) : getSnapshot()
    })
    await b.interrupted.continueAll()
    expect(b.prompt).not.toHaveBeenCalled()
    expect(b.report).not.toHaveBeenCalled()
  })

  it('offers a continued Session again only after it has run and been interrupted anew', async () => {
    const b = bench([row('a')])
    const unwatch = b.interrupted.watch()
    await b.interrupted.continueAll()
    expect(b.interrupted.state.getSnapshot().sessionIds).toEqual([])
    // A refreshed list row still reads the old failure until the new turn starts.
    b.list.set(listOf([row('a', turn('error'))]))
    expect(b.interrupted.state.getSnapshot().sessionIds).toEqual([])
    b.list.set(listOf([row('a', turn('open'), { running: true })]))
    b.list.set(listOf([row('a', turn('error'))]))
    expect(b.interrupted.state.getSnapshot().sessionIds).toEqual(['a'])
    unwatch()
  })

  it('stops holding a continued Session that left the list', async () => {
    const b = bench([row('a')])
    const unwatch = b.interrupted.watch()
    await b.interrupted.continueAll()
    b.list.set(listOf([]))
    b.list.set(listOf([row('a')]))
    expect(b.interrupted.state.getSnapshot().sessionIds).toEqual(['a'])
    unwatch()
    await b.interrupted.continueAll()
    b.list.set(listOf([row('a', turn('open'), { running: true })]))
    b.list.set(listOf([row('a')]))
    expect(b.interrupted.state.getSnapshot().sessionIds).toEqual([])
  })
})

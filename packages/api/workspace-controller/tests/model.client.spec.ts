import { describe, expect, it, vi } from 'vitest'
import {
  ClientWorkspaceModel, type WorkspaceRemote,
} from '../src/client/index.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceFollowFrame,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceRenameRequest,
  WorkspaceSessionParentsValue,
  WorkspaceSetSessionParentRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
  WorkspaceId,
  WorkspaceView,
} from '../src/types.ts'
import { RemoteError, type RemoteFailure, type RemoteResult, type RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import { streamHandle } from '@deepseek-ai/dsh-remote-mock'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const sid = (id: string): SessionId => id as SessionId
const wid = (id: string): WorkspaceId => id as WorkspaceId

function workspace(
  id: string,
  sessionIds: readonly SessionId[] = [],
  updatedAt = '2026-01-01T00:00:00.000Z',
): WorkspaceView {
  return {
    workspaceId: wid(id),
    path: `/w/${id}`,
    title: id,
    sessionIds,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
  }
}

function remoteOk<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function workspaceError(error: RemoteFailure): RemoteResult<never> {
  return { ok: false, error }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, reject, resolve }
}

class FakeWorkspaceRemote implements WorkspaceRemote {
  readonly initializeDefault = vi.fn<WorkspaceRemote['initializeDefault']>(async () => remoteOk({ workspace: workspace('default') }))
  readonly calls: Array<{ readonly method: string; readonly request: unknown }> = []
  onCreate: (request: WorkspaceCreateRequest) => Promise<RemoteResult<WorkspaceCreateValue>> = request =>
    Promise.resolve(remoteOk({ workspace: workspace(request.path.split('/').pop() ?? 'workspace'), created: true }))
  onRename: (request: WorkspaceRenameRequest) => Promise<RemoteResult<WorkspaceValue>> = request =>
    Promise.resolve(remoteOk({ workspace: { ...workspace(String(request.workspaceId)), title: request.title } }))
  onDelete: (_request: WorkspaceDeleteRequest) => Promise<RemoteResult<WorkspaceDeleteValue>> = () =>
    Promise.resolve(remoteOk({ deleted: true }))
  onInsertBefore: (
    request: WorkspaceInsertBeforeRequest,
  ) => Promise<RemoteResult<WorkspaceOrderValue>> = request =>
    Promise.resolve(remoteOk({ workspaceIds: [request.workspaceId] }))
  onInsertSessionBefore: (
    request: WorkspaceInsertSessionBeforeRequest,
  ) => Promise<RemoteResult<WorkspaceValue>> = request => Promise.resolve(remoteOk({
    workspace: workspace(String(request.workspaceId), [request.sessionId]),
  }))
  onArchiveSession: (
    request: WorkspaceArchiveSessionRequest,
  ) => Promise<RemoteResult<WorkspaceArchiveValue>> = request =>
    Promise.resolve(remoteOk({ archivedSessionIds: [request.sessionId] }))
  onUnarchiveSession: (
    request: WorkspaceUnarchiveSessionRequest,
  ) => Promise<RemoteResult<WorkspaceArchiveValue>> = request =>
    Promise.resolve(remoteOk({ archivedSessionIds: [request.sessionId] }))
  onPinSession: (
    request: WorkspacePinSessionRequest,
  ) => Promise<RemoteResult<WorkspacePinValue>> = request =>
    Promise.resolve(remoteOk({ pinnedSessionIds: [request.sessionId] }))
  onUnpinSession: (
    _request: WorkspaceUnpinSessionRequest,
  ) => Promise<RemoteResult<WorkspacePinValue>> = () =>
    Promise.resolve(remoteOk({ pinnedSessionIds: [] }))
  onSetSessionParent: (
    request: WorkspaceSetSessionParentRequest,
  ) => Promise<RemoteResult<WorkspaceSessionParentsValue>> = request => Promise.resolve(remoteOk({
    sessionParents: request.parentSessionId === null ? {} : { [request.sessionId]: request.parentSessionId },
  }))

  create(request: WorkspaceCreateRequest): Promise<RemoteResult<WorkspaceCreateValue>> {
    this.record('create', request)
    return this.onCreate(request)
  }

  rename(request: WorkspaceRenameRequest): Promise<RemoteResult<WorkspaceValue>> {
    this.record('rename', request)
    return this.onRename(request)
  }

  delete(request: WorkspaceDeleteRequest): Promise<RemoteResult<WorkspaceDeleteValue>> {
    this.record('delete', request)
    return this.onDelete(request)
  }

  insertBefore(request: WorkspaceInsertBeforeRequest): Promise<RemoteResult<WorkspaceOrderValue>> {
    this.record('insertBefore', request)
    return this.onInsertBefore(request)
  }

  insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<RemoteResult<WorkspaceValue>> {
    this.record('insertSessionBefore', request)
    return this.onInsertSessionBefore(request)
  }

  archiveSession(request: WorkspaceArchiveSessionRequest): Promise<RemoteResult<WorkspaceArchiveValue>> {
    this.record('archiveSession', request)
    return this.onArchiveSession(request)
  }

  unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<RemoteResult<WorkspaceArchiveValue>> {
    this.record('unarchiveSession', request)
    return this.onUnarchiveSession(request)
  }

  pinSession(request: WorkspacePinSessionRequest): Promise<RemoteResult<WorkspacePinValue>> {
    this.record('pinSession', request)
    return this.onPinSession(request)
  }

  unpinSession(request: WorkspaceUnpinSessionRequest): Promise<RemoteResult<WorkspacePinValue>> {
    this.record('unpinSession', request)
    return this.onUnpinSession(request)
  }

  setSessionParent(request: WorkspaceSetSessionParentRequest): Promise<RemoteResult<WorkspaceSessionParentsValue>> {
    this.record('setSessionParent', request)
    return this.onSetSessionParent(request)
  }

  follow(_signal?: AbortSignal): RemoteStreamHandle<WorkspaceFollowFrame, never> {
    return streamHandle<WorkspaceFollowFrame>((async function* () {})())
  }

  private record(method: string, request: unknown): void {
    this.calls.push({ method, request })
  }
}

function modelFor(remote = new FakeWorkspaceRemote()): ClientWorkspaceModel {
  return new ClientWorkspaceModel(remote)
}

function baseline(
  model: ClientWorkspaceModel,
  items: readonly WorkspaceView[] = [],
  archivedSessionIds: readonly SessionId[] = [],
  pinnedSessionIds: readonly SessionId[] = [],
): void {
  model.replaceBaseline({ items, archivedSessionIds, pinnedSessionIds })
}

describe('ClientWorkspaceModel', () => {
  it('publishes the prepared Workspace and leaves the list unchanged on refusal', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model)
    const signal = new AbortController().signal
    await expect(model.initializeDefault(signal)).resolves.toMatchObject({ ok: true })
    expect(remote.initializeDefault).toHaveBeenCalledWith(signal)
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['default'])
    const before = model.getSnapshot()
    remote.initializeDefault.mockResolvedValueOnce(remoteOk(undefined))
    await expect(model.initializeDefault())
      .resolves.toEqual({ ok: true, value: undefined })
    expect(model.getSnapshot()).toBe(before)
    remote.initializeDefault.mockResolvedValueOnce(workspaceError(
      new RemoteError('gateway/bad-request', 'choose a folder', {}),
    ))
    await expect(model.initializeDefault()).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot()).toBe(before)
  })

  it('replaces reconnect state and applies ordered increments', () => {
    const model = modelFor()
    expect(model.getSnapshot()).toMatchObject({ phase: 'pending', state: 'loading' })
    baseline(model, [workspace('old'), workspace('kept')])
    model.upsertView(workspace('new'))
    model.replaceOrder([wid('kept'), wid('new'), wid('old')])
    model.replaceArchived([sid('hidden')])
    model.removeView(wid('old'))
    expect(model.getSnapshot()).toMatchObject({ phase: 'ready', state: 'idle', archivedSessionIds: ['hidden'] })
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['kept', 'new'])

    baseline(model, [workspace('fresh')])
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['fresh'])
    expect(model.getSnapshot().archivedSessionIds).toEqual([])
  })

  it('keeps the last baseline during retry and exposes a terminal stream failure', () => {
    const model = modelFor()
    baseline(model, [workspace('visible')])
    model.handleCarrierFailure()
    expect(model.getSnapshot()).toMatchObject({ phase: 'ready', state: 'loading', error: null })
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['visible'])
    model.handleStreamFailure(new RemoteError('gateway/internal', 'wire down', {}))
    expect(model.getSnapshot()).toMatchObject({
      phase: 'ready', state: 'error', error: { code: 'gateway/internal', message: 'wire down' },
    })
    // An unmarked value never crosses the stream boundary: it is a local fault.
    expect(() => { model.handleStreamFailure('plain failure') }).toThrow()
    baseline(model, [workspace('restored')])
    expect(model.getSnapshot()).toMatchObject({ phase: 'ready', state: 'idle', error: null })
  })

  it('creates by path and prepends the returned row', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    remote.onCreate = request => Promise.resolve(remoteOk({
      workspace: workspace('created', [], '2026-02-01T00:00:00.000Z'),
      created: request.path === '/w/created',
    }))
    await expect(model.create({ path: '/w/created' })).resolves.toMatchObject({ ok: true })
    expect(remote.calls).toContainEqual({ method: 'create', request: { path: '/w/created' } })
    expect(model.getSnapshot().items[0]?.workspaceId).toBe('created')
  })

  it('lets newer stream order outrank unary echoes and rolls failures back', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [workspace('one'), workspace('two'), workspace('three')])

    const gate = deferred<RemoteResult<WorkspaceOrderValue>>()
    remote.onInsertBefore = () => gate.promise
    const pending = model.insertBefore(wid('three'), wid('one'))
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['three', 'one', 'two'])
    model.replaceOrder([wid('one'), wid('three'), wid('two')])
    gate.resolve(remoteOk({ workspaceIds: [wid('three'), wid('one'), wid('two')] }))
    await pending
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['one', 'three', 'two'])

    remote.onInsertBefore = () => Promise.resolve(workspaceError(
      new RemoteError('workspace/not-found', 'gone', { workspaceId: wid('three') }),
    ))
    const rejected = model.insertBefore(wid('three'))
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['one', 'two', 'three'])
    await expect(rejected).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['one', 'three', 'two'])
  })

  it('keeps a newer optimistic reorder when an older refused call settles', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [workspace('one'), workspace('two'), workspace('three')])
    const firstGate = deferred<RemoteResult<WorkspaceOrderValue>>()
    const secondGate = deferred<RemoteResult<WorkspaceOrderValue>>()
    let request = 0
    remote.onInsertBefore = () => request++ === 0 ? firstGate.promise : secondGate.promise

    const first = model.insertBefore(wid('three'), wid('one'))
    const second = model.insertBefore(wid('two'), wid('three'))
    firstGate.resolve(workspaceError(
      new RemoteError('workspace/not-found', 'first refused', { workspaceId: wid('three') }),
    ))
    await expect(first).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['two', 'three', 'one'])
    secondGate.resolve(remoteOk({ workspaceIds: [wid('two'), wid('three'), wid('one')] }))
    await expect(second).resolves.toMatchObject({ ok: true })
  })

  it('rolls overlapping rejected reorders back to the last Host order', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [workspace('one'), workspace('two'), workspace('three')])
    const firstGate = deferred<RemoteResult<WorkspaceOrderValue>>()
    const secondGate = deferred<RemoteResult<WorkspaceOrderValue>>()
    let request = 0
    remote.onInsertBefore = () => request++ === 0 ? firstGate.promise : secondGate.promise

    const first = model.insertBefore(wid('three'), wid('one'))
    const second = model.insertBefore(wid('two'), wid('three'))
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['two', 'three', 'one'])
    firstGate.resolve(workspaceError(new RemoteError('workspace/not-found', 'first rejected', { workspaceId: wid('three') })))
    await expect(first).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['two', 'three', 'one'])
    secondGate.resolve(workspaceError(new RemoteError('workspace/not-found', 'second rejected', { workspaceId: wid('two') })))
    await expect(second).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['one', 'two', 'three'])
  })

  it('retains removal tombstones across later baselines', () => {
    const model = modelFor()
    baseline(model, [workspace('gone'), workspace('kept')])
    model.removeView(wid('gone'))
    model.removeView(wid('gone'))
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['kept'])
    baseline(model, [workspace('gone')])
    expect(model.getSnapshot().items).toEqual([])
  })

  it('does not let delayed unary data resurrect a removed Workspace', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [workspace('gone')])
    const gate = deferred<RemoteResult<WorkspaceValue>>()
    remote.onRename = () => gate.promise
    const rename = model.rename(wid('gone'), 'late')
    model.removeView(wid('gone'))
    gate.resolve(remoteOk({ workspace: { ...workspace('gone'), title: 'late' } }))
    await expect(rename).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().items).toEqual([])
  })

  it('applies Workspace mutation echoes and leaves failed results unchanged', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [workspace('one', [sid('first'), sid('second')])], [sid('archived')])

    remote.onRename = () => Promise.resolve(workspaceError(new RemoteError('workspace/not-found', 'gone', { workspaceId: wid('one') })))
    await expect(model.rename(wid('one'), 'ignored')).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().items[0]?.title).toBe('one')

    remote.onDelete = () => Promise.resolve(workspaceError(new RemoteError('workspace/not-found', 'gone', { workspaceId: wid('one') })))
    await expect(model.delete(wid('one'))).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().items).toHaveLength(1)

    remote.onInsertSessionBefore = request => Promise.resolve(remoteOk({
      workspace: workspace('one', [request.sessionId, sid('first')], '2026-02-01T00:00:00.000Z'),
    }))
    await expect(model.insertSessionBefore(wid('one'), sid('second'), sid('first')))
      .resolves.toMatchObject({ ok: true })
    expect(remote.calls).toContainEqual({
      method: 'insertSessionBefore',
      request: { workspaceId: 'one', sessionId: 'second', beforeSessionId: 'first' },
    })

    remote.onInsertSessionBefore = () => Promise.resolve(workspaceError(
      new RemoteError('workspace/move-invalid', 'invalid move', { workspaceId: wid('one'), sessionId: sid('second') }),
    ))
    await expect(model.insertSessionBefore(wid('one'), sid('second')))
      .resolves.toMatchObject({ ok: false })
    expect(remote.calls).toContainEqual({
      method: 'insertSessionBefore',
      request: { workspaceId: 'one', sessionId: 'second' },
    })

    remote.onArchiveSession = () => Promise.resolve(workspaceError(
      new RemoteError('session/not-found', 'missing', { sessionId: sid('missing') }),
    ))
    await expect(model.archiveSession(sid('missing'))).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().archivedSessionIds).toEqual(['archived'])
    remote.onArchiveSession = request => Promise.resolve(remoteOk({ archivedSessionIds: [request.sessionId] }))
    await expect(model.archiveSession(sid('fresh'))).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual(['fresh'])

    remote.onUnarchiveSession = () => Promise.resolve(workspaceError(
      new RemoteError('session/not-found', 'missing', { sessionId: sid('missing') }),
    ))
    await expect(model.unarchiveSession(sid('missing'))).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().archivedSessionIds).toEqual(['fresh'])
    remote.onUnarchiveSession = () => Promise.resolve(remoteOk({ archivedSessionIds: [] }))
    await expect(model.unarchiveSession(sid('fresh'))).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual([])
    expect(remote.calls).toContainEqual({ method: 'unarchiveSession', request: { sessionId: 'fresh' } })
  })

  it('keeps the latest unarchive reply when overlapping requests settle out of order', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [], [sid('first'), sid('second')])
    const firstGate = deferred<RemoteResult<WorkspaceArchiveValue>>()
    const secondGate = deferred<RemoteResult<WorkspaceArchiveValue>>()
    let request = 0
    remote.onUnarchiveSession = () => request++ === 0 ? firstGate.promise : secondGate.promise

    const first = model.unarchiveSession(sid('first'))
    const second = model.unarchiveSession(sid('second'))
    secondGate.resolve(remoteOk({ archivedSessionIds: [] }))
    await expect(second).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual([])
    firstGate.resolve(remoteOk({ archivedSessionIds: [sid('second')] }))
    await expect(first).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual([])
  })

  it('keeps a pushed archive set when an unarchive reply lands later', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [], [sid('first')])
    const gate = deferred<RemoteResult<WorkspaceArchiveValue>>()
    remote.onUnarchiveSession = () => gate.promise

    const pending = model.unarchiveSession(sid('first'))
    model.replaceArchived([sid('first'), sid('second')])
    gate.resolve(remoteOk({ archivedSessionIds: [] }))
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual(['first', 'second'])
  })

  it('keeps the latest archive reply when overlapping requests settle out of order', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    const firstGate = deferred<RemoteResult<WorkspaceArchiveValue>>()
    const secondGate = deferred<RemoteResult<WorkspaceArchiveValue>>()
    let request = 0
    remote.onArchiveSession = () => request++ === 0 ? firstGate.promise : secondGate.promise

    const first = model.archiveSession(sid('first'))
    const second = model.archiveSession(sid('second'))
    secondGate.resolve(remoteOk({ archivedSessionIds: [sid('first'), sid('second')] }))
    await expect(second).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual(['first', 'second'])
    firstGate.resolve(remoteOk({ archivedSessionIds: [sid('first')] }))
    await expect(first).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual(['first', 'second'])
  })

  it('keeps a baseline archive set when an unarchive reply lands later', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [], [sid('first')])
    const gate = deferred<RemoteResult<WorkspaceArchiveValue>>()
    remote.onUnarchiveSession = () => gate.promise

    const pending = model.unarchiveSession(sid('first'))
    baseline(model, [], [sid('second')])
    gate.resolve(remoteOk({ archivedSessionIds: [] }))
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual(['second'])
  })

  it('applies pin mutation echoes and leaves failed results unchanged', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [], [], [sid('kept')])

    remote.onPinSession = () => Promise.resolve(workspaceError(
      new RemoteError('session/not-found', 'missing', { sessionId: sid('missing') }),
    ))
    await expect(model.pinSession(sid('missing'))).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().pinnedSessionIds).toEqual(['kept'])
    remote.onPinSession = request => Promise.resolve(remoteOk({
      pinnedSessionIds: [request.sessionId, sid('kept')],
    }))
    await expect(model.pinSession(sid('fresh'))).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().pinnedSessionIds).toEqual(['fresh', 'kept'])
    expect(remote.calls).toContainEqual({ method: 'pinSession', request: { sessionId: 'fresh' } })

    remote.onUnpinSession = () => Promise.resolve(workspaceError(
      new RemoteError('gateway/internal', 'wire down', {}),
    ))
    await expect(model.unpinSession(sid('fresh'))).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().pinnedSessionIds).toEqual(['fresh', 'kept'])
    remote.onUnpinSession = () => Promise.resolve(remoteOk({ pinnedSessionIds: [sid('kept')] }))
    await expect(model.unpinSession(sid('fresh'))).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().pinnedSessionIds).toEqual(['kept'])
    expect(remote.calls).toContainEqual({ method: 'unpinSession', request: { sessionId: 'fresh' } })

    const before = model.getSnapshot()
    model.replacePinned([sid('kept')])
    expect(model.getSnapshot()).toBe(before)
    model.replacePinned([sid('other')])
    expect(model.getSnapshot()).not.toBe(before)
    expect(model.getSnapshot().pinnedSessionIds).toEqual([sid('other')])
  })

  it('keeps the latest pin reply when overlapping requests settle out of order', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    const firstGate = deferred<RemoteResult<WorkspacePinValue>>()
    const secondGate = deferred<RemoteResult<WorkspacePinValue>>()
    let request = 0
    remote.onPinSession = () => request++ === 0 ? firstGate.promise : secondGate.promise

    const first = model.pinSession(sid('first'))
    const second = model.pinSession(sid('second'))
    secondGate.resolve(remoteOk({ pinnedSessionIds: [sid('second'), sid('first')] }))
    await expect(second).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().pinnedSessionIds).toEqual(['second', 'first'])
    firstGate.resolve(remoteOk({ pinnedSessionIds: [sid('first')] }))
    await expect(first).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().pinnedSessionIds).toEqual(['second', 'first'])
  })

  it('keeps a pushed pin set when an unpin reply lands later', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [], [], [sid('first')])
    const gate = deferred<RemoteResult<WorkspacePinValue>>()
    remote.onUnpinSession = () => gate.promise

    const pending = model.unpinSession(sid('first'))
    model.replacePinned([sid('first'), sid('second')])
    gate.resolve(remoteOk({ pinnedSessionIds: [] }))
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().pinnedSessionIds).toEqual(['first', 'second'])
  })

  it('installs parent links from a baseline and treats an absent field as no links', () => {
    const model = modelFor()
    expect(model.getSnapshot().sessionParents).toEqual({})
    model.replaceBaseline({
      items: [], archivedSessionIds: [], pinnedSessionIds: [], sessionParents: { [sid('child')]: sid('parent') },
    })
    expect(model.getSnapshot().sessionParents).toEqual({ child: 'parent' })
    model.replaceBaseline({ items: [], archivedSessionIds: [], pinnedSessionIds: [] })
    expect(model.getSnapshot().sessionParents).toEqual({})
  })

  it('replaces pushed parent links and keeps the map reference when no entry changed', async () => {
    const model = modelFor()
    model.replaceParents({ [sid('child')]: sid('parent') })
    const before = model.getSnapshot()
    expect(before.sessionParents).toEqual({ child: 'parent' })

    model.replaceParents({ [sid('child')]: sid('parent') })
    expect(model.getSnapshot()).toBe(before)
    model.replaceArchived([sid('archived')])
    expect(model.getSnapshot()).not.toBe(before)
    expect(model.getSnapshot().sessionParents).toBe(before.sessionParents)

    model.replaceParents({ [sid('child')]: sid('other') })
    expect(model.getSnapshot().sessionParents).toEqual({ child: 'other' })
    model.replaceParents({ [sid('second')]: sid('other') })
    expect(model.getSnapshot().sessionParents).toEqual({ second: 'other' })
    model.replaceParents({ [sid('second')]: sid('other'), [sid('child')]: sid('other') })
    expect(model.getSnapshot().sessionParents).toEqual({ second: 'other', child: 'other' })
  })

  it('keeps the sessionParents object across equal maps and unrelated changes', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    const links = (): Record<SessionId, SessionId> => ({ [sid('b')]: sid('a') })
    const row = workspace('one')
    model.replaceBaseline({ items: [row], archivedSessionIds: [], pinnedSessionIds: [], sessionParents: links() })
    const held = model.getSnapshot().sessionParents
    expect(held).toEqual({ b: 'a' })

    model.replaceParents(links())
    expect(model.getSnapshot().sessionParents).toBe(held)
    model.replaceBaseline({ items: [row], archivedSessionIds: [], pinnedSessionIds: [], sessionParents: links() })
    expect(model.getSnapshot().sessionParents).toBe(held)
    remote.onSetSessionParent = () => Promise.resolve(remoteOk({ sessionParents: links() }))
    await expect(model.setSessionParent(sid('b'), sid('a'))).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().sessionParents).toBe(held)

    const unrelated: Array<() => void> = [
      () => { model.upsertView({ ...row, title: 'renamed', updatedAt: '2099-01-01T00:00:00.000Z' }) },
      () => { model.upsertView(workspace('two')) },
      () => { model.replacePinned([sid('a')]) },
      () => { model.replaceArchived([sid('b')]) },
      () => { model.replaceOrder([wid('one'), wid('two')]) },
    ]
    for (const change of unrelated) {
      const before = model.getSnapshot()
      change()
      expect(model.getSnapshot()).not.toBe(before)
      expect(model.getSnapshot().sessionParents).toBe(held)
    }

    model.replaceParents({ [sid('b')]: sid('c') })
    expect(model.getSnapshot().sessionParents).not.toBe(held)
    expect(model.getSnapshot().sessionParents).toEqual({ b: 'c' })
  })

  it('applies parent mutation echoes and leaves failed results unchanged', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    model.replaceParents({ [sid('kept')]: sid('parent') })

    remote.onSetSessionParent = () => Promise.resolve(workspaceError(
      new RemoteError('workspace/session-parent-invalid', 'cannot nest', {
        sessionId: sid('parent'), parentSessionId: sid('kept'), reason: 'cycle',
      }),
    ))
    await expect(model.setSessionParent(sid('parent'), sid('kept'))).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().sessionParents).toEqual({ kept: 'parent' })

    remote.onSetSessionParent = request => Promise.resolve(remoteOk({
      sessionParents: { [sid('kept')]: sid('parent'), [request.sessionId]: sid('parent') },
    }))
    await expect(model.setSessionParent(sid('fresh'), sid('parent'))).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().sessionParents).toEqual({ kept: 'parent', fresh: 'parent' })
    expect(remote.calls).toContainEqual({
      method: 'setSessionParent', request: { sessionId: 'fresh', parentSessionId: 'parent' },
    })

    remote.onSetSessionParent = () => Promise.resolve(remoteOk({ sessionParents: { [sid('kept')]: sid('parent') } }))
    await expect(model.setSessionParent(sid('fresh'), null)).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().sessionParents).toEqual({ kept: 'parent' })
    expect(remote.calls).toContainEqual({
      method: 'setSessionParent', request: { sessionId: 'fresh', parentSessionId: null },
    })
  })

  it('keeps the latest parent reply when overlapping requests settle out of order', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    const firstGate = deferred<RemoteResult<WorkspaceSessionParentsValue>>()
    const secondGate = deferred<RemoteResult<WorkspaceSessionParentsValue>>()
    let request = 0
    remote.onSetSessionParent = () => request++ === 0 ? firstGate.promise : secondGate.promise

    const first = model.setSessionParent(sid('first'), sid('parent'))
    const second = model.setSessionParent(sid('second'), sid('parent'))
    secondGate.resolve(remoteOk({ sessionParents: { [sid('first')]: sid('parent'), [sid('second')]: sid('parent') } }))
    await expect(second).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().sessionParents).toEqual({ first: 'parent', second: 'parent' })
    firstGate.resolve(remoteOk({ sessionParents: { [sid('first')]: sid('parent') } }))
    await expect(first).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().sessionParents).toEqual({ first: 'parent', second: 'parent' })
  })

  it('keeps pushed parent links and a newer baseline when a parent reply lands later', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    const pushGate = deferred<RemoteResult<WorkspaceSessionParentsValue>>()
    remote.onSetSessionParent = () => pushGate.promise
    const overPush = model.setSessionParent(sid('first'), null)
    model.replaceParents({ [sid('first')]: sid('parent'), [sid('second')]: sid('parent') })
    pushGate.resolve(remoteOk({ sessionParents: {} }))
    await expect(overPush).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().sessionParents).toEqual({ first: 'parent', second: 'parent' })

    const baselineGate = deferred<RemoteResult<WorkspaceSessionParentsValue>>()
    remote.onSetSessionParent = () => baselineGate.promise
    const overBaseline = model.setSessionParent(sid('first'), null)
    model.replaceBaseline({
      items: [], archivedSessionIds: [], pinnedSessionIds: [], sessionParents: { [sid('first')]: sid('other') },
    })
    baselineGate.resolve(remoteOk({ sessionParents: {} }))
    await expect(overBaseline).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().sessionParents).toEqual({ first: 'other' })
  })

  it('mirrors the Host pin drop locally when an archive echo lands', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [], [], [sid('pinned'), sid('kept')])

    await expect(model.archiveSession(sid('pinned'))).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual(['pinned'])
    expect(model.getSnapshot().pinnedSessionIds).toEqual(['kept'])
  })

  it('keeps the newest row and places Workspaces missing from partial orders last', async () => {
    const model = modelFor()
    baseline(model, [
      workspace('one', [], '2026-02-01T00:00:00.000Z'),
      workspace('two'),
    ])
    model.upsertView(workspace('one', [], '2025-12-01T00:00:00.000Z'))
    expect(model.getSnapshot().items[0]?.updatedAt).toBe('2026-02-01T00:00:00.000Z')
    model.upsertView(workspace('one', [sid('new')], '2026-03-01T00:00:00.000Z'))
    expect(model.getSnapshot().items[0]?.sessionIds).toEqual(['new'])

    model.replaceOrder([wid('one')])
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['one', 'two'])
    model.replaceOrder([wid('two')])
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['two', 'one'])
    model.replaceOrder([wid('one')])
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['one', 'two'])

    await expect(model.insertBefore(wid('one'), wid('one'))).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['one', 'two'])
  })

  it('notifies subscribers and cancels a queued notification after an immediate delete echo', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [workspace('gone')])
    await Promise.resolve()
    const listener = vi.fn()
    const unsubscribe = model.subscribe(listener)

    const deletion = model.delete(wid('gone'))
    model.removeView(wid('gone'))
    await expect(deletion).resolves.toMatchObject({ ok: true })
    expect(listener).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledOnce()

    unsubscribe()
    model.handleCarrierFailure()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledOnce()
  })

  it('removes from a unary delete echo before the operation resolves', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [workspace('gone')])
    await expect(model.delete(wid('gone'))).resolves.toMatchObject({ ok: true })
    expect(remote.calls).toContainEqual({ method: 'delete', request: { workspaceId: 'gone' } })
    expect(model.getSnapshot().items).toEqual([])
    model.removeView(wid('gone'))
    expect(model.getSnapshot().items).toEqual([])
  })
})

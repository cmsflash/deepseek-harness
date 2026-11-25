import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError, type PeerId, type Principal, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import RemoteAccessService, { type RemoteAccessCondition, type RemoteAccessRole } from '@deepseek-ai/dsh-api-remote-access'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access'
import WorkspaceController from '../src/index.ts'
import { DEFAULT_WORKSPACE_DIRECTORY } from '../src/default-workspace.ts'
import { WorkspaceFeed } from '../src/feed.ts'
import type { WorkspaceFollowFrame } from '../src/types.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

// The controller relays whatever families the providers report; this suite merges its own.
declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    probe: true
    'probe-items': true
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'fixture/failure': {}
  }
}

const roots: Context[] = []

/** Workspace roots created per test, removed after their context settles. */
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

async function harness(options: { systemDocuments?: boolean; gateway?: boolean } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-workspace-controller-')))
  tempDirs.push(root)
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend()
  ctx.storage.backend.register('memory', backend)
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)
  const dispose = (): void => {}
  if (options.gateway === true) {
    await ctx.plugin(TypertRegistry)
    ctx.typert.resources.register('session', { field: 'sessionId' })
  } else ctx.provide('typert', {
    lookups: { configure: () => dispose },
    contexts: { configureHost: () => dispose },
    resources: { register: vi.fn(() => dispose) },
  } as never)
  new RemoteAccessService(ctx)
  const controller = new WorkspaceController(ctx, options.systemDocuments === true ? {} : { documentsDirectory: root })
  if (options.gateway === true) await ctx.plugin(TypertGatewayService)
  return { controller, ctx, root, storageDomain, pool: backend.pool }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller shared by the access specs. */
    'test-guest': { readonly kind: 'test-guest'; readonly guest: string }
  }
}

/** Opens the Workspace follow stream; each Workspace and Session in it still needs its own role. */
const FOLLOWER: RemoteAccessRole<'global'> = { name: 'test:workspace-follower', resource: 'global', actions: ['workspace/follow'] }
/** Shows one Workspace in the follow stream. */
const WORKSPACE_VIEWER: RemoteAccessRole<'workspace'> = { name: 'test:workspace-viewer', resource: 'workspace', actions: ['workspace/follow'] }
/** Shows one Session id in the follow stream. */
const SESSION_VIEWER: RemoteAccessRole<'session'> = { name: 'test:session-viewer', resource: 'session', actions: ['workspace/follow'] }

/** The Context a Gateway dispatch of `workspace/follow` binds for `principal`. */
function followerContext(ctx: Context, principal: Principal): Context {
  const invocation: RemoteInvocation = {
    request: { namespace: 'workspace', method: 'follow', args: {} },
    service: 'workspaceController',
    peer: { id: 'workspace-access-peer' as PeerId, ctx, principal, interactions: 'answer', signal: new AbortController().signal, dispose: async () => {} },
    signal: new AbortController().signal,
    uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
  }
  return ctx.extend({ invocation })
}

function stageDir(root: string, name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}

async function nextFrame(
  iterator: AsyncIterator<WorkspaceFollowFrame>,
): Promise<WorkspaceFollowFrame> {
  const next = await iterator.next()
  if (next.done === true) throw new Error('Workspace stream ended before the expected frame')
  return next.value
}

describe('WorkspaceController commands', () => {
  it('serializes concurrent path adoption and preserves an existing title', async () => {
    const { controller, root } = await harness()
    const path = stageDir(root, 'alpha')
    const results = await Promise.all([
      controller.create({ path }),
      controller.create({ path }),
    ])
    const created = results.find(result => result.created)
    const resolved = results.find(result => !result.created)
    expect(created).toMatchObject({ workspace: { path, title: 'alpha' } })
    expect(resolved?.workspace.workspaceId).toBe(created?.workspace.workspaceId)

    const workspaceId = created?.workspace.workspaceId
    if (workspaceId === undefined) throw new Error('fixture did not create a Workspace')
    await controller.rename({ workspaceId, title: 'renamed' })
    await expect(controller.create({ path })).resolves.toMatchObject({
      created: false,
      workspace: { workspaceId, title: 'renamed' },
    })
  })

  it('maps invalid paths, blank names, conflicts, and unknown ids to stable failures', async () => {
    const { controller, root } = await harness()
    const first = await controller.create({ path: stageDir(root, 'first') })
    const second = await controller.create({ path: stageDir(root, 'second') })

    await expect(controller.create({ path: join(root, 'missing') })).rejects.toMatchObject({
      code: 'workspace/invalid-path',
      details: { path: join(root, 'missing') },
    })
    expect(existsSync(join(root, 'missing'))).toBe(false)
    await expect(controller.rename({ workspaceId: first.workspace.workspaceId, title: '  ' }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    await controller.rename({ workspaceId: first.workspace.workspaceId, title: 'occupied' })
    await expect(controller.rename({ workspaceId: second.workspace.workspaceId, title: ' occupied ' }))
      .rejects.toMatchObject({ code: 'workspace/name-conflict' })
    await expect(controller.delete({ workspaceId: 'missing' as WorkspaceId }))
      .rejects.toMatchObject({ code: 'workspace/not-found' })
  })

  it('preserves Remote failures and propagates unexpected registry failures', async () => {
    const { controller, ctx, root } = await harness()
    const remoteFailure = new RemoteError('fixture/failure', 'already mapped', {})
    const resolveByPath = vi.spyOn(ctx.workspaceRegistry, 'resolveByPath')
      .mockRejectedValueOnce(remoteFailure)
      .mockRejectedValueOnce('plain failure')
    await expect(controller.create({ path: stageDir(root, 'remote-failure') }))
      .rejects.toBe(remoteFailure)
    const plainFailure = controller.create({ path: stageDir(root, 'plain-failure') })
    await expect(plainFailure).rejects.toMatchObject({ code: 'workspace/invalid-path' })
    await expect(plainFailure).rejects.toThrow('plain failure')
    resolveByPath.mockRestore()

    const created = await controller.create({ path: stageDir(root, 'created') })
    const workspace = ctx.workspaceRegistry.get(created.workspace.workspaceId)
    if (workspace === undefined) throw new Error('fixture Workspace disappeared')

    const orderFailure = new Error('order storage failed')
    vi.spyOn(ctx.workspaceRegistry, 'insertBefore').mockRejectedValueOnce(orderFailure)
    await expect(controller.insertBefore({ workspaceId: created.workspace.workspaceId }))
      .rejects.toBe(orderFailure)

    const moveFailure = new Error('membership storage failed')
    vi.spyOn(workspace, 'insertSessionBefore').mockRejectedValueOnce(moveFailure)
    await expect(controller.insertSessionBefore({
      workspaceId: created.workspace.workspaceId,
      sessionId: SessionId('session'),
    })).rejects.toBe(moveFailure)

    const archiveFailure = new Error('archive storage failed')
    vi.spyOn(ctx.workspaceRegistry, 'archiveSession').mockRejectedValueOnce(archiveFailure)
    await expect(controller.archiveSession({ sessionId: SessionId('session') }))
      .rejects.toBe(archiveFailure)

    const unarchiveFailure = new Error('unarchive storage failed')
    vi.spyOn(ctx.workspaceRegistry, 'unarchiveSession').mockRejectedValueOnce(unarchiveFailure)
    await expect(controller.unarchiveSession({ sessionId: SessionId('session') }))
      .rejects.toBe(unarchiveFailure)

    const pinFailure = new Error('pin storage failed')
    vi.spyOn(ctx.workspaceRegistry, 'pinSession').mockRejectedValueOnce(pinFailure)
    await expect(controller.pinSession({ sessionId: SessionId('session') }))
      .rejects.toBe(pinFailure)

    const unpinFailure = new Error('unpin storage failed')
    vi.spyOn(ctx.workspaceRegistry, 'unpinSession').mockRejectedValueOnce(unpinFailure)
    await expect(controller.unpinSession({ sessionId: SessionId('session') }))
      .rejects.toBe(unpinFailure)
  })

  it('resolves queued Workspace identities when their operation starts', async () => {
    const { controller, ctx, root } = await harness()
    const target = await controller.create({ path: stageDir(root, 'target') })
    const blockerPath = stageDir(root, 'blocker')
    const gate = deferred<undefined>()
    const originalResolveByPath = ctx.workspaceRegistry.resolveByPath.bind(ctx.workspaceRegistry)
    const resolveByPath = vi.spyOn(ctx.workspaceRegistry, 'resolveByPath')
    resolveByPath.mockImplementationOnce(async (path) => {
      await gate.promise
      return originalResolveByPath(path)
    })

    const blocker = controller.create({ path: blockerPath })
    const deletion = controller.delete({ workspaceId: target.workspace.workspaceId })
    const staleRename = controller.rename({
      workspaceId: target.workspace.workspaceId,
      title: 'must-not-land',
    })
    gate.resolve(undefined)
    await blocker
    await expect(deletion).resolves.toEqual({ deleted: true })
    await expect(staleRename).rejects.toMatchObject({ code: 'workspace/not-found' })
  })

  it('reorders Workspaces and Sessions and archives only known Sessions', async () => {
    const { controller, ctx, root } = await harness()
    const first = await controller.create({ path: stageDir(root, 'first') })
    const second = await controller.create({ path: stageDir(root, 'second') })
    await expect(controller.insertBefore({
      workspaceId: first.workspace.workspaceId,
      beforeWorkspaceId: second.workspace.workspaceId,
    })).resolves.toEqual({
      workspaceIds: [first.workspace.workspaceId, second.workspace.workspaceId],
    })
    await expect(controller.insertBefore({ workspaceId: 'missing' as WorkspaceId }))
      .rejects.toMatchObject({ code: 'workspace/not-found' })

    const session = ctx.sessions.create(SessionId('session-one'), {
      meta: { cwd: first.workspace.path },
    })
    const workspace = ctx.workspaceRegistry.get(first.workspace.workspaceId)
    if (workspace === undefined) throw new Error('fixture Workspace disappeared')
    await workspace.attachSession(session.id)
    await expect(controller.insertSessionBefore({
      workspaceId: first.workspace.workspaceId,
      sessionId: session.id,
    })).resolves.toMatchObject({ workspace: { sessionIds: [session.id] } })
    await expect(controller.insertSessionBefore({
      workspaceId: first.workspace.workspaceId,
      sessionId: SessionId('missing-session'),
    })).rejects.toMatchObject({ code: 'workspace/move-invalid' })
    await expect(controller.insertSessionBefore({
      workspaceId: first.workspace.workspaceId,
      sessionId: session.id,
      beforeSessionId: SessionId('missing-anchor'),
    })).rejects.toMatchObject({
      code: 'workspace/move-invalid',
      details: { beforeSessionId: 'missing-anchor' },
    })
    await expect(controller.insertSessionBefore({
      workspaceId: 'missing' as WorkspaceId,
      sessionId: session.id,
    })).rejects.toMatchObject({ code: 'workspace/not-found' })

    // A session reported active by the registry's activity waterfall is a
    // stable business failure carrying what still runs, and nothing is written.
    const activity = [{ kind: 'probe' as const }, { kind: 'probe-items' as const, items: [{ id: 'item-1', label: 'build' }] }]
    const stopReporting = ctx.on('workspace/session-activity', async ({ sessionId }, next) =>
      sessionId === session.id ? [...activity, ...(await next())] : next())
    await expect(controller.archiveSession({ sessionId: session.id })).rejects.toMatchObject({
      code: 'workspace/session-active',
      details: { sessionId: session.id, activity },
    })
    expect([...ctx.workspaceRegistry.archivedSessionIds]).toEqual([])
    // Asking to stop the work archives the still-active Session and reaches
    // the stop providers first.
    const stops: string[] = []
    const stopListening = ctx.on('workspace/session-stop', ({ sessionId }) => { stops.push(String(sessionId)) })
    await expect(controller.archiveSession({ sessionId: session.id, stopActivity: true }))
      .resolves.toEqual({ archivedSessionIds: [session.id] })
    expect(stops).toEqual([String(session.id)])
    stopListening()
    await expect(controller.unarchiveSession({ sessionId: session.id }))
      .resolves.toEqual({ archivedSessionIds: [] })
    stopReporting()

    await expect(controller.archiveSession({ sessionId: session.id }))
      .resolves.toEqual({ archivedSessionIds: [session.id] })
    await expect(controller.archiveSession({ sessionId: SessionId('unknown') }))
      .rejects.toMatchObject({ code: 'session/not-found' })
    await expect(controller.unarchiveSession({ sessionId: session.id }))
      .resolves.toEqual({ archivedSessionIds: [] })
    // Unarchive is idempotent: an id that is not archived is not an error.
    await expect(controller.unarchiveSession({ sessionId: session.id }))
      .resolves.toEqual({ archivedSessionIds: [] })
  })

  it('pins only known unarchived Sessions and unpins idempotently', async () => {
    const { controller, ctx, root } = await harness()
    const created = await controller.create({ path: stageDir(root, 'pins') })
    const session = ctx.sessions.create(SessionId('pin-me'), {
      meta: { cwd: created.workspace.path },
    })

    await expect(controller.pinSession({ sessionId: session.id }))
      .resolves.toEqual({ pinnedSessionIds: [session.id] })
    await expect(controller.pinSession({ sessionId: SessionId('unknown') }))
      .rejects.toMatchObject({ code: 'session/not-found' })

    // Pinning an archived Session is a caller error, not a missing session.
    const archived = ctx.sessions.create(SessionId('stored'), {
      meta: { cwd: created.workspace.path },
    })
    await controller.archiveSession({ sessionId: archived.id })
    await expect(controller.pinSession({ sessionId: archived.id }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })

    await expect(controller.unpinSession({ sessionId: session.id }))
      .resolves.toEqual({ pinnedSessionIds: [] })
    // Unpin is idempotent: an id that is not pinned is not an error.
    await expect(controller.unpinSession({ sessionId: session.id }))
      .resolves.toEqual({ pinnedSessionIds: [] })
  })
})

describe('WorkspaceController setSessionParent', () => {
  /** Two Workspaces: `home` with accounted Sessions a, b, c and a subagent child; `other` with d. */
  async function nesting(gateway = false) {
    const base = await harness({ gateway })
    const { controller, ctx, root } = base
    const home = await controller.create({ path: stageDir(root, 'nest-home') })
    const other = await controller.create({ path: stageDir(root, 'nest-other') })
    const account = async (id: string, workspace: typeof home, meta: Record<string, unknown> = {}) => {
      const session = ctx.sessions.create(SessionId(id), { meta: { cwd: workspace.workspace.path, ...meta } })
      const entity = ctx.workspaceRegistry.get(workspace.workspace.workspaceId)
      if (entity === undefined) throw new Error('fixture Workspace disappeared')
      await entity.attachSession(session.id)
      return session.id
    }
    const a = await account('a', home)
    const b = await account('b', home)
    const c = await account('c', home)
    const d = await account('d', other)
    return { ...base, home, other, account, a, b, c, d }
  }

  it('requires both Session grants through the Gateway and filters nonempty attachment results and frames', async () => {
    const { controller, ctx, pool, home, a, b, c } = await nesting(true)
    await controller.setSessionParent({ sessionId: b, parentSessionId: a })
    await controller.setSessionParent({ sessionId: c, parentSessionId: a })
    await controller.setSessionAttachment({ sessionId: c, parentSessionId: a, attachment: 'detached' })
    const editor: RemoteAccessRole<'session'> = {
      name: 'test:attachment-editor', resource: 'session', actions: ['workspace/setSessionAttachment'],
    }
    const bindings: RemoteAccessBinding[] = [
      { role: editor, resource: { kind: 'session', id: b } },
      { role: FOLLOWER, resource: { kind: 'global' } },
      { role: WORKSPACE_VIEWER, resource: { kind: 'workspace', id: home.workspace.workspaceId } },
      { role: SESSION_VIEWER, resource: { kind: 'session', id: b } },
    ]
    ctx.remoteAccess.registerPolicy('test-guest', { bindings: () => bindings })
    const abort = new AbortController()
    const peer: PeerScope = {
      id: 'attachment-peer' as PeerId, ctx, principal: { kind: 'test-guest', guest: 'attachment' },
      interactions: 'answer', signal: abort.signal, dispose: async () => {},
    }
    const request = { sessionId: b, parentSessionId: a, attachment: 'detached' }
    const invoke = () => ctx.typertGateway.invoke({ peer, namespace: 'workspace', method: 'setSessionAttachment', args: { request } })
    const saved = structuredClone(pool.media.get('workspace')!.global)
    const writes = vi.spyOn(pool, 'consumeInjectedFailure')
    const changes = vi.fn()
    ctx.on('domain/changed', changes)
    try {
      await expect(invoke()).rejects.toMatchObject({ code: 'remote-access/denied', details: { reason: 'no-allow' } })
      expect(writes).not.toHaveBeenCalled()
      expect(changes).not.toHaveBeenCalled()
      expect(pool.media.get('workspace')!.global).toEqual(saved)
      expect(ctx.workspaceRegistry.detachedSessionIds).toEqual([c])

      bindings.push({ role: editor, resource: { kind: 'session', id: a } })
      await expect(invoke()).resolves.toEqual({ detachedSessionIds: [b] })
      expect(writes).toHaveBeenCalledOnce()
      expect(pool.media.get('workspace')!.global).toMatchObject({ detachedSessionIds: [c, b] })
      // The parent is admitted for editing, not for follow; the child's marker remains visible.
      const iterator = (await ctx.typertGateway.stream({
        peer, namespace: 'workspace', method: 'follow', args: {}, signal: abort.signal,
      }))[Symbol.asyncIterator]()
      try {
        const baseline = await iterator.next()
        expect(baseline.value).toEqual({ type: 'baseline', value: {
          items: [expect.objectContaining({ workspaceId: home.workspace.workspaceId, sessionIds: [b] })],
          archivedSessionIds: [], pinnedSessionIds: [], sessionParents: {}, detachedSessionIds: [b],
        } })
        await controller.pinSession({ sessionId: c })
        expect((await iterator.next()).value).toEqual({ type: 'registry', value: {
          workspaceIds: [home.workspace.workspaceId], archivedSessionIds: [], pinnedSessionIds: [],
          sessionParents: {}, detachedSessionIds: [b],
        } })
      } finally {
        abort.abort()
        await iterator.return?.()
      }
    } finally {
      abort.abort()
      writes.mockRestore()
    }
  })

  it('sets attachment with structured refusals and publishes coupled cleanup', async () => {
    const { controller, a, b } = await nesting()
    await expect(controller.setSessionAttachment({ sessionId: b, parentSessionId: a, attachment: 'detached' }))
      .rejects.toMatchObject({ code: 'workspace/session-attachment-invalid', details: { reason: 'no-parent' } })
    await controller.setSessionParent({ sessionId: b, parentSessionId: a })
    await expect(controller.setSessionAttachment({ sessionId: b, parentSessionId: b, attachment: 'detached' }))
      .rejects.toMatchObject({ code: 'workspace/session-attachment-invalid', details: { reason: 'parent-mismatch' } })
    await expect(controller.setSessionAttachment({ sessionId: b, parentSessionId: a, attachment: 'detached' }))
      .resolves.toEqual({ detachedSessionIds: [b] })
    const abort = new AbortController()
    const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
    try {
      await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'baseline', value: {
        sessionParents: { [b]: a }, detachedSessionIds: [b],
      } })
      await controller.setSessionParent({ sessionId: b, parentSessionId: null })
      await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: {
        sessionParents: {}, detachedSessionIds: [],
      } })
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })

  it('reads committed attachment state in a baseline opened during domain notification', async () => {
    const { controller, ctx, a, b } = await nesting()
    await controller.setSessionParent({ sessionId: b, parentSessionId: a })
    const feed = new WorkspaceFeed(ctx)
    const observed: unknown[] = []
    ctx.on('domain/changed', (change) => {
      if (change.domain === 'workspace' && change.table === '') observed.push(feed.baseline())
    })
    await controller.setSessionAttachment({ sessionId: b, parentSessionId: a, attachment: 'detached' })
    expect(observed).toMatchObject([{ sessionParents: { [b]: a }, detachedSessionIds: [b] }])
    await controller.setSessionAttachment({ sessionId: b, parentSessionId: a, attachment: 'detached' })
    expect(observed).toHaveLength(1)
  })

  it('nests, repeats, re-parents and clears, returning the complete links', async () => {
    const { controller, a, b, c } = await nesting()
    await expect(controller.setSessionParent({ sessionId: b, parentSessionId: a }))
      .resolves.toEqual({ sessionParents: { [b]: a } })
    await expect(controller.setSessionParent({ sessionId: b, parentSessionId: a }))
      .resolves.toEqual({ sessionParents: { [b]: a } })
    await expect(controller.setSessionParent({ sessionId: c, parentSessionId: b }))
      .resolves.toEqual({ sessionParents: { [b]: a, [c]: b } })
    await expect(controller.setSessionParent({ sessionId: c, parentSessionId: a }))
      .resolves.toEqual({ sessionParents: { [b]: a, [c]: a } })
    await expect(controller.setSessionParent({ sessionId: c, parentSessionId: null }))
      .resolves.toEqual({ sessionParents: { [b]: a } })
    await expect(controller.setSessionParent({ sessionId: b, parentSessionId: null }))
      .resolves.toEqual({ sessionParents: {} })
    // Clearing a Session without a link is not an error.
    await expect(controller.setSessionParent({ sessionId: b, parentSessionId: null }))
      .resolves.toEqual({ sessionParents: {} })
  })

  it('maps every refusal to its stable failure and writes nothing', async () => {
    const { controller, ctx, root, home, account, a, b, c, d } = await nesting()
    const sub = await account('sub', home, { origin: 'subagent', parentSession: a })
    const loose = ctx.sessions.create(SessionId('loose'), { meta: { cwd: stageDir(root, 'nest-unowned') } }).id
    const ghost = SessionId('ghost')
    await controller.setSessionParent({ sessionId: b, parentSessionId: a })
    await controller.setSessionParent({ sessionId: c, parentSessionId: b })
    const links = { ...ctx.workspaceRegistry.sessionParents }

    await expect(controller.setSessionParent({ sessionId: ghost, parentSessionId: a })).rejects.toMatchObject({
      code: 'session/not-found',
      details: { sessionId: ghost },
      message: "cannot nest session 'ghost': live sessions and session persistence hold no such session",
    })
    await expect(controller.setSessionParent({ sessionId: a, parentSessionId: ghost })).rejects.toMatchObject({
      code: 'session/not-found', details: { sessionId: ghost },
    })
    const invalid = async (sessionId: SessionId, parentSessionId: SessionId, reason: string, ending: string) => {
      const attempt = controller.setSessionParent({ sessionId, parentSessionId })
      await expect(attempt).rejects.toBeInstanceOf(RemoteError)
      await expect(attempt).rejects.toMatchObject({
        code: 'workspace/session-parent-invalid',
        details: { sessionId, parentSessionId, reason },
        message: `cannot nest session '${sessionId}' under '${parentSessionId}': ${ending}`,
      })
    }
    await invalid(a, a, 'self', 'a session cannot be its own parent')
    // An unknown Session as its own parent answers `self`: that check runs before the existence checks.
    await invalid(ghost, ghost, 'self', 'a session cannot be its own parent')
    await invalid(sub, a, 'subagent', "session 'sub' is a subagent session")
    await invalid(a, sub, 'subagent', "session 'sub' is a subagent session")
    await invalid(loose, a, 'unaccounted', "no workspace accounts for session 'loose'")
    await invalid(a, loose, 'unaccounted', "no workspace accounts for session 'loose'")
    await invalid(d, a, 'cross-workspace', 'the sessions belong to different workspaces')
    await invalid(a, c, 'cycle', "session 'a' is already an ancestor of session 'c'")
    expect(ctx.workspaceRegistry.sessionParents).toEqual(links)
  })

  it('propagates an unexpected registry failure', async () => {
    const { controller, ctx, a, b } = await nesting()
    const failure = new Error('parent storage failed')
    vi.spyOn(ctx.workspaceRegistry, 'setSessionParent').mockRejectedValueOnce(failure)
    await expect(controller.setSessionParent({ sessionId: b, parentSessionId: a })).rejects.toBe(failure)
  })

  it('starts a fresh feed with existing links and follows their removal', async () => {
    const { controller, ctx, a, b } = await nesting()
    await controller.setSessionParent({ sessionId: b, parentSessionId: a })
    const feed = new WorkspaceFeed(ctx)
    const abort = new AbortController()
    const iterator = feed.follow(abort.signal)[Symbol.asyncIterator]()
    try {
      await expect(nextFrame(iterator)).resolves.toMatchObject({
        type: 'baseline', value: { sessionParents: { [b]: a } },
      })
      await controller.setSessionParent({ sessionId: b, parentSessionId: null })
      await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { sessionParents: {} } })
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })

  it('publishes one registry frame per changed map and none for an equal one', async () => {
    const { controller, home, other, a, b, c } = await nesting()
    const abort = new AbortController()
    const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'baseline', value: { sessionParents: {} } })

    await controller.setSessionParent({ sessionId: b, parentSessionId: a })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { sessionParents: { [b]: a } } })
    await controller.setSessionParent({ sessionId: c, parentSessionId: b })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { sessionParents: { [b]: a, [c]: b } } })
    // A re-parent keeps the key count: the frame still follows the changed value.
    await controller.setSessionParent({ sessionId: c, parentSessionId: a })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { sessionParents: { [b]: a, [c]: a } } })

    // Neither the repeated call nor the pin's registry write republishes an equal map.
    await controller.setSessionParent({ sessionId: c, parentSessionId: a })
    await controller.pinSession({ sessionId: a })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { pinnedSessionIds: [a] } })

    await controller.delete({ workspaceId: home.workspace.workspaceId })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: {
      workspaceIds: [other.workspace.workspaceId], sessionParents: {}, detachedSessionIds: [],
    } })
    await expect(nextFrame(iterator)).resolves.toEqual({ type: 'remove', workspaceId: home.workspace.workspaceId })

    abort.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })
})

describe('WorkspaceController follow', () => {
  it('seeds a new feed from existing rows and rejects an inconsistent registry commit', async () => {
    const { ctx, root } = await harness()
    const existing = await ctx.workspaceRegistry.create(stageDir(root, 'existing'))
    const feed = new WorkspaceFeed(ctx)
    expect(feed.baseline()).toMatchObject({
      items: [{ workspaceId: existing.id }],
    })

    expect(() => {
      ctx.emit('domain/changed', {
        domain: 'workspace',
        table: '',
        key: '',
        operation: 'put',
        value: {
          initialized: true,
          workspaceIds: ['missing'],
          archivedSessionIds: [],
          pinnedSessionIds: [],
        },
      })
    }).toThrow('references missing Workspace "missing"')
  })

  it('starts a fresh feed with existing pins and follows their removal', async () => {
    const { controller, ctx, root } = await harness()
    const session = ctx.sessions.create(SessionId('already-pinned'), { meta: { cwd: root } })
    await controller.pinSession({ sessionId: session.id })
    const feed = new WorkspaceFeed(ctx)
    const abort = new AbortController()
    const iterator = feed.follow(abort.signal)[Symbol.asyncIterator]()
    try {
      await expect(nextFrame(iterator)).resolves.toMatchObject({
        type: 'baseline', value: { pinnedSessionIds: [session.id] },
      })
      await controller.unpinSession({ sessionId: session.id })
      await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { pinnedSessionIds: [] } })
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })

  it('starts with a complete baseline and emits committed increments in domain order', async () => {
    const { controller, ctx, root } = await harness()
    const abort = new AbortController()
    const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'baseline',
      value: { items: [], archivedSessionIds: [], pinnedSessionIds: [], sessionParents: {}, detachedSessionIds: [] },
    })

    const first = await controller.create({ path: stageDir(root, 'first') })
    await expect(nextFrame(iterator)).resolves.toMatchObject({
      type: 'upsert', workspace: { workspaceId: first.workspace.workspaceId },
    })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { workspaceIds: [first.workspace.workspaceId],
    } })
    await controller.rename({ workspaceId: first.workspace.workspaceId, title: 'renamed' })
    await expect(nextFrame(iterator)).resolves.toMatchObject({
      type: 'upsert', workspace: { title: 'renamed' },
    })

    const second = await controller.create({ path: stageDir(root, 'second') })
    await expect(nextFrame(iterator)).resolves.toMatchObject({
      type: 'upsert', workspace: { workspaceId: second.workspace.workspaceId },
    })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { workspaceIds: [second.workspace.workspaceId, first.workspace.workspaceId],
    } })
    await controller.insertBefore({
      workspaceId: first.workspace.workspaceId,
      beforeWorkspaceId: second.workspace.workspaceId,
    })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: {
      workspaceIds: [first.workspace.workspaceId, second.workspace.workspaceId],
    } })

    const session = ctx.sessions.create(SessionId('archived'), {
      meta: { cwd: first.workspace.path },
    })
    await controller.archiveSession({ sessionId: session.id })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { archivedSessionIds: [session.id],
    } })
    // Unarchive rides the same complete-set increment: no new frame type.
    await controller.unarchiveSession({ sessionId: session.id })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { archivedSessionIds: [],
    } })
    await controller.pinSession({ sessionId: session.id })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { pinnedSessionIds: [session.id],
    } })
    // Unpin rides the same complete-set increment: no new frame type.
    await controller.unpinSession({ sessionId: session.id })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { pinnedSessionIds: [],
    } })
    await controller.delete({ workspaceId: second.workspace.workspaceId })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { workspaceIds: [first.workspace.workspaceId],
    } })
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'remove', workspaceId: second.workspace.workspaceId,
    })

    abort.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('follows only the Workspaces and Sessions a non-owner may follow', async () => {
    const { controller, ctx, root } = await harness()
    // oxlint-disable-next-line typescript/unbound-method -- the assertion inspects the spy and never calls it.
    expect(ctx.typert.resources.register).toHaveBeenCalledWith('workspace', { field: 'workspaceId' })
    const shown = await controller.create({ path: stageDir(root, 'shown') })
    const hiddenWorkspace = await controller.create({ path: stageDir(root, 'hidden') })
    const shownId = shown.workspace.workspaceId
    const hiddenId = hiddenWorkspace.workspace.workspaceId
    const shared = ctx.sessions.create(SessionId('shared'), { meta: { cwd: shown.workspace.path } })
    const secret = ctx.sessions.create(SessionId('secret'), { meta: { cwd: shown.workspace.path } })
    const workspace = ctx.workspaceRegistry.get(shownId)
    if (workspace === undefined) throw new Error('fixture Workspace disappeared')
    await workspace.attachSession(shared.id)
    await workspace.attachSession(secret.id)
    const friend = ctx.sessions.create(SessionId('friend'), { meta: { cwd: shown.workspace.path } })
    await workspace.attachSession(friend.id)
    await controller.pinSession({ sessionId: shared.id })
    await controller.pinSession({ sessionId: secret.id })
    await controller.setSessionParent({ sessionId: friend.id, parentSessionId: shared.id })
    await controller.setSessionParent({ sessionId: secret.id, parentSessionId: shared.id })
    ctx.remoteAccess.registerPolicy('test-guest', {
      bindings: () => [
        { role: FOLLOWER, resource: { kind: 'global' } },
        { role: WORKSPACE_VIEWER, resource: { kind: 'workspace', id: shownId } },
        { role: SESSION_VIEWER, resource: { kind: 'session', id: shared.id } },
        { role: SESSION_VIEWER, resource: { kind: 'session', id: friend.id } },
      ],
    })
    const guest: Principal = { kind: 'test-guest', guest: 'workspace-controller' }
    const abort = new AbortController()
    const iterator = followerContext(ctx, guest).workspaceController.follow(abort.signal)[Symbol.asyncIterator]()
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'baseline',
      value: {
        items: [expect.objectContaining({ workspaceId: shownId, sessionIds: [friend.id, shared.id] })],
        archivedSessionIds: [],
        pinnedSessionIds: [shared.id],
        // The link whose child is hidden is withheld.
        sessionParents: { [friend.id]: shared.id },
        detachedSessionIds: [],
      },
    })

    await controller.rename({ workspaceId: hiddenId, title: 'still hidden' })
    await controller.rename({ workspaceId: shownId, title: 'renamed' })
    await expect(nextFrame(iterator)).resolves.toMatchObject({
      type: 'upsert', workspace: { workspaceId: shownId, title: 'renamed', sessionIds: [friend.id, shared.id] },
    })
    await controller.unpinSession({ sessionId: secret.id })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { pinnedSessionIds: [shared.id] } })
    await controller.setSessionParent({ sessionId: secret.id, parentSessionId: null })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { sessionParents: { [friend.id]: shared.id } } })
    // The link whose parent is hidden is withheld too.
    await controller.setSessionParent({ sessionId: shared.id, parentSessionId: secret.id })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { sessionParents: { [friend.id]: shared.id } } })
    await controller.setSessionAttachment({ sessionId: shared.id, parentSessionId: secret.id, attachment: 'detached' })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: {
      sessionParents: { [friend.id]: shared.id }, detachedSessionIds: [shared.id],
    } })
    await controller.unpinSession({ sessionId: shared.id })
    await controller.archiveSession({ sessionId: secret.id })
    await controller.archiveSession({ sessionId: shared.id })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { pinnedSessionIds: [] } })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { archivedSessionIds: [] } })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { archivedSessionIds: [shared.id] } })
    await controller.delete({ workspaceId: hiddenId })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { workspaceIds: [shownId] } })
    await controller.delete({ workspaceId: shownId })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { workspaceIds: [], sessionParents: {}, detachedSessionIds: [] } })
    await expect(nextFrame(iterator)).resolves.toEqual({ type: 'remove', workspaceId: shownId })

    abort.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('sends a non-owner a replace increment when a delivered Workspace loses visibility, so it can reappear', async () => {
    const { controller, ctx, root } = await harness()
    const first = (await controller.create({ path: stageDir(root, 'first') })).workspace.workspaceId
    const second = (await controller.create({ path: stageDir(root, 'second') })).workspace.workspaceId
    // One Remote call reads its bindings once, so visibility changes during the stream come from the condition.
    const allowedWorkspaces = new Set<string>([first, second])
    const stillShared: RemoteAccessCondition<'workspace'> = ({ resource }) =>
      allowedWorkspaces.has(resource.id) ? { kind: 'allow' } : { kind: 'deny', reason: 'test:unshared' }
    ctx.remoteAccess.registerPolicy('test-guest', {
      bindings: () => [
        { role: FOLLOWER, resource: { kind: 'global' } },
        ...[first, second].map(id => ({ role: WORKSPACE_VIEWER, resource: { kind: 'workspace', id } as const, condition: stillShared })),
      ],
    })
    const abort = new AbortController()
    const iterator = followerContext(ctx, { kind: 'test-guest', guest: 'withdrawn' }).workspaceController.follow(abort.signal)[Symbol.asyncIterator]()
    const ids = (frame: WorkspaceFollowFrame): string[] =>
      frame.type === 'baseline' || frame.type === 'replace' ? frame.value.items.map(item => item.workspaceId).sort() : []
    const opening = await nextFrame(iterator)
    expect(opening.type).toBe('baseline')
    expect(ids(opening)).toEqual([first, second].sort())

    // Revoked: the next change replaces the state instead of sending a `remove` the Client would never undo.
    allowedWorkspaces.delete(first)
    await controller.rename({ workspaceId: first, title: 'revoked' })
    const withoutFirst = await nextFrame(iterator)
    expect(withoutFirst.type).toBe('replace')
    expect(ids(withoutFirst)).toEqual([second])
    allowedWorkspaces.delete(second)
    const third = (await controller.create({ path: stageDir(root, 'third') })).workspace.workspaceId
    const empty = await nextFrame(iterator)
    expect(empty.type).toBe('replace')
    expect(ids(empty)).toEqual([])
    // A deletion reaches only a Client that received the Workspace.
    await controller.delete({ workspaceId: third })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'registry', value: { workspaceIds: [] } })

    // Restored: the Workspace reappears through an ordinary upsert.
    allowedWorkspaces.add(first)
    await controller.rename({ workspaceId: first, title: 'restored' })
    await expect(nextFrame(iterator)).resolves.toMatchObject({ type: 'upsert', workspace: { workspaceId: first, title: 'restored' } })

    abort.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('ignores unrelated domain writes and closes active followers on disposal', async () => {
    const { controller, ctx, root } = await harness()
    const abort = new AbortController()
    const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)
    ctx.emit('domain/changed', {
      domain: 'other', table: 'records', key: 'x', operation: 'put', value: {},
    })
    ctx.emit('domain/changed', {
      domain: 'workspace', table: '', key: '', operation: 'deleted',
    })
    ctx.emit('domain/changed', {
      domain: 'workspace', table: 'other', key: 'x', operation: 'put', value: {},
    })
    ctx.emit('domain/changed', {
      domain: 'workspace', table: 'workspaces', key: 'unknown', operation: 'deleted',
    })
    const pending = iterator.next()
    const created = await controller.create({ path: stageDir(root, 'visible') })
    await expect(pending).resolves.toMatchObject({ value: { type: 'upsert' } })
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'registry', value: { workspaceIds: [created.workspace.workspaceId] } },
    })

    const closing = iterator.next()
    await ctx.fiber.dispose()
    roots.splice(roots.indexOf(ctx), 1)
    await expect(closing).resolves.toEqual({ done: true, value: undefined })
  })
})

describe('first-use Remote', () => {
  it('reuses an initialized Workspace without looking up system Documents', async () => {
    const { controller, ctx, root } = await harness({ systemDocuments: true })
    const workspace = await ctx.workspaceRegistry.initializeDefault(async () => root)
    const signal = AbortSignal.abort()
    await expect(controller.initializeDefault(signal))
      .resolves.toMatchObject({ workspace: { workspaceId: workspace!.id, path: root, title: basename(root) } })
  })

  it('returns a durable Workspace named after its fixed directory without allocating a Session', async () => {
    const { controller, ctx, root } = await harness()
    const signal = new AbortController().signal
    const result = await controller.initializeDefault(signal)
    expect(result!.workspace.path).toBe(join(root, 'deepseek-harness', DEFAULT_WORKSPACE_DIRECTORY))
    expect(result!.workspace.title).toBe(DEFAULT_WORKSPACE_DIRECTORY)
    expect(existsSync(result!.workspace.path)).toBe(true)
    expect(ctx.sessions.list()).toEqual([])
    expect(await controller.initializeDefault(signal)).toEqual(result)
  })

  it('skips ineligible first use and propagates preparation failures', async () => {
    const { controller, ctx, root } = await harness()
    await ctx.workspaceRegistry.create(root)
    await expect(controller.initializeDefault(new AbortController().signal))
      .resolves.toBeUndefined()
    vi.spyOn(ctx.workspaceRegistry, 'initializeDefault').mockRejectedValueOnce(new Error('permission denied'))
    await expect(controller.initializeDefault(new AbortController().signal))
      .rejects.toThrow('permission denied')
  })
})

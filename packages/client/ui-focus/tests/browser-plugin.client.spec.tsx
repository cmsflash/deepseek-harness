// @vitest-environment jsdom
/**
 * ui-focus browser half on a real cordis Context with fake slots/sessions
 * faces: the plugin registers one conversation.view entry carrying the focus
 * locale namespace, its inject face resolves the session's paging callback, and
 * the registration disposes with the plugin fiber (HMR safety). The node half
 * and the invariant companion are exercised over the same Context.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const sid = (key: string): SessionId => key as SessionId

/** Boot the plugin over fake slot/session faces. */
async function bench(options: { withSession?: boolean } = {}) {
  const ctx = new Context()
  const loadOlder = vi.fn(() => Promise.resolve())
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'conversation.view': { kind: 'list', scope: 'session' } },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sessions', {
    binding: (id: SessionId) =>
      options.withSession === false ? undefined : { sessionId: id, session: { loadOlder }, ctx },
  })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return {
    ctx,
    fiber,
    loadOlder,
    entry: () => {
      const entry = ctx.slots.entries('conversation.view')
        .find(candidate => candidate.options.id === 'focus')
      if (entry === undefined) return undefined
      return {
        ...entry.options,
        locale: entry.locale,
        inject: entry.inject as unknown as ((sessionId: SessionId) => { loadOlder: () => void }) | undefined,
      }
    },
  }
}

describe('ui-focus browser plugin', () => {
  it('registers one focus view tab on the conversation view ring', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.entry()).toMatchObject({ id: 'focus', order: 5, locale: 'focus' })
    // The label is a thunk over the bound translate, so it follows the active
    // locale (English by default in this bench) without re-registration.
    expect(resolveSlotLabel(b.entry()?.label)).toBe('Focus')
  })

  it('resolves the session paging callback through the inject face', async () => {
    const b = await bench()
    await b.fiber.await()
    b.entry()!.inject!(sid('s1')).loadOlder()
    expect(b.loadOlder).toHaveBeenCalledTimes(1)
  })

  it('fails loud when the addressed session is unavailable', async () => {
    const b = await bench({ withSession: false })
    await b.fiber.await()
    expect(() => b.entry()!.inject!(sid('gone'))).toThrow(/session "gone" is unavailable/)
  })

  it('drops the view tab when the plugin fiber unloads (HMR safety)', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.entry()).toBeDefined()
    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
  })
})

describe('ui-focus node half', () => {
  // The invariant companion is mounted by the vitest-wide invariant host on
  // every Context this suite creates; its registration is covered there.
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})

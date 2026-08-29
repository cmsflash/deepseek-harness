// @vitest-environment jsdom
/**
 * read-aloud browser half on a real cordis Context with fake
 * slots/remote faces: the plugin registers the read-aloud entry at
 * conversation.chat.assistant-actions, one player per Session backs every
 * message in that Session, a reconnect stops playback, and registration plus
 * player disposal ride the plugin fiber (HMR safety). The node half and the
 * invariant companion are exercised over the same Context.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotRegistry, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type { MessageSpeechInjected } from '../src/client/slots.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { name as invariantName, apply as invariantApply } from '../src/invariant.ts'

afterEach(cleanup)

const sid = (k: string): SessionId => k as SessionId
const MSG = 'm-1' as MessageId

/** Boot the plugin over fake faces; the Remote namespace records every call. */
async function bench(audioOk = true) {
  const ctx = new Context()
  const calls: unknown[] = []
  const readAloud = {
    audio: (request: unknown) => {
      calls.push(request)
      return Promise.resolve({
        ok: true as const,
        value: audioOk
          ? { ok: true as const, value: { data: 'AAAA', mediaType: 'audio/mpeg' as const, regenerated: false } }
          : { ok: false as const, code: 'synthesis-failed' as const },
      })
    },
  }
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  ctx.provide('remote.readAloud', readAloud)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' } },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return {
    ctx,
    fiber,
    calls,
    entry: () => {
      const entry = ctx.slots.entries('conversation.chat.assistant-actions')[0]
      if (entry === undefined) return undefined
      return {
        ...entry.options,
        locale: entry.locale,
        inject: entry.inject as unknown as ((sessionId: SessionId) => MessageSpeechInjected) | undefined,
      }
    },
  }
}

describe('read-aloud browser plugin', () => {
  it('registers the speech entry with the documented id, order, and locale', async () => {
    const b = await bench()
    await b.fiber.await()

    expect(b.entry()).toMatchObject({ id: 'speech', order: 20, locale: 'speech' })
    expect(b.entry()?.inject).toBeTypeOf('function')
  })

  it('exposes the playback hook plus the toggle verb', async () => {
    const b = await bench()
    await b.fiber.await()

    const face = b.entry()!.inject!(sid('s1'))
    expect(face.hooks.speech.getSnapshot()).toEqual({ activeMessageId: undefined, status: 'idle' })
    expect(face.toggle).toBeTypeOf('function')
  })

  it('shares one player across every message in the same Session', async () => {
    const b = await bench()
    await b.fiber.await()

    const first = b.entry()!.inject!(sid('s1'))
    const second = b.entry()!.inject!(sid('s1'))
    expect(first.hooks.speech).toBe(second.hooks.speech)
  })

  it('keeps separate Sessions on separate players', async () => {
    const b = await bench()
    await b.fiber.await()

    expect(b.entry()!.inject!(sid('s1')).hooks.speech)
      .not.toBe(b.entry()!.inject!(sid('s2')).hooks.speech)
  })

  it('requests audio by session and message identity, never by prose', async () => {
    const b = await bench()
    await b.fiber.await()

    b.entry()!.inject!(sid('s1')).toggle(MSG)
    await vi.waitFor(() =>{  expect(b.calls).toHaveLength(1) })
    expect(b.calls[0]).toEqual({ sessionId: 's1', messageId: MSG })
  })

  it('stops playback when the connection resets', async () => {
    const b = await bench()
    await b.fiber.await()

    const face = b.entry()!.inject!(sid('s1'))
    face.toggle(MSG)
    await vi.waitFor(() =>{  expect(face.hooks.speech.getSnapshot().activeMessageId).toBe(MSG) })
    b.ctx.emit('connection/reset')
    expect(face.hooks.speech.getSnapshot()).toEqual({ activeMessageId: undefined, status: 'idle' })
  })

  it('withdraws the registration and drops players when the fiber unloads', async () => {
    const b = await bench()
    await b.fiber.await()
    const face = b.entry()!.inject!(sid('s1'))
    face.toggle(MSG)
    await vi.waitFor(() => { expect(face.hooks.speech.getSnapshot().activeMessageId).toBe(MSG) })

    await b.fiber.dispose()
    expect(b.ctx.slots.entries('conversation.chat.assistant-actions')).toHaveLength(0)
    expect(face.hooks.speech.getSnapshot().activeMessageId).toBeUndefined()
  })

  it('reports a Host refusal as a failed control rather than silent audio', async () => {
    const b = await bench(false)
    await b.fiber.await()

    const face = b.entry()!.inject!(sid('s1'))
    face.toggle(MSG)
    await vi.waitFor(() => { expect(face.hooks.speech.getSnapshot().status).toBe('error') })
  })

  it('has an empty node half and a registering invariant companion', async () => {
    nodeApply()
    expect(invariantName).toBe('client-ui-speech-invariant')
    const registered: string[] = []
    const ctx = new Context()
    ctx.provide('invariants', { register: (pkg: string) => { registered.push(pkg); return () => {} } })
    await invariantApply(ctx)
    expect(registered).toEqual(['@deepseek-ai/dsh-client-read-aloud'])
  })
})

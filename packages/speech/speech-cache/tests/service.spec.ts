/**
 * SpeechCacheService over a real cordis Context with a scripted speech seam:
 * the turn/end trigger rules, cache reuse, and the Remote's failure vocabulary.
 */
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import SpeechCacheService from '@deepseek-ai/dsh-speech-cache'

const previousHome = process.env.DSH_HOME

type Block = { type: string; text?: string; name?: string; id?: string; arguments?: string }

/** An assistant/message with a placeholder seq; `session()` renumbers the seed. */
function assistant(turn: number, step: number, id: string, content: Block[]): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 0,
    time: 0,
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: {
        id: MessageId(id),
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      },
    },
  } as unknown as SessionEvent
}

const turnEnd = (turn: number, kind = 'completed'): SessionEvent => ({
  type: 'turn/end', seq: 0, time: 0, data: { turn, reason: { kind } },
} as unknown as SessionEvent)

/**
 * A real Session seeded with the given events, optionally marked as a subagent
 * child. Seeds must satisfy the `seq = index` contiguity contract, so the
 * fixtures carry a placeholder seq and are renumbered here.
 */
function session(id: string, events: SessionEvent[], origin?: 'subagent'): Session {
  const header = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 0,
    ...origin === undefined ? {} : { origin },
  }
  const seed = events.map((event, index) => ({ ...event, seq: index }))
  return Session.create(SessionId(id), seed, header)
}

/** Boot the service with a scripted speech seam over a temp Harness home. */
async function bench(options: { synthesizeOnTurnEnd?: boolean; fail?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-speech-home-'))
  process.env.DSH_HOME = home
  const ctx = new Context()
  const spoken: string[] = []
  class SpeechService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'speech') }
    synthesize(request: { text: string }) {
      spoken.push(request.text)
      if (options.fail === true) return Promise.reject(new Error('provider down'))
      return Promise.resolve({ data: new TextEncoder().encode(`audio:${request.text}`), mediaType: 'audio/mpeg' })
    }
  }
  new SpeechService(ctx)
  const sessions = new Map<string, Session>()
  class SessionsService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'sessions') }
    get(id: SessionId) { return sessions.get(id) }
  }
  new SessionsService(ctx)
  const fiber = ctx.plugin(SpeechCacheService, {
    ttlDays: 7,
    synthesizeOnTurnEnd: options.synthesizeOnTurnEnd ?? true,
  })
  await fiber.await()
  return { ctx, home, spoken, sessions, fiber }
}

beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

describe('SpeechCacheService turn/end trigger', () => {
  it('synthesizes the closing prose of a completed turn', async () => {
    const b = await bench()
    const s = session('s1', [assistant(1, 1, 'm1', [{ type: 'text', text: 'All done.' }]), turnEnd(1)])
    b.ctx.emit('session/event', s, turnEnd(1))
    await vi.waitFor(() =>{  expect(b.spoken).toEqual(['All done.']) })
  })

  it('ignores an interrupted turn', async () => {
    const b = await bench()
    const s = session('s1', [assistant(1, 1, 'm1', [{ type: 'text', text: 'partial' }])])
    b.ctx.emit('session/event', s, turnEnd(1, 'aborted'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(b.spoken).toEqual([])
  })

  it('ignores a subagent transcript', async () => {
    const b = await bench()
    const s = session('sub', [assistant(1, 1, 'm1', [{ type: 'text', text: 'child work' }])], 'subagent')
    b.ctx.emit('session/event', s, turnEnd(1))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(b.spoken).toEqual([])
  })

  it('ignores a turn whose closing message carries no prose', async () => {
    const b = await bench()
    const s = session('s1', [assistant(1, 1, 'm1', [{ type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }])])
    b.ctx.emit('session/event', s, turnEnd(1))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(b.spoken).toEqual([])
  })

  it('never sends reasoning traces or tool arguments to the provider', async () => {
    const b = await bench()
    const s = session('s1', [assistant(1, 1, 'm1', [
      { type: 'reasoning', text: 'SECRET THINKING' },
      { type: 'text', text: 'Result.' },
      { type: 'tool-call', id: 'c', name: 'write', arguments: '{"secret":1}' },
    ])])
    b.ctx.emit('session/event', s, turnEnd(1))
    await vi.waitFor(() =>{  expect(b.spoken).toHaveLength(1) })
    expect(b.spoken[0]).toBe('Result.')
  })

  it('ignores session events that are not turn ends', async () => {
    const b = await bench()
    const s = session('s1', [assistant(1, 1, 'm1', [{ type: 'text', text: 'mid-turn' }])])
    b.ctx.emit('session/event', s, {
      type: 'turn/start', seq: 9, time: 0, data: { turn: 1 },
    } as unknown as SessionEvent)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(b.spoken).toEqual([])
  })

  it('falls back to the home directory when DSH_HOME is unset', async () => {
    delete process.env.DSH_HOME
    const ctx = new Context()
    class SpeechService extends Service {
      constructor(serviceCtx: Context) { super(serviceCtx, 'speech') }
      synthesize() { return Promise.resolve({ data: new Uint8Array([1]), mediaType: 'audio/mpeg' }) }
    }
    new SpeechService(ctx)
    class SessionsService extends Service {
      constructor(serviceCtx: Context) { super(serviceCtx, 'sessions') }
      get() { return undefined }
    }
    new SessionsService(ctx)
    const fiber = ctx.plugin(SpeechCacheService, { ttlDays: 7, synthesizeOnTurnEnd: false })
    await fiber.await()
    expect(ctx.speechCache).toBeDefined()
    await fiber.dispose()
  })

  it('does not follow turns when the trigger is disabled', async () => {
    const b = await bench({ synthesizeOnTurnEnd: false })
    const s = session('s1', [assistant(1, 1, 'm1', [{ type: 'text', text: 'quiet' }])])
    b.ctx.emit('session/event', s, turnEnd(1))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(b.spoken).toEqual([])
  })

  it('stops following turns once the fiber unloads', async () => {
    const b = await bench()
    await b.fiber.dispose()
    const s = session('s1', [assistant(1, 1, 'm1', [{ type: 'text', text: 'after unload' }])])
    b.ctx.emit('session/event', s, turnEnd(1))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(b.spoken).toEqual([])
  })
})

describe('SpeechCacheService.audio', () => {
  it('serves cached audio without re-synthesizing', async () => {
    const b = await bench()
    const s = session('s1', [assistant(1, 1, 'm1', [{ type: 'text', text: 'Cached.' }])])
    b.sessions.set('s1', s)
    b.ctx.emit('session/event', s, turnEnd(1))
    // Wait for the artifact to land, not merely for synthesis to be called:
    // a read racing the in-flight write would join it rather than hit cache.
    await vi.waitFor(async () => {
      expect(await readdir(join(b.home, 'cache', 'speech'))).toHaveLength(1)
    })

    const reply = await b.ctx.speechCache.audio({ sessionId: SessionId('s1'), messageId: MessageId('m1') })
    expect(reply).toMatchObject({ ok: true })
    if (reply.ok) {
      expect(reply.value.regenerated).toBe(false)
      expect(Buffer.from(reply.value.data, 'base64').toString()).toBe('audio:Cached.')
    }
    expect(b.spoken).toHaveLength(1)
  })

  it('regenerates on a miss and reports it', async () => {
    const b = await bench({ synthesizeOnTurnEnd: false })
    b.sessions.set('s1', session('s1', [assistant(1, 1, 'm1', [{ type: 'text', text: 'Fresh.' }])]))
    const reply = await b.ctx.speechCache.audio({ sessionId: SessionId('s1'), messageId: MessageId('m1') })
    expect(reply).toMatchObject({ ok: true })
    if (reply.ok) expect(reply.value.regenerated).toBe(true)
    expect(b.spoken).toEqual(['Fresh.'])
  })

  it('reports an unknown session distinctly from an unknown message', async () => {
    const b = await bench({ synthesizeOnTurnEnd: false })
    await expect(b.ctx.speechCache.audio({ sessionId: SessionId('nope'), messageId: MessageId('m1') }))
      .resolves.toMatchObject({ ok: false, code: 'session-not-found' })
    b.sessions.set('s1', session('s1', [assistant(1, 1, 'm1', [{ type: 'text', text: 'x' }])]))
    await expect(b.ctx.speechCache.audio({ sessionId: SessionId('s1'), messageId: MessageId('absent') }))
      .resolves.toMatchObject({ ok: false, code: 'message-not-found' })
  })

  it('reports provider failure without throwing at the Remote', async () => {
    const b = await bench({ synthesizeOnTurnEnd: false, fail: true })
    b.sessions.set('s1', session('s1', [assistant(1, 1, 'm1', [{ type: 'text', text: 'x' }])]))
    await expect(b.ctx.speechCache.audio({ sessionId: SessionId('s1'), messageId: MessageId('m1') }))
      .resolves.toMatchObject({ ok: false, code: 'synthesis-failed' })
  })

  it('declines a non-closing message of a multi-step turn', async () => {
    const b = await bench({ synthesizeOnTurnEnd: false })
    b.sessions.set('s1', session('s1', [
      assistant(1, 1, 'm1', [{ type: 'text', text: 'step one' }]),
      assistant(1, 2, 'm2', [{ type: 'text', text: 'the summary' }]),
    ]))
    await expect(b.ctx.speechCache.audio({ sessionId: SessionId('s1'), messageId: MessageId('m1') }))
      .resolves.toMatchObject({ ok: false, code: 'message-not-found' })
  })

  it('bills once when a turn-end job and a play request race', async () => {
    const b = await bench()
    const s = session('s1', [assistant(1, 1, 'm1', [{ type: 'text', text: 'Race.' }])])
    b.sessions.set('s1', s)
    b.ctx.emit('session/event', s, turnEnd(1))
    const reply = await b.ctx.speechCache.audio({ sessionId: SessionId('s1'), messageId: MessageId('m1') })
    expect(reply.ok).toBe(true)
    expect(b.spoken).toHaveLength(1)
  })

  it('writes exactly one artifact per message', async () => {
    const b = await bench()
    const s = session('s1', [assistant(1, 1, 'm1', [{ type: 'text', text: 'One.' }])])
    b.ctx.emit('session/event', s, turnEnd(1))
    await vi.waitFor(async () => {
      expect(await readdir(join(b.home, 'cache', 'speech'))).toHaveLength(1)
    })
  })
})

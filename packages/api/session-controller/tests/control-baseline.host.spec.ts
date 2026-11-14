/**
 * Control baselines answer a caller's checkpoints: a Session whose projection
 * cut and Session log chain link the caller already holds travels as an
 * identity in `retained`, and everything else travels in full.
 */

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { SessionLogLink, type SessionLogChain } from '@deepseek-ai/dsh-session-persistence'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import { SessionControlController } from '../src/control.ts'
import type {
  SessionChainLink,
  SessionControlBaseline,
  SessionControlKnown,
} from '../src/types.ts'

const contexts = new Set<Context>()
afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  contexts.clear()
})

/** The test links of the chain double: `link(seq)` hashes `String(seq)`. */
function testLink(seq: number): SessionChainLink {
  return createHash('sha256').update(String(seq)).digest('hex') as SessionChainLink
}

interface Harness {
  readonly ctx: Context
  readonly control: SessionControlController
  readonly session: Session
  /** Replace the chain every live Session answers with. */
  readonly setChain: (chain: SessionLogChain | undefined) => void
  /** Read one opening of the control stream. */
  readonly opening: (known?: readonly SessionControlKnown[]) => Promise<SessionControlBaseline>
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  // The double answers exactly the test links, so expectations never read the
  // code under test.
  let chain: SessionLogChain | undefined = {
    length: 8,
    linkAt: (seq: number) => (0 <= seq && seq < 8 ? SessionLogLink(testLink(seq)) : undefined),
  }
  ctx.provide('sessionPersistence', {
    liveChain: () => chain,
  } as never)
  const session = ctx.sessions.create(SessionId('baseline-session'), { meta: { cwd: '/workspace' } })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'first' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const control = new SessionControlController(ctx)
  return {
    ctx,
    control,
    session,
    setChain: (next) => { chain = next },
    opening: async (known) => {
      const abort = new AbortController()
      const iterator = control.control(
        known === undefined ? {} : { known },
        abort.signal,
      )[Symbol.asyncIterator]()
      try {
        const first = await iterator.next()
        if (first.done === true || first.value.type !== 'baseline') {
          throw new Error('the control stream did not start with a baseline')
        }
        return first.value.value
      } finally {
        abort.abort()
        await iterator.return?.()
      }
    },
  }
}

describe('Session control baselines', () => {
  it('reports the Session log chain link of every block', async () => {
    const { opening, session } = await harness()
    const baseline = await opening()
    const block = baseline.projections[session.id]
    expect(block).toBeDefined()
    // The projections are consistent at the seq before the log's next one.
    expect(block?.asOfSeq).toBe(session.seq - 1)
    expect(block?.link).toBe(testLink(block?.asOfSeq as number))
    expect(baseline.retained).toBeUndefined()
  })

  it('retains a Session the caller holds at the same cut and link', async () => {
    const { opening, session } = await harness()
    const held = await opening()
    const block = held.projections[session.id]
    if (block?.link === undefined) throw new Error('the baseline block carries no link')

    const next = await opening([{ sessionId: session.id, asOfSeq: block.asOfSeq, link: block.link }])
    expect(next.projections[session.id]).toBeUndefined()
    expect(next.retained).toEqual([session.id])
  })

  it('restates a Session whose projection cut moved', async () => {
    const { opening, session } = await harness()
    const block = (await opening()).projections[session.id]
    if (block?.link === undefined) throw new Error('the baseline block carries no link')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'second' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const next = await opening([{ sessionId: session.id, asOfSeq: block.asOfSeq, link: block.link }])
    expect(next.projections[session.id]?.asOfSeq).toBe(session.seq - 1)
    expect(next.retained).toBeUndefined()
  })

  it('restates a Session whose log changed at the same cut', async () => {
    const { opening, session, setChain } = await harness()
    const block = (await opening()).projections[session.id]
    if (block?.link === undefined) throw new Error('the baseline block carries no link')
    setChain({
      length: 8,
      linkAt: (seq: number) => (0 <= seq && seq < 8 ? SessionLogLink('c'.repeat(64)) : undefined),
    })

    const next = await opening([{ sessionId: session.id, asOfSeq: block.asOfSeq, link: block.link }])
    expect(next.projections[session.id]?.link).toBe('c'.repeat(64))
    expect(next.retained).toBeUndefined()
  })

  it('restates every Session the caller does not know and ignores checkpoints of unlisted ones', async () => {
    const { opening } = await harness()
    const first = await opening()
    const second = await opening([{ sessionId: SessionId('gone'), asOfSeq: 2, link: testLink(2) }])
    expect(second.retained).toBeUndefined()
    expect(Object.keys(second.projections)).toEqual(Object.keys(first.projections))
  })

  it('sends every value of a Session that becomes live after the baseline, one frame per key at its cut', async () => {
    const { ctx, control, session } = await harness()
    await ctx.sessionProjections.register(titleProjectionDefinition)
    const abort = new AbortController()
    const iterator = control.control({}, abort.signal)[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      expect(first.done === true ? undefined : first.value.type).toBe('baseline')
      ctx.sessions.create(SessionId('empty-session'), { meta: { cwd: '/workspace' } })
      const later = ctx.sessions.create(SessionId('later-session'), {
        meta: { cwd: '/workspace' }, seed: [...session.ownEvents()],
      })
      const snapshot = ctx.sessionProjections.snapshot(later)
      const keys = Object.keys(snapshot.values)
      expect(keys).toContain('title')
      const frames = []
      for (const _ of keys) frames.push((await iterator.next()).value)
      expect(frames).toEqual(keys.map(key => ({
        type: 'projection',
        sessionId: later.id,
        key,
        value: (snapshot.values as Record<string, unknown>)[key],
        seq: later.seq - 1,
      })))
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })

  it('sends nothing for a Session announced while no stream is open, and the next baseline holds it', async () => {
    const { ctx, opening, session } = await harness()
    const later = ctx.sessions.create(SessionId('later-session'), {
      meta: { cwd: '/workspace' }, seed: [...session.ownEvents()],
    })
    expect((await opening()).projections[later.id]?.asOfSeq).toBe(later.seq - 1)
  })

  it('keeps a Session live when its values cannot be read', async () => {
    const { ctx, control, session } = await harness()
    const abort = new AbortController()
    const iterator = control.control({}, abort.signal)[Symbol.asyncIterator]()
    try {
      await iterator.next()
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      vi.spyOn(ctx.sessionProjections, 'snapshot').mockImplementationOnce(() => { throw new Error('unreadable') })
      const later = ctx.sessions.create(SessionId('later-session'), {
        meta: { cwd: '/workspace' }, seed: [...session.ownEvents()],
      })
      expect(ctx.sessions.list()).toContain(later)
      expect(warn).toHaveBeenCalledWith('session control: values of "later-session" were not sent: Error: unreadable')
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })

  it('omits the link and never retains a Session whose Host keeps no chain', async () => {
    const { opening, session, setChain } = await harness()
    const first = await opening()
    const held = first.projections[session.id]
    if (held?.link === undefined) throw new Error('the baseline block carries no link')
    setChain(undefined)

    const next = await opening([{ sessionId: session.id, asOfSeq: held.asOfSeq, link: held.link }])
    expect(next.projections[session.id]?.link).toBeUndefined()
    expect(next.retained).toBeUndefined()
  })
})

/**
 * Collapsed history detail through the Session Controller's page, follow, and
 * expandSteps endpoints: a `collapsed` page withholds elidable step interiors
 * behind digests, boundaries keep the range contiguous, and expansion returns
 * exactly the withheld events within the caller's window.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import { ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionFollowFrame, SessionPage } from '@deepseek-ai/dsh-api-session-controller/types'
import { createSessionTestRemote, installSessionReadTestServices } from './test-remote.ts'

async function harness(): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  return { ctx }
}

/** One complete step: boundaries around a tool pair and an assistant message. */
function appendStep(session: Session, turn: number, step: number, text: string | null): SessionEvent[] {
  const callId = ToolCallId(`c${String(turn)}-${String(step)}`)
  const events = [
    session.append('step/start', { turn, step }),
    session.append('tool/call', { turn, step, callId, name: 'write', arguments: '{}' }),
    session.append('tool/result', {
      turn, step,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
      meta: { diffs: [{ path: 'a.ts', oldText: 'x\n', newText: 'x\ny\n' }] },
    }, { surfaceOp: 'append' }),
    session.append('assistant/message', {
      turn, step,
      message: createMessage({
        role: 'assistant',
        content: text === null ? [] : [{ type: 'text', text }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      }),
      stream: [],
      usage: { inputTokens: 10, outputTokens: 5 },
    }, { surfaceOp: 'append' }),
    session.append('step/end', { turn, step }),
  ]
  return events
}

/** One user round of `steps` model calls, the last carrying the closing text. */
function appendTurn(session: Session, turn: number, steps: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `ask ${String(turn)}` }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  for (let step = 1; step <= steps; step += 1) {
    appendStep(session, turn, step, step === steps ? `done ${String(turn)}` : null)
  }
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function seqs(page: SessionPage): number[] {
  return page.records.map(record => record.event.seq)
}

function types(page: SessionPage): string[] {
  return page.records.map(record => record.event.type)
}

describe('Session history collapsed step detail', () => {
  it('serves elidable step interiors as boundaries plus digests and keeps the range contiguous', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    appendTurn(session, 1, 3)
    const address = { kind: 'session', sessionId: session.id } as const

    const full = await remote.page({ address, throughSeq: session.seq - 1 })
    const collapsed = await remote.page({ address, throughSeq: session.seq - 1, stepDetail: 'collapsed' })
    if (!full.ok || !collapsed.ok) throw new Error('unreachable')

    // Steps 1 and 2 lose their interiors; step 3 (last and closing) stays whole.
    expect(full.value.digests).toBeUndefined()
    expect(types(collapsed.value).filter(type => type === 'tool/result')).toHaveLength(1)
    expect(types(collapsed.value).filter(type => type === 'step/start')).toHaveLength(3)
    expect(types(collapsed.value).filter(type => type === 'step/end')).toHaveLength(3)
    expect(collapsed.value.digests?.map(digest => digest.step)).toEqual([1, 2])
    expect(collapsed.value.digests?.[0]).toMatchObject({
      turn: 1, elided: 3, steps: 1, calls: 1, files: 1, added: 1, removed: 0, inputTokens: 10, outputTokens: 5,
    })
    // Every step/start remains as an expansion address, and the digests point at them.
    const starts = collapsed.value.records
      .filter(record => record.event.type === 'step/start')
      .map(record => record.event.seq)
    expect(collapsed.value.digests?.map(digest => digest.startSeq)).toEqual(starts.slice(0, 2))
    // The withheld rows are exactly the difference between the two pages.
    const withheld = seqs(full.value).filter(seq => !seqs(collapsed.value).includes(seq))
    expect(withheld).toHaveLength(6)
    expect(collapsed.value.hasMore).toBe(false)
    // Records partition the page's seq range: each covers the withheld rows before
    // it, so the client journal reads one gap-free range.
    let expectedFrom = seqs(full.value)[0] as number
    for (const record of collapsed.value.records) {
      const from = record.covers?.from ?? record.event.seq
      const to = record.covers?.to ?? record.event.seq
      expect(from).toBe(expectedFrom)
      expect(to).toBeGreaterThanOrEqual(record.event.seq)
      expectedFrom = to + 1
    }
    expect(expectedFrom).toBe((seqs(full.value).at(-1) as number) + 1)
    // A record standing only for itself carries no coverage.
    expect(collapsed.value.records[0]?.covers).toBeUndefined()
  })

  it('serves a page whole when collapsing would leave it empty', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    appendTurn(session, 1, 2)
    const address = { kind: 'session', sessionId: session.id } as const
    const throughSeq = session.seq - 1
    // A one-message page cut just before step 1's `step/end`: its only event is
    // the elidable assistant message, so collapsing would withhold every record.
    const beforeStepEnd = throughSeq - 6
    const page = await remote.page({ address, throughSeq, beforeSeq: beforeStepEnd, maxMessages: 1, stepDetail: 'collapsed' })
    if (!page.ok) throw new Error('unreachable')
    expect(page.value.records.map(record => record.event.type)).toEqual(['assistant/message'])
    expect(page.value.records[0]?.covers).toBeUndefined()
    expect(page.value.digests).toBeUndefined()

    // Under full detail nothing is elidable, so no digests ride even a collapsed request.
    const single = await remote.page({ address, throughSeq: 1, stepDetail: 'collapsed' })
    if (!single.ok) throw new Error('unreachable')
    expect(single.value.digests).toBeUndefined()
  })

  it('returns the withheld events of one turn on expansion, bounded to the window head', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    appendTurn(session, 1, 2)
    appendTurn(session, 2, 3)
    const address = { kind: 'session', sessionId: session.id } as const
    const throughSeq = session.seq - 1

    const full = await remote.page({ address, throughSeq })
    const collapsed = await remote.page({ address, throughSeq, stepDetail: 'collapsed' })
    const expanded = await remote.expandSteps({ address, throughSeq, turn: 2 })
    if (!full.ok || !collapsed.ok || !expanded.ok) throw new Error('unreachable')

    const turnTwoWithheld = seqs(full.value).filter(seq => !seqs(collapsed.value).includes(seq))
      .filter(seq => (full.value.records.find(record => record.event.seq === seq)?.event.data as { turn: number }).turn === 2)
    expect(expanded.value.records.map(record => record.event.seq)).toEqual(turnTwoWithheld)

    // A window head inside the turn excludes the steps below it.
    const secondStart = collapsed.value.records
      .filter(record => record.event.type === 'step/start' && (record.event.data as { turn: number; step: number }).turn === 2)
      .map(record => record.event.seq)[1] as number
    const bounded = await remote.expandSteps({ address, throughSeq, turn: 2, fromSeq: secondStart })
    if (!bounded.ok) throw new Error('unreachable')
    expect(bounded.value.records.every(record => record.event.seq >= secondStart)).toBe(true)
    expect(bounded.value.records.length).toBeLessThan(expanded.value.records.length)

    const absent = await remote.expandSteps({ address, throughSeq, turn: 99 })
    if (!absent.ok) throw new Error('unreachable')
    expect(absent.value.records).toEqual([])
  })

  it('rejects malformed expansion requests before touching the log', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    appendTurn(session, 1, 1)
    const address = { kind: 'session', sessionId: session.id } as const

    for (const request of [
      { address, throughSeq: 1.5, turn: 1 },
      { address, throughSeq: session.seq - 1, turn: -1 },
      { address, throughSeq: session.seq - 1, turn: 1, fromSeq: -3 },
      { address, throughSeq: session.seq + 10, turn: 1 },
    ]) {
      const response = await remote.expandSteps(request)
      expect(response.ok).toBe(false)
      if (!response.ok) expect(response.error.code).toBe('gateway/bad-request')
    }
  })

  it('applies the requested detail to the follow opening snapshot', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    appendTurn(session, 1, 2)
    const abort = new AbortController()
    const iterator = remote.follow({
      address: { kind: 'session', sessionId: session.id },
      stepDetail: 'collapsed',
    }, abort.signal)[Symbol.asyncIterator]()
    try {
      const opening = await iterator.next()
      const frame = opening.value as Extract<SessionFollowFrame, { type: 'snapshot' }>
      expect(frame.type).toBe('snapshot')
      expect(frame.digests?.map(digest => digest.step)).toEqual([1])
      expect(frame.records.filter(record => record.event.type === 'tool/result')).toHaveLength(1)
    } finally {
      abort.abort()
      await iterator.return?.()
      await ctx.fiber.dispose()
    }
  })
})

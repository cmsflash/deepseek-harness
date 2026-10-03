/**
 * Collapsed history detail through the Session Controller's page, follow, and
 * expandSteps endpoints: a `collapsed` page withholds elidable step interiors
 * behind digests, boundaries keep the range contiguous, and expansion returns
 * exactly the withheld events within the caller's window.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import { ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TurnTokenUsage } from '@deepseek-ai/dsh-token-meter/turn-usage'
import type { SessionEventEntry, SessionFollowFrame, SessionPage } from '@deepseek-ai/dsh-api-session-controller/types'
import { createSessionTestRemote, installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const STEP_USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.125 }

async function harness(): Promise<{ ctx: Context }> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  return { ctx }
}

function appendAssistant(
  session: Session,
  turn: number,
  step: number,
  text: string | null,
  usage: TokenUsage | null = STEP_USAGE,
): SessionEvent<'assistant/message'> {
  return session.append('assistant/message', {
    turn, step,
    message: createMessage({
      role: 'assistant',
      content: text === null ? [] : [{ type: 'text', text }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    }),
    stream: [],
    ...usage === null ? {} : { usage },
  }, { surfaceOp: 'append' })
}

/** One complete step: boundaries around a tool pair and an assistant message. */
function appendStep(
  session: Session,
  turn: number,
  step: number,
  text: string | null,
  usage: TokenUsage | null = STEP_USAGE,
): SessionEvent[] {
  const callId = ToolCallId(`c${String(turn)}-${String(step)}`)
  return [
    session.append('step/start', { turn, step }),
    session.append('tool/call', { turn, step, callId, name: 'write', arguments: '{}' }),
    session.append('tool/result', {
      turn, step,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
      meta: { diffs: [{ path: 'a.ts', oldText: 'x\n', newText: 'x\ny\n' }] },
    }, { surfaceOp: 'append' }),
    appendAssistant(session, turn, step, text, usage),
    session.append('step/end', { turn, step }),
  ]
}

function expectedUsage(steps: number): TurnTokenUsage {
  return {
    uncachedInputTokens: 10 * steps,
    outputTokens: 5 * steps,
    totalTokens: 15 * steps,
    routes: [{ provider: 'p', model: 'm' }],
    costUsd: 0.125 * steps,
    unpricedCalls: 0,
  }
}

function usageEnds(records: readonly SessionEventEntry[]): SessionEventEntry[] {
  for (const record of records) {
    expect(record.event).not.toHaveProperty('turnUsage')
    expect(record.event.data).not.toHaveProperty('turnUsage')
    if (record.event.type !== 'turn/end') expect(record).not.toHaveProperty('turnUsage')
  }
  return records.filter(record => record.event.type === 'turn/end')
}

/** One user round of `steps` model calls, the last carrying the closing text. */
function appendTurn(session: Session, turn: number, steps: number): SessionEvent<'turn/end'> {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `ask ${String(turn)}` }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  for (let step = 1; step <= steps; step += 1) {
    appendStep(session, turn, step, step === steps ? `done ${String(turn)}` : null)
  }
  return session.append('turn/end', { turn, reason: { kind: 'completed' } })
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
    const end = appendTurn(session, 1, 3)
    const address = { kind: 'session', sessionId: session.id } as const

    const full = await remote.page({ address, throughSeq: session.seq - 1 })
    const collapsed = await remote.page({ address, throughSeq: session.seq - 1, stepDetail: 'collapsed' })
    if (!full.ok || !collapsed.ok) throw new Error('unreachable')

    expect(usageEnds(full.value.records)).toEqual([{ type: 'event', event: end, turnUsage: expectedUsage(3) }])
    expect(usageEnds(collapsed.value.records)).toEqual(usageEnds(full.value.records))
    expect(end.data).toEqual({ turn: 1, reason: { kind: 'completed' } })

    // Steps 1 and 2 lose their interiors; step 3 (last and closing) stays whole.
    expect(full.value.digests).toBeUndefined()
    expect(types(collapsed.value).filter(type => type === 'tool/result')).toHaveLength(1)
    expect(types(collapsed.value).filter(type => type === 'step/start')).toHaveLength(3)
    expect(types(collapsed.value).filter(type => type === 'step/end')).toHaveLength(3)
    expect(collapsed.value.digests?.map(digest => digest.step)).toEqual([1, 2])
    expect(collapsed.value.digests?.[0]).toMatchObject({
      turn: 1, elided: 3, steps: 1, calls: 1, filePaths: ['a.ts'], added: 1, removed: 0, inputTokens: 10, outputTokens: 5,
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

  it('accounts for the whole turn when a 300-message page omits its start and earlier steps', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const end = appendTurn(session, 1, 305)
    const address = { kind: 'session', sessionId: session.id } as const
    const request = { address, throughSeq: end.seq, maxMessages: 300 }

    const full = await remote.page(request)
    const collapsed = await remote.page({ ...request, stepDetail: 'collapsed' })
    if (!full.ok || !collapsed.ok) throw new Error('unreachable')

    expect(full.value.hasMore).toBe(true)
    expect(collapsed.value.hasMore).toBe(true)
    expect(types(full.value)).not.toContain('turn/start')
    expect(types(collapsed.value)).not.toContain('turn/start')
    expect(types(full.value).filter(type => type === 'assistant/message')).toHaveLength(300)
    expect(types(collapsed.value).filter(type => type === 'assistant/message')).toHaveLength(1)
    expect(types(collapsed.value).filter(type => type === 'tool/result')).toHaveLength(1)
    expect(collapsed.value.digests).toHaveLength(299)
    expect(usageEnds(full.value.records)).toEqual([{ type: 'event', event: end, turnUsage: expectedUsage(305) }])
    expect(usageEnds(collapsed.value.records)).toEqual(usageEnds(full.value.records))

    const first = full.value.records[0]
    if (first === undefined) throw new Error('expected a non-empty history page')
    const older = await remote.page({
      ...request,
      beforeSeq: first.event.seq,
      stepDetail: 'collapsed',
    })
    if (!older.ok) throw new Error('unreachable')
    expect(older.value.hasMore).toBe(false)
    expect(types(older.value)).toContain('turn/start')
    expect(usageEnds(older.value.records)).toEqual([])
  })

  it('serves only requested end records using the source prefix of an exact interval', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    appendTurn(session, 1, 1)
    const secondEnd = appendTurn(session, 2, 3)
    session.append('turn/start', { turn: 3 })
    const thirdPrefix = appendStep(session, 3, 1, null)
    const cut = session.seq - 1
    appendStep(session, 3, 2, 'done 3')
    const thirdEnd = session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    const address = { kind: 'session', sessionId: session.id } as const

    const bounded = await remote.page({ address, fromSeq: secondEnd.seq, throughSeq: cut })
    const exactEnd = await remote.page({ address, fromSeq: thirdEnd.seq, throughSeq: thirdEnd.seq })
    const middle = await remote.page({
      address, throughSeq: thirdEnd.seq, beforeSeq: secondEnd.seq + 1, maxMessages: 1, stepDetail: 'collapsed',
    })
    if (!bounded.ok || !exactEnd.ok || !middle.ok) throw new Error('unreachable')

    expect(bounded.value.records.map(record => record.event.seq))
      .toEqual(Array.from({ length: cut - secondEnd.seq + 1 }, (_, index) => secondEnd.seq + index))
    expect(bounded.value.records.slice(-thirdPrefix.length).map(record => record.event)).toEqual(thirdPrefix)
    expect(usageEnds(bounded.value.records)).toEqual([
      { type: 'event', event: secondEnd, turnUsage: expectedUsage(3) },
    ])
    expect(exactEnd.value.records).toEqual([{ type: 'event', event: thirdEnd, turnUsage: expectedUsage(2) }])
    expect(exactEnd.value.hasMore).toBe(true)
    expect(usageEnds(middle.value.records)).toEqual([
      { type: 'event', event: secondEnd, turnUsage: expectedUsage(3) },
    ])
    expect(types(middle.value)).not.toContain('turn/start')
  })

  it('keeps an orphan end unavailable even when its turn appears after the requested cut', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const orphan = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const completed = appendTurn(session, 1, 2)
    const address = { kind: 'session', sessionId: session.id } as const

    const past = await remote.page({ address, fromSeq: orphan.seq, throughSeq: orphan.seq })
    const current = await remote.page({ address, fromSeq: completed.seq, throughSeq: completed.seq })
    if (!past.ok || !current.ok) throw new Error('unreachable')
    expect(past.value.records).toEqual([{ type: 'event', event: orphan, turnUsage: null }])
    expect(current.value.records).toEqual([{ type: 'event', event: completed, turnUsage: expectedUsage(2) }])
  })

  it('includes hidden retried attempts and unpriced calls without changing step digests', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    const start = session.append('step/start', { turn: 1, step: 1 })
    const failure = { code: 'HTTP', message: 'retry this request' }
    session.append('assistant/attempt', {
      turn: 1, step: 1,
      stream: [
        { type: 'chunk', time: start.time, chunk: {
          type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, costUsd: 0.25 },
        } },
        { type: 'chunk', time: start.time, chunk: { type: 'finish', reason: { kind: 'error', failure } } },
      ],
    })
    const retryId = 'collapsed-history-retry' as SessionEvent<'llm/retry'>['data']['retryId']
    session.append('llm/retry', {
      retryId, turn: 1, step: 1, provider: 'p', mode: 'normal', policyKey: 'http',
      retry: 1, maxRetries: 1, delayMs: 0, failure,
    })
    session.append('llm/retry-started', { retryId, turn: 1, step: 1, retry: 1 })
    const assistant = appendAssistant(session, 1, 1, null, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    const firstEnd = session.append('step/end', { turn: 1, step: 1 })
    appendStep(session, 1, 2, null)
    appendStep(session, 1, 3, 'done')
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const address = { kind: 'session', sessionId: session.id } as const

    const full = await remote.page({ address, throughSeq: end.seq })
    const collapsed = await remote.page({ address, throughSeq: end.seq, stepDetail: 'collapsed' })
    if (!full.ok || !collapsed.ok) throw new Error('unreachable')
    expect(usageEnds(full.value.records)).toEqual([{
      type: 'event', event: end,
      turnUsage: { uncachedInputTokens: 32, outputTokens: 16, totalTokens: 48, costUsd: 0.5, unpricedCalls: 1 },
    }])
    expect(usageEnds(collapsed.value.records)).toEqual(usageEnds(full.value.records))
    expect(types(collapsed.value)).not.toContain('assistant/attempt')
    expect(types(collapsed.value)).not.toContain('llm/retry')
    expect(types(collapsed.value).filter(type => type === 'assistant/message')).toHaveLength(1)
    expect(collapsed.value.digests?.[0]).toEqual({
      turn: 1, step: 1, startSeq: start.seq, endSeq: firstEnd.seq,
      elided: 4, steps: 1, calls: 0, filePaths: [], added: 0, removed: 0,
      elapsedMs: assistant.time - start.time, inputTokens: 10, outputTokens: 5,
    })
  })

  it.each<{ name: string; usage: TokenUsage | null; expected: TurnTokenUsage | null }>([
    {
      name: 'an explicitly free attempt',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      expected: { ...expectedUsage(0), unpricedCalls: 0 },
    },
    {
      name: 'an unpriced attempt',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      expected: { ...expectedUsage(1), costUsd: 0, unpricedCalls: 1 },
    },
    { name: 'incomplete token accounting', usage: { inputTokens: 10, outputTokens: 5 }, expected: null },
    { name: 'missing token accounting', usage: null, expected: null },
  ])('distinguishes $name from unavailable turn usage', async ({ usage, expected }) => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    appendStep(session, 1, 1, 'done', usage)
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const address = { kind: 'session', sessionId: session.id } as const

    for (const stepDetail of ['full', 'collapsed'] as const) {
      const page = await remote.page({ address, throughSeq: end.seq, stepDetail })
      if (!page.ok) throw new Error('unreachable')
      expect(usageEnds(page.value.records)).toEqual([{ type: 'event', event: end, turnUsage: expected }])
    }
  })

  it('marks zero-attempt and duplicate-start turns unavailable without poisoning a later turn', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const empty = appendTurn(session, 1, 0)
    session.append('turn/start', { turn: 2 })
    appendStep(session, 2, 1, null)
    session.append('turn/start', { turn: 2 })
    appendStep(session, 2, 2, 'done')
    const duplicate = session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const complete = appendTurn(session, 3, 2)
    const address = { kind: 'session', sessionId: session.id } as const

    const page = await remote.page({ address, throughSeq: complete.seq, stepDetail: 'collapsed' })
    if (!page.ok) throw new Error('unreachable')
    expect(usageEnds(page.value.records)).toEqual([
      { type: 'event', event: empty, turnUsage: null },
      { type: 'event', event: duplicate, turnUsage: null },
      { type: 'event', event: complete, turnUsage: expectedUsage(2) },
    ])
  })

  it('reads cold usage without creating or resuming an Agent or returning hidden step bodies', async () => {
    const { ctx: fixture } = await harness()
    const session = fixture.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const end = appendTurn(session, 1, 3)
    using observation = await fixture.sessionQuery.observeSession(session.id, { projectionMode: 'none' })
    const { ctx } = await harness()
    const inspect = vi.fn(async () => ({ meta: observation.header, events: observation.events }))
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: async () => [observation.header], inspect,
    }) as never)
    const resume = vi.spyOn(ctx.agents, 'resume')
    const create = vi.spyOn(ctx.agents, 'create')
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const address = { kind: 'session', sessionId: session.id } as const

    const collapsed = await remote.page({ address, throughSeq: end.seq, stepDetail: 'collapsed' })
    const exact = await remote.page({ address, fromSeq: end.seq, throughSeq: end.seq })
    if (!collapsed.ok || !exact.ok) throw new Error('unreachable')
    expect(usageEnds(collapsed.value.records)).toEqual([{ type: 'event', event: end, turnUsage: expectedUsage(3) }])
    expect(exact.value.records).toEqual(usageEnds(collapsed.value.records))
    expect(types(collapsed.value).filter(type => type === 'assistant/message')).toHaveLength(1)
    expect(types(collapsed.value).filter(type => type === 'tool/result')).toHaveLength(1)
    expect(collapsed.value.digests?.map(digest => digest.step)).toEqual([1, 2])
    expect(inspect).toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(ctx.agents.list()).toEqual([])
    expect(ctx.sessions.get(session.id)).toBeUndefined()
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
      expect(usageEnds(frame.records).map(record => record.turnUsage)).toEqual([expectedUsage(2)])
      const full = await remote.page({ address: { kind: 'session', sessionId: session.id }, throughSeq: frame.cursor })
      if (!full.ok) throw new Error('unreachable')
      expect(usageEnds(frame.records)).toEqual(usageEnds(full.value.records))
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })

  it('seeds live follow accounting from earlier hidden steps when opened midturn', async () => {
    const { ctx } = await harness()
    const resume = vi.spyOn(ctx.agents, 'resume')
    const create = vi.spyOn(ctx.agents, 'create')
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    for (let step = 1; step <= 304; step += 1) appendStep(session, 1, step, null)
    session.append('step/start', { turn: 1, step: 305 })
    const address = { kind: 'session', sessionId: session.id } as const
    const abort = new AbortController()
    const iterator = remote.follow({ address, maxMessages: 300, stepDetail: 'collapsed' }, abort.signal)[Symbol.asyncIterator]()

    try {
      const opening = await iterator.next()
      const frame = opening.value as Extract<SessionFollowFrame, { type: 'snapshot' }>
      expect(frame.type).toBe('snapshot')
      expect(frame.hasMore).toBe(true)
      expect(frame.records.some(record => record.event.type === 'turn/start')).toBe(false)
      expect(frame.records.filter(record => record.event.type === 'assistant/message')).toEqual([])
      expect(frame.records.filter(record => record.event.type === 'tool/result')).toEqual([])
      expect(frame.digests).toHaveLength(300)
      expect(usageEnds(frame.records)).toEqual([])

      const live = [
        appendAssistant(session, 1, 305, 'done'),
        session.append('step/end', { turn: 1, step: 305 }),
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }),
        session.append('turn/start', { turn: 2 }),
        ...appendStep(session, 2, 1, 'next turn'),
        session.append('turn/end', { turn: 2, reason: { kind: 'completed' } }),
      ]
      const delivered: SessionEventEntry[] = []
      for (const event of live) {
        const next = await iterator.next()
        expect(next.done).toBe(false)
        expect(next.value).toEqual({
          type: 'event', event,
          ...event.type === 'turn/end' ? { turnUsage: expectedUsage(event.data.turn === 1 ? 305 : 1) } : {},
        })
        delivered.push(next.value as SessionEventEntry)
      }
      expect(usageEnds(delivered).map(record => record.turnUsage)).toEqual([expectedUsage(305), expectedUsage(1)])
      const page = await remote.page({ address, throughSeq: session.seq - 1, stepDetail: 'collapsed' })
      if (!page.ok) throw new Error('unreachable')
      expect(usageEnds(page.value.records)).toEqual(usageEnds(delivered))
      expect(resume).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      expect(ctx.agents.list()).toEqual([])
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })
})

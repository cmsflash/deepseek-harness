import { describe, expect, it } from 'vitest'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TurnTokenUsage } from '@deepseek-ai/dsh-token-meter/turn-usage'
import { HistoryTurnUsage, historyTurnUsage } from '../src/turn-usage.ts'

const USAGE: TokenUsage = {
  inputTokens: 7, outputTokens: 3, totalTokens: 17,
  cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 1, costUsd: 0.25,
}
const EXPECTED: TurnTokenUsage = {
  uncachedInputTokens: 7, outputTokens: 3, totalTokens: 17,
  cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 1,
  routes: [{ provider: 'p', model: 'm' }], costUsd: 0.25, unpricedCalls: 0,
}

function event<T extends SessionEvent['type']>(
  seq: number,
  type: T,
  data: SessionEvent<T>['data'],
): SessionEvent<T> {
  return {
    seq: SessionSeq(seq), time: seq, type, data,
    ...type === 'assistant/message' ? { surfaceOp: 'append' } : {},
  } as SessionEvent<T>
}

function step(seq: number, turn: number, stepNumber: number, usage: TokenUsage | null = USAGE): SessionEvent[] {
  return [
    event(seq, 'step/start', { turn, step: stepNumber }),
    event(seq + 1, 'assistant/message', {
      turn, step: stepNumber,
      message: createMessage({
        role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' },
      }),
      stream: [],
      ...usage === null ? {} : { usage },
    }),
    event(seq + 2, 'step/end', { turn, step: stepNumber }),
  ]
}

function completeTurn(turn = 1, seq = 0, usage: TokenUsage | null = USAGE): SessionEvent[] {
  return [
    event(seq, 'turn/start', { turn }),
    ...step(seq + 1, turn, 1, usage),
    event(seq + 4, 'turn/end', { turn, reason: { kind: 'completed' } }),
  ]
}

describe('HistoryTurnUsage', () => {
  it('returns metadata only for a turn end and leaves durable events unchanged', () => {
    const history = new HistoryTurnUsage()
    const events = completeTurn(1, 1)
    const original = structuredClone(events)

    expect(history.append(event(0, 'session/end-seed', {}))).toBeUndefined()
    expect(events.map(entry => history.append(entry))).toEqual([
      undefined, undefined, undefined, undefined, EXPECTED,
    ])
    expect(events).toEqual(original)
    expect(history.append(event(6, 'session/end-seed', {}))).toBeUndefined()
    expect(history.append(event(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))).toBeNull()
  })

  it.each([
    ['orphan end', [event(0, 'turn/end', { turn: 1, reason: { kind: 'completed' } })]],
    ['missing start', completeTurn().slice(1)],
    ['mismatched end', [
      ...completeTurn().slice(0, -1),
      event(4, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]],
    ['unfinished step', [
      ...completeTurn().slice(0, -2),
      event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]],
    ['zero attempts', [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]],
    ['missing usage', completeTurn(1, 0, null)],
    ['inexact usage', completeTurn(1, 0, { inputTokens: 7, outputTokens: 3 })],
    ['contradictory usage', completeTurn(1, 0, { ...USAGE, totalTokens: 18 })],
  ] as const)('returns null for %s and starts the next turn independently', (_label, events) => {
    const history = new HistoryTurnUsage()
    const results = events.map(entry => history.append(entry))
    expect(results.slice(0, -1)).toEqual(events.slice(0, -1).map(() => undefined))
    expect(results.at(-1)).toBeNull()
    expect(completeTurn(3, 10).map(entry => history.append(entry))).toEqual([
      undefined, undefined, undefined, undefined, EXPECTED,
    ])
  })

  it.each([
    ['valid', USAGE],
    ['unavailable', null],
  ] as const)('does not reset %s accounting at a duplicate same-turn start', (_label, usage) => {
    const history = new HistoryTurnUsage()
    const events = [
      event(0, 'turn/start', { turn: 1 }),
      ...step(1, 1, 1, usage),
      event(4, 'turn/start', { turn: 1 }),
      ...step(5, 1, 2),
      event(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    expect(events.map(entry => history.append(entry))).toEqual([
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null,
    ])
  })

  it('starts a distinct turn after an abandoned turn without carrying its attempts', () => {
    const history = new HistoryTurnUsage()
    for (const entry of completeTurn().slice(0, -1)) expect(history.append(entry)).toBeUndefined()
    expect(completeTurn(2, 4).map(entry => history.append(entry))).toEqual([
      undefined, undefined, undefined, undefined, EXPECTED,
    ])
    expect(history.append(event(9, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))).toBeNull()
  })

  it('preserves explicit zero counts and cost instead of marking a billed attempt unavailable', () => {
    const history = new HistoryTurnUsage()
    const events = completeTurn(1, 0, {
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0,
    })
    expect(events.map(entry => history.append(entry)).at(-1)).toEqual({
      uncachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      routes: [{ provider: 'p', model: 'm' }], costUsd: 0, unpricedCalls: 0,
    })
  })

  it('retains exact token usage while distinguishing missing price and optional buckets', () => {
    const history = new HistoryTurnUsage()
    const events = completeTurn(1, 0, { inputTokens: 7, outputTokens: 3, totalTokens: 17 })
    expect(events.map(entry => history.append(entry)).at(-1)).toEqual({
      uncachedInputTokens: 7, outputTokens: 3, totalTokens: 17,
      routes: [{ provider: 'p', model: 'm' }], costUsd: 0, unpricedCalls: 1,
    })
  })
})

describe('historyTurnUsage', () => {
  it('uses the whole prefix but publishes only ends included in the served page', () => {
    const scope = [
      ...completeTurn(),
      ...completeTurn(2, 5, { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0 }),
      ...completeTurn(3, 10),
    ]
    const page = scope.slice(6, 10)
    expect(page.some(entry => entry.type === 'turn/start')).toBe(false)
    const { byEnd } = historyTurnUsage(page, scope)
    expect([...byEnd]).toEqual([[9, {
      uncachedInputTokens: 1, outputTokens: 2, totalTokens: 3,
      routes: [{ provider: 'p', model: 'm' }], costUsd: 0, unpricedCalls: 0,
    }]])
    expect(historyTurnUsage([], scope).byEnd.size).toBe(0)
  })

  it('keeps separate end-sequence records when later history reuses a turn number', () => {
    const scope = [
      event(0, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ...completeTurn(1, 1),
      event(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    const { byEnd } = historyTurnUsage(scope, scope)
    expect([...byEnd]).toEqual([[0, null], [5, EXPECTED], [6, null]])
    expect([...historyTurnUsage(scope.slice(0, 1), scope.slice(0, 1)).byEnd]).toEqual([[0, null]])
  })

  it('continues the open turn from hidden prefix steps even when no end was served', () => {
    const scope = [
      ...completeTurn(),
      event(5, 'turn/start', { turn: 2 }),
      ...step(6, 2, 1),
      event(9, 'step/start', { turn: 2, step: 2 }),
    ]
    const { byEnd, continuation } = historyTurnUsage(scope.slice(-2), scope)
    expect(byEnd.size).toBe(0)
    const live = [
      ...step(9, 2, 2).slice(1),
      event(12, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]
    expect(live.map(entry => continuation.append(entry))).toEqual([
      undefined, undefined,
      {
        uncachedInputTokens: 14, outputTokens: 6, totalTokens: 34,
        cacheReadTokens: 10, cacheWriteTokens: 4, reasoningTokens: 2,
        routes: [{ provider: 'p', model: 'm' }], costUsd: 0.5, unpricedCalls: 0,
      },
    ])
    expect(byEnd.size).toBe(0)
  })

  it('keeps duplicate-start invalidity in a continuation whose page hides the first start', () => {
    const scope = [
      ...completeTurn().slice(0, -1),
      event(4, 'turn/start', { turn: 1 }),
      ...step(5, 1, 2),
    ]
    const { byEnd, continuation } = historyTurnUsage(scope.slice(4), scope)
    expect(byEnd.size).toBe(0)
    expect(continuation.append(event(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))).toBeNull()
  })

  it('keeps a completed snapshot stable while its continuation accounts for later turns', () => {
    const scope = completeTurn()
    const { byEnd, continuation } = historyTurnUsage(scope.slice(-1), scope)
    expect([...byEnd]).toEqual([[4, EXPECTED]])
    expect(completeTurn(2, 5).map(entry => continuation.append(entry))).toEqual([
      undefined, undefined, undefined, undefined, EXPECTED,
    ])
    expect([...byEnd]).toEqual([[4, EXPECTED]])
  })

  it('returns an empty summary and fresh continuation for an empty source', () => {
    const { byEnd, continuation } = historyTurnUsage([], [])
    expect(byEnd.size).toBe(0)
    expect(completeTurn().map(entry => continuation.append(entry))).toEqual([
      undefined, undefined, undefined, undefined, EXPECTED,
    ])
  })
})

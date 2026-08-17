/**
 * The focus metric fold: per-turn step/call counts, diff line deltas, token
 * sums, turn wall time, and which turn the view renders in full.
 */
import { describe, expect, it } from 'vitest'
import type {
  ConversationNode, ConversationTimelineSnapshot, TurnLocation,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  deriveFocusMetrics, diffLineDelta, readUsage, totalTokens,
} from '../src/client/turn-summary.ts'

function assistant(options: {
  seq: number
  turn: number
  step?: number
  usage?: unknown
}): ConversationNode {
  return {
    kind: 'assistant',
    seq: options.seq,
    time: options.seq * 1_000,
    turn: options.turn,
    step: options.step ?? 1,
    blocks: [],
    ...options.usage === undefined ? {} : { usage: options.usage },
  }
}

function toolResult(options: {
  seq: number
  callId: string
  name?: string
  diffs?: unknown
  subCalls?: readonly ConversationNode[]
}): ConversationNode {
  return {
    kind: 'tool-result',
    seq: options.seq,
    time: options.seq * 1_000,
    callId: options.callId,
    call: { name: options.name ?? 'edit', argsRaw: '{}' },
    callTime: options.seq * 1_000 - 500,
    content: [],
    isError: false,
    callView: null,
    resultView: options.diffs === undefined ? null : { card: 'diff', diffs: options.diffs },
    subCalls: options.subCalls ?? [],
  } as unknown as ConversationNode
}

function timeline(turns: readonly { turn: number; start?: number; end?: number }[]): ConversationTimelineSnapshot {
  const map = new Map<number, TurnLocation>()
  for (const entry of turns) {
    map.set(entry.turn, {
      turn: entry.turn,
      start: entry.start === undefined ? undefined : { seq: entry.start, time: entry.start * 1_000 },
      end: entry.end === undefined ? undefined : { seq: entry.end, time: entry.end * 1_000 },
      status: entry.end === undefined ? 'open' : 'closed',
      steps: [],
      data: { get: () => undefined },
    } as unknown as TurnLocation)
  }
  return { turnOrder: turns.map(entry => entry.turn), turns: map }
}

describe('diffLineDelta', () => {
  it('counts a created file as all additions', () => {
    expect(diffLineDelta({ path: 'a.ts', oldText: null, newText: 'one\ntwo\n' }))
      .toEqual({ added: 2, removed: 0 })
  })

  it('counts a modified line as one addition and one removal', () => {
    expect(diffLineDelta({ path: 'a.ts', oldText: 'one\ntwo\n', newText: 'one\nTWO\n' }))
      .toEqual({ added: 1, removed: 1 })
  })

  it('counts a pure insertion without charging the untouched lines', () => {
    expect(diffLineDelta({ path: 'a.ts', oldText: 'one\ntwo\n', newText: 'one\nmid\ntwo\n' }))
      .toEqual({ added: 1, removed: 0 })
  })

  it('counts a deletion', () => {
    expect(diffLineDelta({ path: 'a.ts', oldText: 'one\ntwo\nthree\n', newText: 'one\nthree\n' }))
      .toEqual({ added: 0, removed: 1 })
  })

  it('treats a reordered line as unchanged', () => {
    expect(diffLineDelta({ path: 'a.ts', oldText: 'one\ntwo\n', newText: 'two\none\n' }))
      .toEqual({ added: 0, removed: 0 })
  })

  it('reports nothing for an identical before and after image', () => {
    expect(diffLineDelta({ path: 'a.ts', oldText: 'same\n', newText: 'same\n' }))
      .toEqual({ added: 0, removed: 0 })
  })

  it('does not charge a newly added trailing newline as a line', () => {
    expect(diffLineDelta({ path: 'a.ts', oldText: 'one', newText: 'one\n' }))
      .toEqual({ added: 0, removed: 0 })
  })

  it('does not charge a removed trailing newline as a line', () => {
    expect(diffLineDelta({ path: 'a.ts', oldText: 'one\n', newText: 'one' }))
      .toEqual({ added: 0, removed: 0 })
  })

  it('counts an empty created file as no lines', () => {
    expect(diffLineDelta({ path: 'a.ts', oldText: null, newText: '' }))
      .toEqual({ added: 0, removed: 0 })
  })

  it('counts a created file with no trailing newline', () => {
    expect(diffLineDelta({ path: 'a.ts', oldText: null, newText: 'one\ntwo' }))
      .toEqual({ added: 2, removed: 0 })
  })

  it('charges an appended line once when the old image had no trailing newline', () => {
    expect(diffLineDelta({ path: 'a.ts', oldText: 'one', newText: 'one\ntwo\n' }))
      .toEqual({ added: 1, removed: 0 })
  })

  it('charges a deleted line once when the new image has no trailing newline', () => {
    expect(diffLineDelta({ path: 'a.ts', oldText: 'one\ntwo\n', newText: 'one' }))
      .toEqual({ added: 0, removed: 1 })
  })

  it('does not double-charge a removal when only the new image terminates', () => {
    // added stays 0, so the newTerminated correction must not fire.
    expect(diffLineDelta({ path: 'a.ts', oldText: 'one\ntwo', newText: 'one\n' }))
      .toEqual({ added: 0, removed: 1 })
  })

  it('does not double-charge an addition when only the old image terminates', () => {
    // removed stays 0, so the oldTerminated correction must not fire.
    expect(diffLineDelta({ path: 'a.ts', oldText: 'one\n', newText: 'one\ntwo' }))
      .toEqual({ added: 1, removed: 0 })
  })

  it('reports a whole-file replacement as every line on both sides', () => {
    expect(diffLineDelta({ path: 'a.ts', oldText: 'a\nb\n', newText: 'c\nd\n' }))
      .toEqual({ added: 2, removed: 2 })
  })
})

describe('readUsage', () => {
  it('sums the three disjoint prompt-side buckets into billed input', () => {
    expect(readUsage({ inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2, outputTokens: 7 }))
      .toEqual({ input: 17, output: 7, cacheRead: 5 })
  })

  it('reads zeros from a provider that reported nothing', () => {
    for (const usage of [undefined, null, {}, 'nope', { inputTokens: -1, outputTokens: Number.NaN }]) {
      expect(readUsage(usage)).toEqual({ input: 0, output: 0, cacheRead: 0 })
    }
  })
})

describe('deriveFocusMetrics', () => {
  it('collapses earlier turns and leaves the latest turn out of the summaries', () => {
    const nodes = [
      assistant({ seq: 2, turn: 1, usage: { inputTokens: 100, outputTokens: 20 } }),
      toolResult({ seq: 3, callId: 'c1', diffs: [{ path: 'a.ts', oldText: 'one\n', newText: 'one\ntwo\n' }] }),
      assistant({ seq: 5, turn: 2, usage: { inputTokens: 40, outputTokens: 4 } }),
    ]
    const metrics = deriveFocusMetrics(nodes, timeline([
      { turn: 1, start: 1, end: 4 },
      { turn: 2, start: 5 },
    ]), false)
    expect(metrics.latestTurn).toBe(2)
    expect(metrics.truncated).toBe(false)
    expect(metrics.previous).toHaveLength(1)
    const [first] = metrics.previous
    expect(first).toMatchObject({
      turn: 1,
      steps: 1,
      calls: 1,
      filesTouched: 1,
      lines: { added: 1, removed: 0 },
      elapsedMs: 3_000,
      boundaryKnown: true,
    })
    expect(totalTokens(first!.tokens)).toBe(120)
  })

  it('attributes a tool result to the turn of the preceding assistant step', () => {
    const nodes = [
      assistant({ seq: 1, turn: 1 }),
      toolResult({ seq: 2, callId: 'c1' }),
      assistant({ seq: 3, turn: 2 }),
      toolResult({ seq: 4, callId: 'c2' }),
      toolResult({ seq: 5, callId: 'c3' }),
      assistant({ seq: 6, turn: 3 }),
    ]
    const metrics = deriveFocusMetrics(nodes, timeline([
      { turn: 1, start: 0, end: 2 }, { turn: 2, start: 3, end: 5 }, { turn: 3, start: 6 },
    ]), false)
    expect(metrics.previous.map(summary => [summary.turn, summary.calls]))
      .toEqual([[1, 1], [2, 2]])
  })

  it('counts nested subcalls into the owning turn', () => {
    const nodes = [
      assistant({ seq: 1, turn: 1 }),
      toolResult({
        seq: 2,
        callId: 'root',
        subCalls: [
          toolResult({ seq: 3, callId: 'child', diffs: [{ path: 'b.ts', oldText: null, newText: 'x\n' }] }),
        ],
      }),
      assistant({ seq: 9, turn: 2 }),
    ]
    const metrics = deriveFocusMetrics(nodes, timeline([{ turn: 1, start: 0, end: 8 }, { turn: 2, start: 9 }]), false)
    expect(metrics.previous[0]).toMatchObject({ calls: 2, filesTouched: 1, lines: { added: 1, removed: 0 } })
  })

  it('drops a tool result that precedes every in-window step rather than misattributing it', () => {
    const nodes = [toolResult({ seq: 1, callId: 'orphan' }), assistant({ seq: 2, turn: 7 })]
    const metrics = deriveFocusMetrics(nodes, timeline([{ turn: 7, start: 2 }]), true)
    expect(metrics.previous).toEqual([])
    expect(metrics.latestTurn).toBe(7)
    expect(metrics.truncated).toBe(true)
  })

  it('marks a turn whose start is outside the window and leaves its elapsed time absent', () => {
    const nodes = [assistant({ seq: 5, turn: 4 }), assistant({ seq: 7, turn: 5 })]
    const metrics = deriveFocusMetrics(nodes, timeline([{ turn: 4, end: 6 }, { turn: 5, start: 7 }]), true)
    expect(metrics.previous[0]).toMatchObject({ turn: 4, boundaryKnown: false })
    expect(metrics.previous[0]?.elapsedMs).toBeUndefined()
  })

  it('keeps a started-but-stepless turn as the latest, so it renders live', () => {
    const nodes = [assistant({ seq: 2, turn: 1 })]
    const metrics = deriveFocusMetrics(nodes, timeline([{ turn: 1, start: 1, end: 3 }, { turn: 2, start: 4 }]), false)
    expect(metrics.latestTurn).toBe(2)
    expect(metrics.previous.map(summary => summary.turn)).toEqual([1])
  })

  it('reports an empty fold for an empty window', () => {
    expect(deriveFocusMetrics([], timeline([]), false))
      .toEqual({ previous: [], latestTurn: undefined, truncated: false })
  })

  it('ignores a malformed wire diff payload instead of throwing', () => {
    for (const diffs of [undefined, 'nope', [null], [{ path: 1 }], [{ path: 'a', newText: 2 }], [{ path: 'a', oldText: 3, newText: 'x' }]]) {
      const nodes = [
        assistant({ seq: 1, turn: 1 }),
        toolResult({ seq: 2, callId: 'c1', diffs }),
        assistant({ seq: 3, turn: 2 }),
      ]
      const metrics = deriveFocusMetrics(nodes, timeline([{ turn: 1, start: 0, end: 2 }, { turn: 2, start: 3 }]), false)
      expect(metrics.previous[0]).toMatchObject({ calls: 1, lines: { added: 0, removed: 0 }, filesTouched: 0 })
    }
  })

  it('counts a still-running subcall without waiting for its result', () => {
    const running = {
      callId: 'child-running',
      name: 'bash',
      argsRaw: '{}',
      turn: 1,
      step: 1,
      time: 2_500,
      callView: null,
      subCalls: [],
    } as unknown as ConversationNode
    const nodes = [
      assistant({ seq: 1, turn: 1 }),
      toolResult({ seq: 2, callId: 'root', subCalls: [running] }),
      assistant({ seq: 3, turn: 2 }),
    ]
    const metrics = deriveFocusMetrics(nodes, timeline([{ turn: 1, start: 0, end: 2 }, { turn: 2, start: 3 }]), false)
    expect(metrics.previous[0]).toMatchObject({ calls: 2 })
  })

  it('reports cache reads only for a turn whose provider reported them', () => {
    const nodes = [
      assistant({ seq: 1, turn: 1, usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5 } }),
      assistant({ seq: 3, turn: 2, usage: { inputTokens: 10, outputTokens: 5 } }),
      assistant({ seq: 5, turn: 3 }),
    ]
    const metrics = deriveFocusMetrics(nodes, timeline([
      { turn: 1, start: 0, end: 2 }, { turn: 2, start: 2, end: 4 }, { turn: 3, start: 5 },
    ]), false)
    expect(metrics.previous[0]?.tokens).toEqual({ input: 100, output: 5, cacheRead: 90 })
    expect(metrics.previous[1]?.tokens).toEqual({ input: 10, output: 5 })
  })

  it('falls back to the folded turns when the timeline knows no turn order', () => {
    const nodes = [assistant({ seq: 1, turn: 4 }), assistant({ seq: 2, turn: 5 })]
    const metrics = deriveFocusMetrics(nodes, timeline([]), false)
    expect(metrics.latestTurn).toBe(5)
    expect(metrics.previous.map(summary => summary.turn)).toEqual([4])
  })

  it('counts one file once across repeated edits to it', () => {
    const nodes = [
      assistant({ seq: 1, turn: 1 }),
      toolResult({ seq: 2, callId: 'c1', diffs: [{ path: 'a.ts', oldText: 'one\n', newText: 'two\n' }] }),
      toolResult({ seq: 3, callId: 'c2', diffs: [{ path: 'a.ts', oldText: 'two\n', newText: 'three\n' }] }),
      assistant({ seq: 4, turn: 2 }),
    ]
    const metrics = deriveFocusMetrics(nodes, timeline([{ turn: 1, start: 0, end: 3 }, { turn: 2, start: 4 }]), false)
    expect(metrics.previous[0]).toMatchObject({ filesTouched: 1, lines: { added: 2, removed: 2 } })
  })
})

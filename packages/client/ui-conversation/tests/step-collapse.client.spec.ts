/**
 * Step-collapse fold: each turn keeps only its last step visible, earlier
 * steps fold into one marker per turn, and expansion restores them in place.
 */
import { describe, expect, it } from 'vitest'
import type { ChatConversationViewNode, ChatNodeStore } from '@deepseek-ai/dsh-client-runtime/client'
import { collapseSettledSteps, diffLineDelta } from '../src/client/chat/step-collapse.ts'

const EMPTY: ReadonlySet<number> = new Set()

function node(options: {
  key: string
  kind?: string
  turn?: number
  step?: number
  data?: unknown
}): ChatConversationViewNode {
  const { turn, step } = options
  const location = turn === undefined
    ? { kind: 'session' as const }
    : step === undefined
      ? { kind: 'turn' as const, turn: { turn } }
      : { kind: 'step' as const, turn: { turn }, step: { step } }
  return {
    key: options.key,
    kind: options.kind ?? 'assistant-step',
    id: options.key,
    target: 'chat',
    anchorSeq: 0,
    visibility: 'visible',
    location,
    data: options.data,
  } as unknown as ChatConversationViewNode
}

function store(nodes: readonly ChatConversationViewNode[]): ChatNodeStore {
  const byKey = new Map(nodes.map(entry => [entry.key, entry]))
  return { get: key => byKey.get(key), values: () => nodes }
}

/** A settled tool root whose result view carries one applied diff. */
function toolNode(key: string, turn: number, step: number, options: {
  diffs?: unknown
  subCalls?: readonly unknown[]
} = {}): ChatConversationViewNode {
  return node({
    key,
    kind: 'tool-call',
    turn,
    step,
    data: {
      root: {
        kind: 'tool-result',
        callId: key,
        resultView: options.diffs === undefined ? null : { card: 'diff', diffs: options.diffs },
        subCalls: options.subCalls ?? [],
      },
    },
  })
}

describe('diffLineDelta', () => {
  it('counts a created file as all additions', () => {
    expect(diffLineDelta(null, 'one\ntwo\n')).toEqual({ added: 2, removed: 0 })
  })

  it('counts a modified line as one addition and one removal', () => {
    expect(diffLineDelta('one\ntwo\n', 'one\nTWO\n')).toEqual({ added: 1, removed: 1 })
  })

  it('treats a reordered line as unchanged', () => {
    expect(diffLineDelta('one\ntwo\n', 'two\none\n')).toEqual({ added: 0, removed: 0 })
  })

  it('ignores a terminating newline on either side', () => {
    expect(diffLineDelta('one', 'one\n')).toEqual({ added: 0, removed: 0 })
    expect(diffLineDelta('one\n', 'one')).toEqual({ added: 0, removed: 0 })
  })

  it('counts an empty created file as no lines', () => {
    expect(diffLineDelta(null, '')).toEqual({ added: 0, removed: 0 })
  })
})

describe('collapseSettledSteps', () => {
  it('keeps a turn whose only step is the last one fully visible', () => {
    const nodes = [node({ key: 'a', turn: 1, step: 1 })]
    const rows = collapseSettledSteps(['a'], store(nodes), EMPTY)
    expect(rows).toEqual([{ kind: 'node', key: 'a' }])
  })

  it('collapses every earlier step of a turn into one marker', () => {
    const nodes = [
      node({ key: 's1', turn: 1, step: 1 }),
      node({ key: 's2', turn: 1, step: 2 }),
      node({ key: 's3', turn: 1, step: 3 }),
    ]
    const rows = collapseSettledSteps(['s1', 's2', 's3'], store(nodes), EMPTY)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: 'collapsed', turn: 1 })
    expect(rows[1]).toEqual({ kind: 'node', key: 's3' })
    // Both earlier steps hide behind the single marker.
    expect((rows[0] as { keys: readonly string[] }).keys).toEqual(['s1', 's2'])
    expect((rows[0] as { metrics: { steps: number } }).metrics.steps).toBe(2)
  })

  it('keeps rows outside any step visible', () => {
    const nodes = [
      node({ key: 'ask', kind: 'user' }),
      node({ key: 's1', turn: 1, step: 1 }),
      node({ key: 's2', turn: 1, step: 2 }),
      node({ key: 'tail', kind: 'turn-tail', turn: 1 }),
    ]
    const rows = collapseSettledSteps(['ask', 's1', 's2', 'tail'], store(nodes), EMPTY)
    expect(rows.map(row => (row.kind === 'node' ? row.key : `collapsed:${String(row.turn)}`)))
      .toEqual(['ask', 'collapsed:1', 's2', 'tail'])
  })

  it('collapses each turn independently', () => {
    const nodes = [
      node({ key: 'a1', turn: 1, step: 1 }),
      node({ key: 'a2', turn: 1, step: 2 }),
      node({ key: 'b1', turn: 2, step: 1 }),
      node({ key: 'b2', turn: 2, step: 2 }),
    ]
    const rows = collapseSettledSteps(['a1', 'a2', 'b1', 'b2'], store(nodes), EMPTY)
    expect(rows.map(row => (row.kind === 'node' ? row.key : `collapsed:${String(row.turn)}`)))
      .toEqual(['collapsed:1', 'a2', 'collapsed:2', 'b2'])
  })

  it('restores the hidden rows in place when the turn is expanded, keeping the marker', () => {
    const nodes = [
      node({ key: 's1', turn: 1, step: 1 }),
      node({ key: 's2', turn: 1, step: 2 }),
      node({ key: 's3', turn: 1, step: 3 }),
    ]
    const rows = collapseSettledSteps(['s1', 's2', 's3'], store(nodes), new Set([1]))
    expect(rows.map(row => (row.kind === 'node' ? row.key : `collapsed:${String(row.turn)}`)))
      .toEqual(['collapsed:1', 's1', 's2', 's3'])
  })

  it('expands one turn without disturbing another', () => {
    const nodes = [
      node({ key: 'a1', turn: 1, step: 1 }),
      node({ key: 'a2', turn: 1, step: 2 }),
      node({ key: 'b1', turn: 2, step: 1 }),
      node({ key: 'b2', turn: 2, step: 2 }),
    ]
    const rows = collapseSettledSteps(['a1', 'a2', 'b1', 'b2'], store(nodes), new Set([2]))
    expect(rows.map(row => (row.kind === 'node' ? row.key : `collapsed:${String(row.turn)}`)))
      .toEqual(['collapsed:1', 'a2', 'collapsed:2', 'b1', 'b2'])
  })

  it('folds tool calls, nested subcalls, and diff lines into the marker metrics', () => {
    const nodes = [
      node({ key: 's1', turn: 1, step: 1 }),
      toolNode('t1', 1, 1, {
        diffs: [{ path: 'a.ts', oldText: 'one\n', newText: 'one\ntwo\n' }],
        subCalls: [{ kind: 'tool-result', callId: 'child', resultView: null, subCalls: [] }],
      }),
      node({ key: 's2', turn: 1, step: 2 }),
    ]
    const rows = collapseSettledSteps(['s1', 't1', 's2'], store(nodes), EMPTY)
    expect((rows[0] as { metrics: unknown }).metrics)
      .toEqual({ steps: 1, calls: 2, files: 1, added: 1, removed: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0 })
  })

  it('ignores a malformed wire diff payload instead of throwing', () => {
    for (const diffs of [undefined, 'nope', [null], [{ path: 1 }], [{ path: 'a', newText: 2 }]]) {
      const nodes = [
        toolNode('t1', 1, 1, { diffs }),
        node({ key: 's2', turn: 1, step: 2 }),
      ]
      const rows = collapseSettledSteps(['t1', 's2'], store(nodes), EMPTY)
      expect((rows[0] as { metrics: { calls: number; added: number } }).metrics)
        .toMatchObject({ calls: 1, added: 0, removed: 0, files: 0 })
    }
  })

  it('counts one file once across repeated edits inside the collapsed group', () => {
    const nodes = [
      toolNode('t1', 1, 1, { diffs: [{ path: 'a.ts', oldText: 'one\n', newText: 'two\n' }] }),
      toolNode('t2', 1, 1, { diffs: [{ path: 'a.ts', oldText: 'two\n', newText: 'three\n' }] }),
      node({ key: 's2', turn: 1, step: 2 }),
    ]
    const rows = collapseSettledSteps(['t1', 't2', 's2'], store(nodes), EMPTY)
    expect((rows[0] as { metrics: { files: number; added: number } }).metrics)
      .toMatchObject({ files: 1, added: 2, removed: 2 })
  })

  it('never collapses the prompting message or context injections inside a step window', () => {
    // The engine assigns a step Location by log position, so these rows carry
    // one; hiding them would remove the reader's own words.
    const nodes = [
      node({ key: 'ask', kind: 'user', turn: 1, step: 1 }),
      node({ key: 'ctx1', kind: 'context', turn: 1, step: 1 }),
      toolNode('t1', 1, 1),
      node({ key: 'a1', kind: 'assistant-step', turn: 1, step: 1 }),
      node({ key: 'a2', kind: 'assistant-step', turn: 1, step: 2 }),
      node({ key: 'tail', kind: 'turn-tail', turn: 1 }),
    ]
    const rows = collapseSettledSteps(['ask', 'ctx1', 't1', 'a1', 'a2', 'tail'], store(nodes), EMPTY)
    expect(rows.map(r => (r.kind === 'node' ? r.key : `collapsed:${String(r.turn)}`)))
      .toEqual(['ask', 'ctx1', 'collapsed:1', 'a2', 'tail'])
  })

  it('counts one step per assistant node even when its work is all tool calls', () => {
    const nodes = [
      node({ key: 'a1', kind: 'assistant-step', turn: 1, step: 1 }),
      toolNode('t1', 1, 1),
      toolNode('t2', 1, 1),
      node({ key: 'a2', kind: 'assistant-step', turn: 1, step: 2 }),
      toolNode('t3', 1, 2),
      node({ key: 'a3', kind: 'assistant-step', turn: 1, step: 3 }),
    ]
    const rows = collapseSettledSteps(['a1', 't1', 't2', 'a2', 't3', 'a3'], store(nodes), EMPTY)
    const metrics = (rows[0] as { metrics: { steps: number; calls: number } }).metrics
    expect(metrics).toMatchObject({ steps: 2, calls: 3 })
  })

  it('sums wall time and provider tokens across the hidden steps', () => {
    const step = (key: string, stepNo: number, data: unknown) =>
      node({ key, kind: 'assistant-step', turn: 1, step: stepNo, data })
    const nodes = [
      step('a1', 1, {
        usage: { inputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 5, outputTokens: 7 },
        finalNode: { timing: { stepStartTime: 1_000, completedTime: 3_000 } },
      }),
      step('a2', 2, {
        usage: { inputTokens: 20, outputTokens: 3 },
        finalNode: { timing: { stepStartTime: 3_000, completedTime: 4_500 } },
      }),
      step('a3', 3, {}),
    ]
    const rows = collapseSettledSteps(['a1', 'a2', 'a3'], store(nodes), EMPTY)
    expect((rows[0] as { metrics: unknown }).metrics).toMatchObject({
      steps: 2, elapsedMs: 3_500, inputTokens: 125, outputTokens: 10,
    })
  })

  it('leaves time and tokens at zero when the provider reported neither', () => {
    const nodes = [
      node({ key: 'a1', kind: 'assistant-step', turn: 1, step: 1, data: { usage: 'nope' } }),
      // A step whose start left the loaded window contributes no wall time.
      node({ key: 'a2', kind: 'assistant-step', turn: 1, step: 2, data: {
        finalNode: { timing: { stepStartTime: null, completedTime: 9_000 } },
      } }),
      node({ key: 'a3', kind: 'assistant-step', turn: 1, step: 3 }),
    ]
    const rows = collapseSettledSteps(['a1', 'a2', 'a3'], store(nodes), EMPTY)
    expect((rows[0] as { metrics: unknown }).metrics).toMatchObject({
      steps: 2, elapsedMs: 0, inputTokens: 0, outputTokens: 0,
    })
  })

  it('keeps the in-flight step visible while a turn streams', () => {
    // The running step is the turn's highest, so it stays out of the marker
    // and the reader watches current work without expanding anything.
    const nodes = [
      node({ key: 's1', turn: 1, step: 1 }),
      node({ key: 's2', turn: 1, step: 2 }),
      node({ key: 'live', turn: 1, step: 3 }),
    ]
    const rows = collapseSettledSteps(['s1', 's2', 'live'], store(nodes), EMPTY)
    expect(rows.at(-1)).toEqual({ kind: 'node', key: 'live' })
  })

  it('moves the previously live step into the marker once a later step opens', () => {
    const base = [node({ key: 's1', turn: 1, step: 1 }), node({ key: 's2', turn: 1, step: 2 })]
    const before = collapseSettledSteps(['s1', 's2'], store(base), EMPTY)
    expect(before.at(-1)).toEqual({ kind: 'node', key: 's2' })
    const grown = [...base, node({ key: 's3', turn: 1, step: 3 })]
    const after = collapseSettledSteps(['s1', 's2', 's3'], store(grown), EMPTY)
    expect(after.at(-1)).toEqual({ kind: 'node', key: 's3' })
    expect((after[0] as { keys: readonly string[] }).keys).toEqual(['s1', 's2'])
  })

  it('skips a key the store no longer serves', () => {
    const nodes = [node({ key: 's1', turn: 1, step: 1 })]
    expect(collapseSettledSteps(['gone', 's1'], store(nodes), EMPTY))
      .toEqual([{ kind: 'node', key: 's1' }])
  })

  it('returns nothing for an empty order', () => {
    expect(collapseSettledSteps([], store([]), EMPTY)).toEqual([])
  })
})

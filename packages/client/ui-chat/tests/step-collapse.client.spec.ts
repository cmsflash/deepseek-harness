/**
 * Step-collapse fold: each human input starts a response group within its
 * turn; each group keeps its last step and its answer visible, earlier steps
 * fold into that group's marker, and expansion restores them in place.
 */
import { describe, expect, it } from 'vitest'
import type { ChatConversationViewNode, ChatNodeStore, ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { StepDigestsByTurn } from '@deepseek-ai/dsh-api-session-controller/client'
import { collapseSettledSteps as fold } from '../src/client/chat/step-collapse.ts'
import { timelineOf } from './step-collapse-fixtures.client.ts'

const EMPTY: ReadonlySet<string> = new Set()

/** The fold over a store whose timeline publishes each assistant node's data. */
function collapseSettledSteps(
  order: readonly string[],
  nodes: ChatNodeStore,
  expanded: ReadonlySet<string>,
  digests?: StepDigestsByTurn,
  accounts?: StepDigestsByTurn,
  timeline: ConversationTimelineSnapshot = timelineOf(nodes.values()),
) {
  return fold(order, nodes, expanded, timeline, digests, accounts)
}

/** A settled assistant step payload, as the Assistant Definition publishes it. */
function settledAssistant(options: { text?: string; usage?: unknown; stepStartTime?: number | null; completedTime?: number } = {}) {
  return {
    status: 'settled',
    blocks: options.text === undefined ? [] : [{ kind: 'text', text: options.text }],
    time: 0,
    ...options.usage === undefined ? {} : { usage: options.usage },
    finalNode: { timing: { stepStartTime: options.stepStartTime ?? null, completedTime: options.completedTime ?? 0 } },
  }
}

const label = (row: ReturnType<typeof collapseSettledSteps>[number]): string =>
  row.kind === 'node' ? row.key : `collapsed:${row.key}`

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
    data: options.data ?? ((options.kind ?? 'assistant-step') === 'assistant-step' ? settledAssistant() : undefined),
  } as unknown as ChatConversationViewNode
}

function store(nodes: readonly ChatConversationViewNode[]): ChatNodeStore {
  const byKey = new Map(nodes.map(entry => [entry.key, entry]))
  return {
    get: key => byKey.get(key),
    values: () => nodes,
    source: () => { throw new Error('unused') },
    processSource: () => { throw new Error('unused') },
  }
}

/** One settled root call as the Chat Tool Definition projects it from raw events. */
function settled(callId: string, options: {
  name?: string
  args?: unknown
  isError?: boolean
  error?: { name: string; code: string }
  meta?: unknown
  subCalls?: readonly ToolCallBlock[]
  parentCallId?: string
} = {}): Extract<ToolCallBlock, { kind: 'tool-result' }> {
  return {
    kind: 'tool-result',
    seq: 0,
    time: 0,
    callId,
    ...options.parentCallId === undefined ? {} : { parentCallId: options.parentCallId },
    call: { name: options.name ?? 'write', argsRaw: JSON.stringify(options.args ?? {}) },
    callTime: null,
    content: [],
    isError: options.isError === true,
    ...options.error === undefined ? {} : { error: options.error },
    ...options.meta === undefined ? {} : { meta: options.meta },
    subCalls: options.subCalls ?? [],
  }
}

/** A Tool row whose root is the given block. */
function toolNode(key: string, turn: number, step: number, root: ToolCallBlock = settled(key)): ChatConversationViewNode {
  return node({ key, kind: 'tool-call', turn, step, data: { root } })
}

/** An edit whose result persisted one applied hunk. */
function edited(callId: string, path: string, oldText: string | null, newText: string): ToolCallBlock {
  return settled(callId, { name: 'edit', args: { file_path: path }, meta: { diffs: [{ path, oldText, newText }] } })
}

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
    expect(rows.map(row => (label(row))))
      .toEqual(['ask', 'collapsed:1:1', 's2', 'tail'])
  })

  it('keeps assistant rows without resolved step coordinates visible', () => {
    const nodes = [node({ key: 'session' }), node({ key: 'turn', turn: 1 })]
    expect(collapseSettledSteps(['session', 'turn'], store(nodes), EMPTY)).toEqual([
      { kind: 'node', key: 'session' }, { kind: 'node', key: 'turn' },
    ])
  })

  it('collapses each turn independently', () => {
    const nodes = [
      node({ key: 'a1', turn: 1, step: 1 }),
      node({ key: 'a2', turn: 1, step: 2 }),
      node({ key: 'b1', turn: 2, step: 1 }),
      node({ key: 'b2', turn: 2, step: 2 }),
    ]
    const rows = collapseSettledSteps(['a1', 'a2', 'b1', 'b2'], store(nodes), EMPTY)
    expect(rows.map(row => (label(row))))
      .toEqual(['collapsed:1:1', 'a2', 'collapsed:2:1', 'b2'])
  })

  it('restores the hidden rows in place when the turn is expanded, keeping the marker', () => {
    const nodes = [
      node({ key: 's1', turn: 1, step: 1 }),
      node({ key: 's2', turn: 1, step: 2 }),
      node({ key: 's3', turn: 1, step: 3 }),
    ]
    const rows = collapseSettledSteps(['s1', 's2', 's3'], store(nodes), new Set(['1:1']))
    expect(rows.map(row => (label(row))))
      .toEqual(['collapsed:1:1', 's1', 's2', 's3'])
  })

  it('expands one turn without disturbing another', () => {
    const nodes = [
      node({ key: 'a1', turn: 1, step: 1 }),
      node({ key: 'a2', turn: 1, step: 2 }),
      node({ key: 'b1', turn: 2, step: 1 }),
      node({ key: 'b2', turn: 2, step: 2 }),
    ]
    const rows = collapseSettledSteps(['a1', 'a2', 'b1', 'b2'], store(nodes), new Set(['2:1']))
    expect(rows.map(row => (label(row))))
      .toEqual(['collapsed:1:1', 'a2', 'collapsed:2:1', 'b1', 'b2'])
  })

  it('folds tool calls, nested subcalls, and diff lines into the marker metrics', () => {
    const nodes = [
      node({ key: 's1', turn: 1, step: 1 }),
      toolNode('t1', 1, 1, settled('t1', {
        name: 'edit',
        meta: { diffs: [{ path: 'a.ts', oldText: 'one\n', newText: 'one\ntwo\n' }] },
        // A nested dispatch settles as a call; it persists no meta, so no lines.
        subCalls: [settled('child', { parentCallId: 't1', name: 'edit', meta: { diffs: [{ path: 'z.ts', oldText: null, newText: 'q\n' }] } })],
      })),
      node({ key: 's2', turn: 1, step: 2 }),
    ]
    const rows = collapseSettledSteps(['s1', 't1', 's2'], store(nodes), EMPTY)
    expect((rows[0] as { metrics: unknown }).metrics)
      .toEqual({ steps: 1, calls: 2, contextInjections: 0, files: 1, added: 1, removed: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0 })
  })

  it('reads a settled mutation exactly as the diff card does', () => {
    const nodes = [
      // A create persists no hunk: the write's own content is what landed.
      toolNode('create', 1, 1, settled('create', { args: { file_path: 'new.ts', content: 'one\ntwo\n' }, meta: { diffs: [] } })),
      // A failed edit applied nothing, whatever its metadata says.
      toolNode('failed', 1, 1, settled('failed', {
        name: 'edit', isError: true, error: { name: 'EditError', code: 'not-found' },
        meta: { diffs: [{ path: 'gone.ts', oldText: 'a\n', newText: 'b\n' }] },
      })),
      // An interrupted call carries only an error identity.
      toolNode('cut', 1, 1, settled('cut', { name: 'write', args: { file_path: 'x.ts', content: 'x' }, error: { name: 'Interrupted', code: 'interrupted' } })),
      // A tool that persists no diff is a call and nothing more.
      toolNode('shell', 1, 1, settled('shell', { name: 'bash', args: { command: 'ls' } })),
      // The same file touched again in the group counts once.
      toolNode('again', 1, 1, edited('again', 'new.ts', 'two\n', 'TWO\n')),
      node({ key: 's2', turn: 1, step: 2 }),
    ]
    const rows = collapseSettledSteps(['create', 'failed', 'cut', 'shell', 'again', 's2'], store(nodes), EMPTY)
    expect((rows[0] as { metrics: unknown }).metrics)
      .toMatchObject({ calls: 5, files: 1, added: 3, removed: 1 })
  })

  it('counts a still-running root as no call, and ignores malformed metadata', () => {
    const running: ToolCallBlock = { callId: 'run', name: 'edit', argsRaw: '{}', turn: 1, step: 1, time: 0, subCalls: [] }
    for (const meta of [undefined, 'nope', { diffs: [null] }, { diffs: [{ path: 1 }] }, { diffs: [{ path: 'a', newText: 2 }] }]) {
      const nodes = [
        toolNode('run', 1, 1, running),
        toolNode('t1', 1, 1, settled('t1', { name: 'edit', meta })),
        node({ key: 's2', turn: 1, step: 2 }),
      ]
      const rows = collapseSettledSteps(['run', 't1', 's2'], store(nodes), EMPTY)
      expect((rows[0] as { metrics: { calls: number; added: number } }).metrics)
        .toMatchObject({ calls: 1, added: 0, removed: 0, files: 0 })
    }
  })

  it('counts a settled result whose call head is outside the loaded window', () => {
    const nodes = [
      toolNode('result', 1, 1, { ...settled('result'), kind: 'tool-result', call: null }),
      node({ key: 'answer', turn: 1, step: 2 }),
    ]
    expect(collapseSettledSteps(['result', 'answer'], store(nodes), EMPTY)[0]).toMatchObject({
      metrics: { calls: 1, files: 0, added: 0, removed: 0 },
    })
  })

  it('counts one file once across repeated edits inside the collapsed group', () => {
    const nodes = [
      toolNode('t1', 1, 1, edited('t1', 'a.ts', 'one\n', 'two\n')),
      toolNode('t2', 1, 1, edited('t2', 'a.ts', 'two\n', 'three\n')),
      node({ key: 's2', turn: 1, step: 2 }),
    ]
    const rows = collapseSettledSteps(['t1', 't2', 's2'], store(nodes), EMPTY)
    expect((rows[0] as { metrics: { files: number; added: number } }).metrics)
      .toMatchObject({ files: 1, added: 2, removed: 2 })
  })

  it('folds each response group\'s context separately, keeping the answer before a steer visible', () => {
    const nodes = [
      node({ key: 'system', kind: 'system-prompt', turn: 1, step: 1 }),
      node({ key: 'ask', kind: 'user', turn: 1, step: 1 }),
      node({ key: 'ctx1', kind: 'context', turn: 1, step: 1 }),
      toolNode('t1', 1, 1),
      node({ key: 'a1', turn: 1, step: 1, data: settledAssistant({ text: 'first answer' }) }),
      node({ key: 'steer', kind: 'steering', turn: 1, step: 2 }),
      node({ key: 'ctx2', kind: 'context', turn: 1, step: 2 }),
      node({ key: 'a2', turn: 1, step: 2 }),
      node({ key: 'tail', kind: 'turn-tail', turn: 1 }),
    ]
    const rows = collapseSettledSteps(nodes.map(entry => entry.key), store(nodes), EMPTY)
    expect(rows.map(row => label(row)))
      .toEqual(['system', 'ask', 'collapsed:1:1', 't1', 'a1', 'steer', 'collapsed:1:2', 'a2', 'tail'])
    expect(rows[2]).toMatchObject({ startStep: 1, keys: ['ctx1'], metrics: { steps: 0, contextInjections: 1 } })
    expect(rows[6]).toMatchObject({ startStep: 2, keys: ['ctx2'], metrics: { steps: 0, contextInjections: 1 } })
  })

  describe('a turn steered after it answered', () => {
    const steered = () => [
      node({ key: 'ask', kind: 'user', turn: 1, step: 1 }),
      toolNode('t1', 1, 1),
      node({ key: 'a2', turn: 1, step: 2, data: settledAssistant({ text: 'first answer', usage: { inputTokens: 20, outputTokens: 2 } }) }),
      node({ key: 'steer', kind: 'steering', turn: 1, step: 3 }),
      toolNode('t3', 1, 3),
      toolNode('t4', 1, 4),
      node({ key: 'a5', turn: 1, step: 5, data: settledAssistant({ text: 'second answer' }) }),
      node({ key: 'tail', kind: 'turn-tail', turn: 1 }),
    ]
    // Steps 1, 3, and 4 called tools without prose, so they render no assistant row.
    const toolOnly = new Map([
      ['1:1', settledAssistant({ usage: { inputTokens: 10, outputTokens: 1 }, stepStartTime: 0, completedTime: 100 })],
      ['1:3', settledAssistant({ usage: { inputTokens: 30, outputTokens: 3 } })],
      ['1:4', settledAssistant({ usage: { inputTokens: 40, outputTokens: 4 } })],
    ])

    it('keeps both answers visible with one disclosure per human input', () => {
      const nodes = steered()
      const rows = collapseSettledSteps(
        nodes.map(entry => entry.key), store(nodes), EMPTY, undefined, undefined, timelineOf(nodes, toolOnly),
      )
      expect(rows.map(label))
        .toEqual(['ask', 'collapsed:1:1', 'a2', 'steer', 'collapsed:1:3', 'a5', 'tail'])
      // Tool-only model calls count although they render no assistant row.
      expect(rows[1]).toMatchObject({
        turn: 1, startStep: 1, keys: ['t1'], metrics: { steps: 1, calls: 1, elapsedMs: 100, inputTokens: 10, outputTokens: 1 },
      })
      expect(rows[4]).toMatchObject({
        turn: 1, startStep: 3, keys: ['t3', 't4'], metrics: { steps: 2, calls: 2, inputTokens: 70, outputTokens: 7 },
      })
    })

    it('opens only the selected group, in place', () => {
      const nodes = steered()
      const order = nodes.map(entry => entry.key)
      const timeline = timelineOf(nodes, toolOnly)
      const closed = collapseSettledSteps(order, store(nodes), EMPTY, undefined, undefined, timeline)
      const second = collapseSettledSteps(order, store(nodes), new Set(['1:3']), undefined, undefined, timeline)
      expect(second.map(label))
        .toEqual(['ask', 'collapsed:1:1', 'a2', 'steer', 'collapsed:1:3', 't3', 't4', 'a5', 'tail'])
      expect(second[4]).toEqual(closed[4])
      const both = collapseSettledSteps(order, store(nodes), new Set(['1:1', '1:3']), undefined, undefined, timeline)
      expect(both.map(label))
        .toEqual(['ask', 'collapsed:1:1', 't1', 'a2', 'steer', 'collapsed:1:3', 't3', 't4', 'a5', 'tail'])
    })

    it('keeps the earlier answer visible when later work is tool-only and still running', () => {
      const nodes = steered().slice(0, 6)
      const rows = collapseSettledSteps(nodes.map(entry => entry.key), store(nodes), EMPTY)
      expect(rows.map(label)).toEqual(['ask', 'collapsed:1:1', 'a2', 'steer', 'collapsed:1:3', 't4'])
    })

    it('keeps the answer and its group\'s last tool step when the answer is not the last step', () => {
      const nodes = [
        node({ key: 'ask', kind: 'user', turn: 1, step: 1 }),
        toolNode('t1', 1, 1),
        node({ key: 'a2', turn: 1, step: 2, data: settledAssistant({ text: 'answer' }) }),
        toolNode('t3', 1, 3),
        node({ key: 'steer', kind: 'steering', turn: 1, step: 4 }),
        node({ key: 'a4', turn: 1, step: 4, data: settledAssistant({ text: 'done' }) }),
      ]
      const rows = collapseSettledSteps(nodes.map(entry => entry.key), store(nodes), EMPTY)
      expect(rows.map(label)).toEqual(['ask', 'collapsed:1:1', 'a2', 't3', 'steer', 'a4'])
    })

    it('places a human input logged before its step started in the next step\'s group', () => {
      const nodes = [
        node({ key: 'ask', kind: 'user', turn: 1, step: 1 }),
        toolNode('t1', 1, 1),
        node({ key: 'a2', turn: 1, step: 2, data: settledAssistant({ text: 'answer' }) }),
        { ...node({ key: 'steer', kind: 'steering', turn: 1 }), anchorSeq: 25 },
        toolNode('t3', 1, 3),
        node({ key: 'a4', turn: 1, step: 4, data: settledAssistant({ text: 'done' }) }),
      ]
      const rows = collapseSettledSteps(nodes.map(entry => entry.key), store(nodes), EMPTY)
      expect(rows.map(label)).toEqual(['ask', 'collapsed:1:1', 'a2', 'steer', 'collapsed:1:3', 'a4'])
    })

    it('starts a new group at a human input after the turn\'s last started step', () => {
      const nodes = [
        node({ key: 'ask', kind: 'user', turn: 1, step: 1 }),
        toolNode('t1', 1, 1),
        node({ key: 'a2', turn: 1, step: 2, data: settledAssistant({ text: 'answer' }) }),
        { ...node({ key: 'steer', kind: 'steering', turn: 1 }), anchorSeq: 99 },
      ]
      const rows = collapseSettledSteps(nodes.map(entry => entry.key), store(nodes), EMPTY)
      expect(rows.map(label)).toEqual(['ask', 'collapsed:1:1', 'a2', 'steer'])
    })

    it('does not split a group at injected context', () => {
      const nodes = [
        node({ key: 'ask', kind: 'user', turn: 1, step: 1 }),
        node({ key: 'a1', turn: 1, step: 1, data: settledAssistant({ text: 'interim' }) }),
        node({ key: 'ctx', kind: 'context', turn: 1, step: 2 }),
        node({ key: 'a2', turn: 1, step: 2, data: settledAssistant({ text: 'done' }) }),
      ]
      const rows = collapseSettledSteps(nodes.map(entry => entry.key), store(nodes), EMPTY)
      expect(rows.map(label)).toEqual(['ask', 'collapsed:1:1', 'a2'])
      expect(rows[1]).toMatchObject({ keys: ['a1', 'ctx'], metrics: { steps: 1, contextInjections: 1 } })
    })

    it('reads withheld steps around a steer from their own group\'s accounts', () => {
      const nodes = [
        node({ key: 'ask', kind: 'user', turn: 1, step: 1 }),
        node({ key: 'a2', turn: 1, step: 2, data: settledAssistant({ text: 'first answer' }) }),
        node({ key: 'steer', kind: 'steering', turn: 1, step: 3 }),
        node({ key: 'a5', turn: 1, step: 5, data: settledAssistant({ text: 'second answer' }) }),
      ]
      const withheld = new Map([[1, [account(1, 1), account(1, 3, { inputTokens: 300 }), account(1, 4, { inputTokens: 400 })]]])
      const order = nodes.map(entry => entry.key)
      const closed = collapseSettledSteps(order, store(nodes), EMPTY, withheld)
      expect(closed.map(label)).toEqual(['ask', 'collapsed:1:1', 'a2', 'steer', 'collapsed:1:3', 'a5'])
      expect(closed[1]).toMatchObject({ keys: [], withheld: true, metrics: { steps: 1, calls: 2, inputTokens: 1000 } })
      expect(closed[4]).toMatchObject({ keys: [], withheld: true, metrics: { steps: 2, calls: 4, inputTokens: 700 } })

      // Expansion loads the whole turn; only the opened group reveals its rows.
      const loaded = [
        nodes[0] as ChatConversationViewNode, toolNode('t1', 1, 1), nodes[1] as ChatConversationViewNode,
        nodes[2] as ChatConversationViewNode, toolNode('t3', 1, 3), toolNode('t4', 1, 4), nodes[3] as ChatConversationViewNode,
      ]
      const opened = collapseSettledSteps(
        loaded.map(entry => entry.key), store(loaded), new Set(['1:3']), new Map(), withheld,
      )
      expect(opened.map(label))
        .toEqual(['ask', 'collapsed:1:1', 'a2', 'steer', 'collapsed:1:3', 't3', 't4', 'a5'])
      expect((opened[1] as { metrics: unknown }).metrics).toEqual((closed[1] as { metrics: unknown }).metrics)
      expect((opened[4] as { metrics: unknown }).metrics).toEqual((closed[4] as { metrics: unknown }).metrics)
    })
  })

  it.each([undefined, 1])('summarizes context without hiding the only assistant step (context step %s)', (step) => {
    const nodes = [
      node({ key: 'ask', kind: 'user', turn: 1 }),
      node({ key: 'ctx', kind: 'context', turn: 1, ...step === undefined ? {} : { step } }),
      node({ key: 'answer', turn: 1, step: 1 }),
    ]
    const order = nodes.map(entry => entry.key)
    const closed = collapseSettledSteps(order, store(nodes), EMPTY)
    expect(closed).toMatchObject([
      { kind: 'node', key: 'ask' },
      { kind: 'collapsed', turn: 1, keys: ['ctx'], metrics: { contextInjections: 1, steps: 0, calls: 0 } },
      { kind: 'node', key: 'answer' },
    ])
    const opened = collapseSettledSteps(order, store(nodes), new Set(['1:1']))
    expect(opened.map(row => label(row)))
      .toEqual(['ask', 'collapsed:1:1', 'ctx', 'answer'])
    expect(opened[1]).toEqual(closed[1])
  })

  it('does not treat a later context injection as a new assistant step', () => {
    const nodes = [
      node({ key: 'answer', turn: 1, step: 1 }),
      node({ key: 'ctx', kind: 'context', turn: 1, step: 2 }),
    ]
    expect(collapseSettledSteps(['answer', 'ctx'], store(nodes), EMPTY)).toMatchObject([
      { kind: 'node', key: 'answer' },
      { kind: 'collapsed', turn: 1, keys: ['ctx'], metrics: { contextInjections: 1, steps: 0 } },
    ])
  })

  it('summarizes turn-owned context before any assistant step exists', () => {
    const nodes = [node({ key: 'ctx', kind: 'context', turn: 1 })]
    expect(collapseSettledSteps(['ctx'], store(nodes), EMPTY)).toMatchObject([
      { kind: 'collapsed', turn: 1, keys: ['ctx'], metrics: { contextInjections: 1, steps: 0 } },
    ])
  })

  it('keeps session-owned context outside turn summaries', () => {
    const nodes = [
      node({ key: 'ctx', kind: 'context' }),
      node({ key: 'a1', turn: 1, step: 1 }),
      node({ key: 'a2', turn: 1, step: 2 }),
    ]
    expect(collapseSettledSteps(['ctx', 'a1', 'a2'], store(nodes), EMPTY)).toMatchObject([
      { kind: 'node', key: 'ctx' },
      { kind: 'collapsed', turn: 1, keys: ['a1'], metrics: { contextInjections: 0 } },
      { kind: 'node', key: 'a2' },
    ])
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
      step('a1', 1, settledAssistant({
        usage: { inputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 5, outputTokens: 7 },
        stepStartTime: 1_000, completedTime: 3_000,
      })),
      step('a2', 2, settledAssistant({ usage: { inputTokens: 20, outputTokens: 3 }, stepStartTime: 3_000, completedTime: 4_500 })),
      step('a3', 3, settledAssistant()),
    ]
    const rows = collapseSettledSteps(['a1', 'a2', 'a3'], store(nodes), EMPTY)
    expect((rows[0] as { metrics: unknown }).metrics).toMatchObject({
      steps: 2, elapsedMs: 3_500, inputTokens: 125, outputTokens: 10,
    })
  })

  it('leaves time and tokens at zero when the provider reported neither', () => {
    const nodes = [
      node({ key: 'a1', kind: 'assistant-step', turn: 1, step: 1, data: { ...settledAssistant(), usage: 'nope' } }),
      // A step whose start left the loaded window contributes no wall time.
      node({ key: 'a2', kind: 'assistant-step', turn: 1, step: 2, data: settledAssistant({ completedTime: 9_000 }) }),
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

/** One host step account, as a collapsed page reports it. */
function account(turn: number, step: number, over: Partial<{
  steps: number
  calls: number
  inputTokens: number
  outputTokens: number
  filePaths: readonly string[]
}> = {}) {
  return {
    turn,
    step,
    startSeq: step,
    elided: 1,
    steps: over.steps ?? 1,
    calls: over.calls ?? 2,
    filePaths: over.filePaths ?? [],
    added: 0,
    removed: 0,
    elapsedMs: 100,
    inputTokens: over.inputTokens ?? 1000,
    outputTokens: over.outputTokens ?? 50,
  }
}

describe('collapseSettledSteps with withheld steps', () => {
  it('places the marker below the prompting message, not above it', () => {
    // The engine assigns a step Location by log position, so the user message
    // that opened the turn carries one too. The marker must still follow it.
    const nodes = [
      node({ key: 'ask', kind: 'user', turn: 1, step: 1 }),
      node({ key: 'a1', turn: 1, step: 1 }),
      node({ key: 'a2', turn: 1, step: 2 }),
    ]
    const digests = new Map([[1, [account(1, 1)]]])
    const rows = collapseSettledSteps(['ask', 'a1', 'a2'], store(nodes), EMPTY, digests)

    expect(rows.map(row => (label(row))))
      .toEqual(['ask', 'collapsed:1:1', 'a2'])
  })

  it('keeps the marker in place when the reader opens it', () => {
    const nodes = [
      node({ key: 'ask', kind: 'user', turn: 1, step: 1 }),
      node({ key: 'a1', turn: 1, step: 1 }),
      node({ key: 'a2', turn: 1, step: 2 }),
    ]
    const withheld = new Map([[1, [account(1, 1)]]])
    const closed = collapseSettledSteps(['ask', 'a1', 'a2'], store(nodes), EMPTY, withheld)
    // Expansion clears the withheld marker but keeps the account, which is
    // what stops the row from moving to a different anchor.
    const opened = collapseSettledSteps(['ask', 'a1', 'a2'], store(nodes), new Set(['1:1']), new Map(), withheld)

    expect(closed.findIndex(row => row.kind === 'collapsed'))
      .toBe(opened.findIndex(row => row.kind === 'collapsed'))
    expect(opened.map(row => (label(row))))
      .toEqual(['ask', 'collapsed:1:1', 'a1', 'a2'])
  })

  it('reports the same figures before and after expansion', () => {
    const nodes = [
      node({ key: 'a1', turn: 1, step: 1, data: settledAssistant({ usage: { inputTokens: 1000, outputTokens: 50 } }) }),
      node({ key: 'a2', turn: 1, step: 2 }),
    ]
    const withheld = new Map([[1, [account(1, 1)]]])
    const closed = collapseSettledSteps(['a1', 'a2'], store(nodes), EMPTY, withheld)
    const opened = collapseSettledSteps(['a1', 'a2'], store(nodes), new Set(['1:1']), new Map(), withheld)

    const metricsOf = (rows: readonly { kind: string }[]) =>
      (rows.find(row => row.kind === 'collapsed') as { metrics: unknown } | undefined)?.metrics
    // A step's cost does not change because its events were loaded, so the
    // row must not shrink to whatever the window happens to hold.
    expect(metricsOf(opened)).toEqual(metricsOf(closed))
    expect(metricsOf(closed)).toMatchObject({ steps: 1, calls: 2, inputTokens: 1000, outputTokens: 50 })
  })

  it('counts retained context independently of step accounts before and after expansion', () => {
    const ask = node({ key: 'ask', kind: 'user', turn: 1, step: 1 })
    const ctx1 = node({ key: 'ctx1', kind: 'context', turn: 1, step: 1 })
    const ctx2 = node({ key: 'ctx2', kind: 'context', turn: 1, step: 2 })
    const answer = node({ key: 'a2', turn: 1, step: 2 })
    const withheld = new Map([[1, [account(1, 1)]]])
    const coldNodes = [ask, ctx1, ctx2, answer]
    const cold = collapseSettledSteps(coldNodes.map(entry => entry.key), store(coldNodes), EMPTY, withheld)
    const loadedNodes = [ask, ctx1, node({ key: 'a1', turn: 1, step: 1 }), ctx2, answer]
    const opened = collapseSettledSteps(
      loadedNodes.map(entry => entry.key), store(loadedNodes), new Set(['1:1']), new Map(), withheld,
    )
    expect(cold[1]).toMatchObject({
      kind: 'collapsed', keys: ['ctx1', 'ctx2'], metrics: { contextInjections: 2, steps: 1, calls: 2 },
    })
    expect(opened[1]).toMatchObject({
      kind: 'collapsed', keys: ['ctx1', 'a1', 'ctx2'], metrics: { contextInjections: 2, steps: 1, calls: 2 },
    })
    expect(opened.map(row => label(row)))
      .toEqual(['ask', 'collapsed:1:1', 'ctx1', 'a1', 'ctx2', 'a2'])
  })

  it('counts an accounted step once even when its nodes are loaded', () => {
    // Both the account and the materialized node describe step 1; folding
    // both would double the turn's reported cost.
    const nodes = [
      node({ key: 'a1', turn: 1, step: 1, data: settledAssistant({ usage: { inputTokens: 1000, outputTokens: 50 } }) }),
      node({ key: 'a2', turn: 1, step: 2 }),
    ]
    const accounts = new Map([[1, [account(1, 1)]]])
    const rows = collapseSettledSteps(['a1', 'a2'], store(nodes), new Set(['1:1']), new Map(), accounts)
    const marker = rows.find(row => row.kind === 'collapsed') as { metrics: { steps: number; inputTokens: number } }

    expect(marker.metrics.steps).toBe(1)
    expect(marker.metrics.inputTokens).toBe(1000)
  })

  it('marks a turn as withheld only while its steps are still unloaded', () => {
    const nodes = [node({ key: 'a1', turn: 1, step: 1 }), node({ key: 'a2', turn: 1, step: 2 })]
    const withheld = new Map([[1, [account(1, 1)]]])
    const closed = collapseSettledSteps(['a1', 'a2'], store(nodes), EMPTY, withheld)
    const opened = collapseSettledSteps(['a1', 'a2'], store(nodes), new Set(['1:1']), new Map(), withheld)

    expect((closed.find(row => row.kind === 'collapsed') as { withheld: boolean }).withheld).toBe(true)
    expect((opened.find(row => row.kind === 'collapsed') as { withheld: boolean }).withheld).toBe(false)
  })

  it('counts a file once across a withheld step and a loaded one', () => {
    const nodes = [
      toolNode('t2', 1, 2, edited('t2', 'a.ts', 'two\n', 'three\n')),
      toolNode('t3', 1, 2, edited('t3', 'b.ts', null, 'new\n')),
      node({ key: 'a3', turn: 1, step: 3 }),
    ]
    // Step 1 was withheld and touched a.ts; step 2 is loaded and touches it again.
    const accounts = new Map([[1, [account(1, 1, { filePaths: ['a.ts'] })]]])
    const rows = collapseSettledSteps(['t2', 't3', 'a3'], store(nodes), EMPTY, accounts)
    expect((rows[0] as { metrics: { files: number } }).metrics.files).toBe(2)
  })
})

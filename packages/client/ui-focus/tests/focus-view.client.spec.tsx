// @vitest-environment jsdom
/**
 * The focus view's user-visible behavior: earlier turns collapse to one metric
 * line each, the latest turn renders in full including while it is still a
 * running tool call, and paging chrome appears only with unloaded history.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type {
  ConversationNode, ConversationSnapshot, ConversationTimelineSnapshot, TurnLocation,
} from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { FocusView, foldTotals, latestTurnNodes, type FocusViewProps } from '../src/client/FocusView.tsx'
import { TurnSummaryRow } from '../src/client/TurnSummaryRow.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh) as FocusViewProps['t']

function assistant(seq: number, turn: number, text: string, usage?: unknown): ConversationNode {
  return {
    kind: 'assistant',
    seq,
    time: seq * 1_000,
    turn,
    step: 1,
    blocks: [{ kind: 'text', text }],
    ...usage === undefined ? {} : { usage },
  }
}

function user(seq: number, text: string): ConversationNode {
  return {
    kind: 'user',
    seq,
    time: seq * 1_000,
    content: [{ type: 'text', text }],
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

/** Render the view over a fake session snapshot selector. */
function mount(snapshot: {
  nodes?: readonly ConversationNode[]
  timeline?: ConversationTimelineSnapshot
  partial?: ConversationSnapshot['partial']
  runningCalls?: ConversationSnapshot['runningCalls']
  running?: boolean
  hasMore?: boolean
  loadingOlder?: boolean
}, loadOlder = vi.fn()) {
  const state = {
    chat: {
      legacy: {
        nodes: snapshot.nodes ?? [],
        partial: snapshot.partial ?? null,
        runningCalls: snapshot.runningCalls ?? [],
      },
      timeline: snapshot.timeline ?? timeline([]),
    },
    hasMore: snapshot.hasMore ?? false,
    loadingOlder: snapshot.loadingOlder ?? false,
    running: snapshot.running ?? false,
  }
  const useSession = ((selector: (value: typeof state) => unknown) => selector(state)) as FocusViewProps['useSession']
  const view = render(<FocusView {...({ useSession, loadOlder, t } as unknown as FocusViewProps)} />)
  return { view, loadOlder }
}

describe('FocusView', () => {
  it('collapses earlier turns to one metric row each and renders the latest turn in full', () => {
    const { view } = mount({
      nodes: [
        user(1, 'first ask'),
        assistant(3, 1, 'earlier answer', { inputTokens: 100, outputTokens: 20 }),
        user(5, 'second ask'),
        assistant(7, 2, 'current answer'),
      ],
      timeline: timeline([{ turn: 1, start: 2, end: 4 }, { turn: 2, start: 6 }]),
    })
    // The earlier turn is a summary line, not its prose.
    expect(view.queryByText('earlier answer')).toBeNull()
    expect(view.container.querySelector('[data-focus-turn="1"]')).not.toBeNull()
    expect(view.getByText(/已折叠 1 轮/)).toBeTruthy()
    // The latest turn keeps its full content, prompting message included.
    expect(view.getByText('current answer')).toBeTruthy()
    expect(view.getByText('second ask')).toBeTruthy()
    expect(view.queryByText('first ask')).toBeNull()
  })

  it('renders a tool-call-only latest turn live, before any assistant prose settles', () => {
    const { view } = mount({
      nodes: [assistant(3, 1, 'earlier answer')],
      timeline: timeline([{ turn: 1, start: 2, end: 4 }, { turn: 2, start: 5 }]),
      running: true,
      runningCalls: [{
        callId: 'c1',
        name: 'bash',
        argsRaw: '{"command":"ls"}',
        turn: 2,
        step: 1,
        time: 6_000,
        callView: { card: 'terminal', title: 'ls -la' },
        subCalls: [],
      }] as unknown as ConversationSnapshot['runningCalls'],
    })
    expect(view.container.querySelector('[data-focus-call="c1"]')).not.toBeNull()
    // The command reaches both the card head and the terminal prompt line.
    expect(view.getAllByText('ls -la').length).toBeGreaterThan(0)
    expect(view.getAllByText('进行中').length).toBeGreaterThan(0)
  })

  it('renders the streaming partial of the latest turn', () => {
    const { view } = mount({
      timeline: timeline([{ turn: 1, start: 1 }]),
      running: true,
      partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: 'thinking out loud' }] },
    })
    expect(view.getByText('thinking out loud')).toBeTruthy()
  })

  it('shows the empty notice when no earlier turn exists', () => {
    const { view } = mount({
      nodes: [assistant(2, 1, 'only answer')],
      timeline: timeline([{ turn: 1, start: 1 }]),
    })
    expect(view.getByText('暂无更早的轮次。')).toBeTruthy()
    expect(view.getByText('only answer')).toBeTruthy()
  })

  it('offers paging and warns that the figures are partial while history is unloaded', () => {
    const { view, loadOlder } = mount({
      nodes: [assistant(2, 1, 'a'), assistant(4, 2, 'b')],
      timeline: timeline([{ turn: 1, start: 1, end: 3 }, { turn: 2, start: 4 }]),
      hasMore: true,
    })
    expect(view.getByText(/仅覆盖已加载部分/)).toBeTruthy()
    view.getByRole('button', { name: '加载更早的历史' }).click()
    expect(loadOlder).toHaveBeenCalledTimes(1)
  })

  it('disables the paging button while an older page is in flight', () => {
    const { view } = mount({ hasMore: true, loadingOlder: true })
    expect(view.getByRole('button', { name: '加载中…' }).hasAttribute('disabled')).toBe(true)
  })

  it('totals the collapsed turns into one trailing line', () => {
    const { view } = mount({
      nodes: [
        assistant(2, 1, 'a', { inputTokens: 100, outputTokens: 20 }),
        assistant(4, 2, 'b', { inputTokens: 300, outputTokens: 40 }),
        assistant(6, 3, 'current'),
      ],
      timeline: timeline([
        { turn: 1, start: 1, end: 3 }, { turn: 2, start: 3, end: 5 }, { turn: 3, start: 6 },
      ]),
    })
    expect(view.getByText('合计')).toBeTruthy()
    // 120 + 340 tokens over the two collapsed turns.
    expect(view.getByText(/460 tokens/)).toBeTruthy()
  })

  it('carries call counts, edit volume, and wall time into the total line', () => {
    const edit = {
      kind: 'tool-result',
      seq: 3,
      time: 3_000,
      callId: 'e1',
      call: { name: 'edit', argsRaw: '{}' },
      callTime: 2_800,
      content: [],
      isError: false,
      callView: null,
      resultView: { card: 'diff', diffs: [{ path: 'a.ts', oldText: 'one\n', newText: 'one\ntwo\n' }] },
      subCalls: [],
    } as unknown as ConversationNode
    const { view } = mount({
      nodes: [assistant(2, 1, 'a'), edit, assistant(6, 2, 'current')],
      timeline: timeline([{ turn: 1, start: 1, end: 5 }, { turn: 2, start: 6 }]),
    })
    const total = view.container.querySelector('[class*="total"]')?.textContent ?? ''
    expect(total).toContain('1 次调用')
    expect(total).toContain('+1')
    expect(total).toContain('-0 行')
    expect(total).toContain('耗时 4s')
  })

  it('omits elapsed time from the total when the collapsed turn boundaries were paged out', () => {
    const { view } = mount({
      // Turn 1 has no in-window turn/start, so it contributes no wall time.
      nodes: [assistant(2, 1, 'a', { inputTokens: 10, outputTokens: 2 }), assistant(4, 2, 'current')],
      timeline: timeline([{ turn: 1, end: 3 }, { turn: 2, start: 4 }]),
      hasMore: true,
    })
    const total = view.container.querySelector('[class*="total"]')?.textContent ?? ''
    expect(total).toContain('1 步')
    expect(total).not.toContain('耗时')
  })

  it('renders no collapsed band when only unattributable nodes precede the latest turn', () => {
    // A tool result with no in-window step of its own belongs to no summary, so
    // the band and its total line stay absent.
    const orphan = {
      kind: 'tool-result',
      seq: 2,
      time: 2_000,
      callId: 'x',
      call: null,
      callTime: null,
      content: [],
      isError: false,
      callView: null,
      resultView: null,
      subCalls: [],
    } as unknown as ConversationNode
    const { view } = mount({
      nodes: [orphan, assistant(4, 2, 'current')],
      timeline: timeline([{ turn: 1, start: 1, end: 3 }, { turn: 2, start: 3 }]),
    })
    expect(view.queryByText('合计')).toBeNull()
  })
})

describe('latestTurnNodes', () => {
  const nodes = [user(1, 'ask'), assistant(3, 1, 'a'), user(5, 'again'), assistant(7, 2, 'b')]

  it('opens the slice at the prompting user message preceding turn/start', () => {
    expect(latestTurnNodes(nodes, timeline([{ turn: 2, start: 6 }]), 2).map(node => node.seq))
      .toEqual([5, 7])
  })

  it('opens at turn/start when the preceding node is not a human opener', () => {
    const withoutOpener = [assistant(3, 1, 'a'), assistant(7, 2, 'b')]
    expect(latestTurnNodes(withoutOpener, timeline([{ turn: 2, start: 6 }]), 2).map(node => node.seq))
      .toEqual([7])
  })

  it('falls back to the turn\'s own steps when its start was paged out', () => {
    expect(latestTurnNodes(nodes, timeline([{ turn: 2 }]), 2).map(node => node.seq)).toEqual([7])
  })

  it('renders nothing when the window holds no node of the latest turn', () => {
    expect(latestTurnNodes(nodes, timeline([{ turn: 9 }]), 9)).toEqual([])
    expect(latestTurnNodes(nodes, timeline([]), undefined)).toEqual([])
  })
})

describe('foldTotals', () => {
  it('leaves elapsed time absent when no collapsed turn recorded a boundary', () => {
    const totals = foldTotals([{
      turn: 1,
      steps: 1,
      calls: 0,
      filesTouched: 0,
      lines: { added: 0, removed: 0 },
      tokens: { input: 3, output: 1 },
      boundaryKnown: false,
    }])
    expect(totals.elapsedMs).toBeUndefined()
    expect(totals.tokens).toEqual({ input: 3, output: 1 })
  })

  it('sums lines, calls, and files across the collapsed turns', () => {
    const totals = foldTotals([
      {
        turn: 1,
        steps: 1,
        calls: 2,
        filesTouched: 1,
        lines: { added: 3, removed: 1 },
        tokens: { input: 5, output: 2 },
        elapsedMs: 1_000,
        boundaryKnown: true,
      },
      {
        turn: 2,
        steps: 2,
        calls: 1,
        filesTouched: 2,
        lines: { added: 4, removed: 2 },
        tokens: { input: 6, output: 3 },
        elapsedMs: 2_000,
        boundaryKnown: true,
      },
    ])
    expect(totals).toEqual({
      steps: 3,
      calls: 3,
      filesTouched: 3,
      lines: { added: 7, removed: 3 },
      tokens: { input: 11, output: 5 },
      elapsedMs: 3_000,
    })
  })

  it('sums an empty list to zeros', () => {
    expect(foldTotals([])).toEqual({
      steps: 0,
      calls: 0,
      filesTouched: 0,
      lines: { added: 0, removed: 0 },
      tokens: { input: 0, output: 0 },
    })
  })
})

describe('LatestTurn rows', () => {
  it('renders a settled failed call with its error marker and raw arguments', () => {
    const failed = {
      kind: 'tool-result',
      seq: 4,
      time: 4_000,
      callId: 'bad',
      call: { name: 'edit', argsRaw: '{"path":"a.ts"}' },
      callTime: 3_500,
      content: [],
      isError: true,
      callView: null,
      resultView: null,
      subCalls: [],
    } as unknown as ConversationNode
    const { view } = mount({
      nodes: [failed],
      timeline: timeline([{ turn: 1, start: 3 }]),
    })
    expect(view.getByText('edit')).toBeTruthy()
    expect(view.getByText('加载失败')).toBeTruthy()
    expect(view.getByText('{"path":"a.ts"}')).toBeTruthy()
  })

  it('titles a settled call from its result view and keeps its reasoning aside', () => {
    const settled = {
      kind: 'tool-result',
      seq: 4,
      time: 4_000,
      callId: 'ok',
      call: { name: 'read', argsRaw: '' },
      callTime: 3_500,
      content: [],
      isError: false,
      callView: { card: 'generic', title: 'Read a.ts' },
      resultView: { card: 'generic', title: 'Read 12 lines' },
      subCalls: [],
    } as unknown as ConversationNode
    const reasoning = {
      kind: 'assistant',
      seq: 5,
      time: 5_000,
      turn: 1,
      step: 1,
      blocks: [
        { kind: 'reasoning', text: 'weighing options' },
        { kind: 'tool-call', callId: 'ok', name: 'read', argsRaw: '' },
      ],
    } as unknown as ConversationNode
    const { view } = mount({ nodes: [settled, reasoning], timeline: timeline([{ turn: 1, start: 3 }]) })
    expect(view.getByText('Read 12 lines')).toBeTruthy()
    expect(view.getByText('weighing options')).toBeTruthy()
  })

  it('falls back to the callId when window truncation dropped the call head', () => {
    const headless = {
      kind: 'tool-result',
      seq: 4,
      time: 4_000,
      callId: 'orphan-call',
      call: null,
      callTime: null,
      content: [],
      isError: false,
      callView: null,
      resultView: null,
      subCalls: [],
    } as unknown as ConversationNode
    const { view } = mount({ nodes: [headless], timeline: timeline([{ turn: 1, start: 3 }]) })
    expect(view.getByText('orphan-call')).toBeTruthy()
  })

  it('renders a settled terminal call with its cwd, output, exit status, and nested subcall', () => {
    const child = {
      kind: 'tool-result',
      seq: 5,
      time: 5_000,
      callId: 'child',
      call: { name: 'read', argsRaw: '{"p":1}' },
      callTime: 4_800,
      content: [],
      isError: false,
      callView: null,
      resultView: null,
      subCalls: [],
    } as unknown as ConversationNode
    const settled = {
      kind: 'tool-result',
      seq: 4,
      time: 4_000,
      callId: 'sh',
      call: { name: 'bash', argsRaw: '{}' },
      callTime: 3_500,
      content: [],
      isError: false,
      callView: { card: 'terminal', title: 'pnpm test', cwd: '/repo' },
      resultView: { card: 'terminal', output: 'ok\n', exitCode: 1 },
      subCalls: [child],
    } as unknown as ConversationNode
    const { view } = mount({ nodes: [settled], timeline: timeline([{ turn: 1, start: 3 }]) })
    // The terminal prompt shortens an absolute cwd to its last segment.
    expect(view.getByText('repo')).toBeTruthy()
    expect(view.getByText(/ok/)).toBeTruthy()
    // The nested call renders its own row inside the parent.
    expect(view.container.querySelector('[data-focus-call="child"]')).not.toBeNull()
    expect(view.getByText('{"p":1}')).toBeTruthy()
  })

  it('renders a signal-terminated terminal call', () => {
    const killed = {
      kind: 'tool-result',
      seq: 4,
      time: 4_000,
      callId: 'sh',
      call: { name: 'bash', argsRaw: '{}' },
      callTime: 3_500,
      content: [],
      isError: false,
      callView: { card: 'terminal', title: 'sleep 100' },
      resultView: { card: 'terminal', signal: 'SIGTERM' },
      subCalls: [],
    } as unknown as ConversationNode
    const { view } = mount({ nodes: [killed], timeline: timeline([{ turn: 1, start: 3 }]) })
    expect(view.getAllByText('sleep 100').length).toBeGreaterThan(0)
  })

  it('reads name and arguments off a running call, which carries no result head', () => {
    const { view } = mount({
      timeline: timeline([{ turn: 1, start: 1 }]),
      running: true,
      runningCalls: [{
        callId: 'live',
        name: 'grep',
        argsRaw: '{"pattern":"todo"}',
        turn: 1,
        step: 1,
        time: 2_000,
        callView: null,
        subCalls: [],
      }],
    })
    expect(view.getByText('grep')).toBeTruthy()
    expect(view.getByText('{"pattern":"todo"}')).toBeTruthy()
  })

  it('renders a steering message admitted into the latest turn', () => {
    const steering = {
      kind: 'steering',
      seq: 4,
      time: 4_000,
      messageId: 'm1',
      content: [{ type: 'text', text: 'also check the tests' }],
      source: null,
    } as unknown as ConversationNode
    const { view } = mount({ nodes: [steering], timeline: timeline([{ turn: 1, start: 3 }]) })
    expect(view.getByText('also check the tests')).toBeTruthy()
  })

  it('skips a node kind the latest turn does not render inline', () => {
    const compaction = { kind: 'compaction', seq: 4, time: 4_000 } as unknown as ConversationNode
    const { view } = mount({ nodes: [compaction], timeline: timeline([{ turn: 1, start: 3 }]) })
    expect(view.getByText('无')).toBeTruthy()
  })

  it('reports an empty latest turn rather than a blank pane', () => {
    const { view } = mount({ timeline: timeline([{ turn: 1, start: 1 }]) })
    expect(view.getByText('无')).toBeTruthy()
  })
})

describe('TurnSummaryRow', () => {
  it('renders added and removed lines in their own signed spans', () => {
    const view = render(
      <TurnSummaryRow
        t={t}
        summary={{
          turn: 4,
          steps: 2,
          calls: 3,
          filesTouched: 2,
          lines: { added: 12, removed: 5 },
          tokens: { input: 1_500, output: 200 },
          elapsedMs: 65_000,
          boundaryKnown: true,
        }}
      />,
    )
    expect(view.getByText('第 4 轮')).toBeTruthy()
    expect(view.getByText('+12')).toBeTruthy()
    expect(view.getByText('-5 行')).toBeTruthy()
    expect(view.getByText('2 个文件')).toBeTruthy()
    expect(view.getByText('耗时 1m05s')).toBeTruthy()
    expect(view.getByText(/1.7K tokens/)).toBeTruthy()
  })

  it('omits every metric group the turn has no data for', () => {
    const view = render(
      <TurnSummaryRow
        t={t}
        summary={{
          turn: 9,
          steps: 0,
          calls: 0,
          filesTouched: 0,
          lines: { added: 0, removed: 0 },
          tokens: { input: 0, output: 0 },
          boundaryKnown: false,
        }}
      />,
    )
    expect(view.getByText('第 9 轮')).toBeTruthy()
    expect(view.container.textContent).toBe('第 9 轮')
  })
})

// @vitest-environment jsdom
/**
 * ChatFlow's step-collapse behavior: the Collapsed steps presentation gates it
 * entirely, each response group's settled steps fold behind one row, and each
 * disclosure restores its rows through the same node seat as every other row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type {
  ChatConversationViewNode, ChatFlowSlotProps, ChatSnapshot, CollapsedMetricOwnerProps, TranscriptViewMode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionSnapshot, StepDigestsByTurn } from '@deepseek-ai/dsh-api-session-controller/client'
import type { StepDigest } from '@deepseek-ai/dsh-api-remotes/client'
import {
  EMPTY_CONVERSATION_SNAPSHOT, type ConversationGroupedView, type ConversationSnapshot, type ConversationViewSnapshotStore,
  type GroupKey, type GroupSnapshot, type NodeKey, type RenderEntry,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { bindSnapshotSelector, makeTranslate, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ChatFlow } from '../src/client/chat/ChatFlow.tsx'
import type { ProcessGroupData } from '../src/client/contract/process-groups.ts'
import { CHAT_FLOW_INJECT } from '../src/client/apply.ts'
import type { FlowMotionRows } from '../src/client/chat/flow-motion.ts'
import { derivePresentationPolicy, type CollapseTiming } from '../src/client/presentation-policy.ts'
import { createChatStore } from '../src/client/stores.ts'
import { zh } from '../src/client/locale.ts'
import {
  bindKeyedSnapshotSelector, chatNode, chatNodeStore, settledAssistant, timelineOf,
} from './step-collapse-fixtures.client.ts'

afterEach(cleanup)

const SID = SessionId('s1')
const EMPTY_KEYS: readonly string[] = []
const ABSENT = { getSnapshot: () => undefined, subscribe: () => () => {} }
const MOTION: FlowMotionRows = { collapse: (_element, done) => { done() }, reveal: () => {}, cancelMotion: () => {} }

/** One settled assistant step node placed at an exact turn/step coordinate. */
function stepNode(key: string, turn: number, step: number, text?: string): ChatConversationViewNode {
  return chatNode({ key, turn, step, data: settledAssistant(text === undefined ? { turn, step } : { turn, step, text }) })
}

function snapshot(nodes: readonly ChatConversationViewNode[]): ChatSnapshot {
  return {
    order: nodes.map(node => node.key),
    nodes: chatNodeStore(nodes),
    locations: { getTurn: () => EMPTY_KEYS, getStep: () => EMPTY_KEYS },
    navigation: { items: () => [] },
    timeline: timelineOf(nodes),
    legacy: { nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [] },
  }
}

interface MountOptions {
  /** Receives every collapsed-metric owner the flow renders. */
  readonly observeMetric?: (owner: CollapsedMetricOwnerProps) => void
  /** Session snapshot fields layered over the quiescent default. */
  readonly session?: Partial<SessionSnapshot>
  /** The expansion request the flow hands to the sessions domain. */
  readonly expandTurn?: (turn: number) => Promise<void>
  /** Root references; defaults to one flat reference per node. */
  readonly entries?: readonly RenderEntry[]
  /** Process groups the root references name. */
  readonly groups?: readonly GroupSnapshot<ProcessGroupData>[]
}

/**
 * Mount ChatFlow over a fixed snapshot, dispatching node rows to a probe.
 * @param nodes - the snapshot's nodes, in render order.
 * @param mode - the work-details preference under test.
 * @param options - metric probe, session overrides, and the expansion stub.
 * @returns the rendered flow.
 */
function mount(nodes: readonly ChatConversationViewNode[], mode: TranscriptViewMode, options: MountOptions = {}) {
  const session = createSnapshotStore<SessionSnapshot>({ ...sessionSnapshot(SID), ...options.session })
  const chat = createSnapshotStore(snapshot(nodes))
  const store = createChatStore().create()
  const groups = new Map((options.groups ?? []).map(group => [group.key, group]))
  const grouped: ConversationGroupedView<ProcessGroupData> = {
    entries: options.entries ?? [],
    groupSource: key => ({ getSnapshot: () => groups.get(key), subscribe: () => () => {} }),
  }
  const conversation = createSnapshotStore<ConversationSnapshot>({
    ...EMPTY_CONVERSATION_SNAPSHOT,
    views: {
      ...EMPTY_CONVERSATION_SNAPSHOT.views,
      grouped: (() => grouped) as ConversationViewSnapshotStore['grouped'],
    },
  })
  const presentation = derivePresentationPolicy(
    createSnapshotStore<TranscriptViewMode>(mode), createSnapshotStore<CollapseTiming>('completion'),
  )
  const renderSlot = ((key: string, owner: object) => {
    if (key === 'conversation.chat.node' && 'node' in owner) {
      const node = owner.node as ChatConversationViewNode
      return <div data-node-key={node.key}>{node.key}</div>
    }
    if (key === 'conversation.chat.collapsedMetric') options.observeMetric?.(owner as CollapsedMetricOwnerProps)
    return null
  }) as ChatFlowSlotProps['renderSlot']
  const hookStandard = {} as Parameters<typeof CHAT_FLOW_INJECT.hooks.groupAction>[0]
  const props = {
    entries: options.entries ?? nodes.map(node => ({ kind: 'node' as const, key: node.key as NodeKey })),
    pendingInputs: [],
    lastInputTurn: undefined,
    deferCollapse: false,
    cwd: undefined,
    openFile: vi.fn(),
    inspectCall: vi.fn(),
    forkAt: vi.fn(),
    loadImage: Object.assign(vi.fn(), { peek: () => undefined }),
    fileMentions: () => undefined,
    sessionId: SID,
    useSession: bindSnapshotSelector(session),
    useConversation: bindSnapshotSelector(conversation),
    useChat: bindSnapshotSelector(chat),
    useChatNode: bindKeyedSnapshotSelector(key => ({ getSnapshot: () => chat.getSnapshot().nodes.get(key), subscribe: () => () => {} })),
    useChatNodeBottom: bindKeyedSnapshotSelector(() => ({ getSnapshot: () => false, subscribe: () => () => {} })),
    useChatNodeProcess: bindKeyedSnapshotSelector(() => ABSENT),
    useChatGroup: bindKeyedSnapshotSelector(key => ({ getSnapshot: () => groups.get(key as GroupKey), subscribe: () => () => {} })),
    usePresentation: bindSnapshotSelector(presentation),
    useGroupAction: CHAT_FLOW_INJECT.hooks.groupAction(hookStandard, { motion: MOTION }),
    useGroupHeaderAction: CHAT_FLOW_INJECT.hooks.groupHeaderAction(hookStandard, { motion: MOTION }),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    expandTurn: options.expandTurn ?? vi.fn<(turn: number) => Promise<void>>().mockResolvedValue(undefined),
    renderSlot,
    renderFactorySlot: () => null,
    t: makeTranslate(zh, commonZh),
  } as ChatFlowSlotProps
  return render(<ChatFlow {...props} />)
}

/** Rendered flow identity: node keys in order, with collapse markers named by group. */
function flow(view: ReturnType<typeof render>): string[] {
  return [...view.container.querySelectorAll('[data-node-key],[data-collapsed-group]')]
    .map(el => el.getAttribute('data-node-key') ?? `collapsed:${String(el.getAttribute('data-collapsed-group'))}`)
}

const THREE_STEPS = [stepNode('s1', 1, 1), stepNode('s2', 1, 2), stepNode('s3', 1, 3)]

function digests(...entries: StepDigest[]): StepDigestsByTurn {
  return new Map([[1, entries]])
}

describe('ChatFlow step collapse', () => {
  it.each(['compact', 'standard', 'detailed', 'verbose'] as const)('renders every step in %s mode', (mode) => {
    const view = mount(THREE_STEPS, mode)
    expect(flow(view)).toEqual(['s1', 's2', 's3'])
    expect(view.container.querySelector('[data-collapsed-turn]')).toBeNull()
  })

  it('keeps only the last step visible in the collapsed mode, as an anchored flow row', () => {
    const view = mount(THREE_STEPS, 'collapsed')
    expect(flow(view)).toEqual(['collapsed:1:1', 's3'])
    const row = view.container.querySelector('[data-chat-flow-kind="collapsed-steps"]')
    expect(row?.getAttribute('data-chat-anchor-key')).toBe('collapsed:1:1')
    expect(row?.getAttribute('data-chat-turn')).toBe('1')
    expect(row?.querySelector('[data-collapsed-group="1:1"]')).not.toBeNull()
  })

  it('restores the hidden steps in place when the row is opened, and folds them again', () => {
    const view = mount(THREE_STEPS, 'collapsed')
    const toggle = () => { fireEvent.click(view.getByRole('button')) }

    toggle()
    expect(flow(view)).toEqual(['collapsed:1:1', 's1', 's2', 's3'])

    toggle()
    expect(flow(view)).toEqual(['collapsed:1:1', 's3'])
  })

  it('counts and restores context injections without hiding the prompt or live answer', () => {
    const nodes = [
      chatNode({ key: 'ask', kind: 'user', turn: 1, step: 1 }),
      chatNode({ key: 'ctx1', kind: 'context', turn: 1, step: 1 }),
      chatNode({ key: 'ctx2', kind: 'context', turn: 1, step: 1 }),
      stepNode('answer', 1, 1),
    ]
    const expandTurn = vi.fn<(turn: number) => Promise<void>>()
    const view = mount(nodes, 'collapsed', { expandTurn })
    const button = view.getByRole('button', { name: '2 次上下文注入' })
    expect(flow(view)).toEqual(['ask', 'collapsed:1:1', 'answer'])
    expect(button.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(button)
    expect(flow(view)).toEqual(['ask', 'collapsed:1:1', 'ctx1', 'ctx2', 'answer'])
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(expandTurn).not.toHaveBeenCalled()

    fireEvent.click(button)
    expect(flow(view)).toEqual(['ask', 'collapsed:1:1', 'answer'])
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('hands a contributor exactly the keys the row hides', () => {
    const seen: CollapsedMetricOwnerProps[] = []
    mount(THREE_STEPS, 'collapsed', { observeMetric: (owner) => { seen.push(owner) } })
    // s3 is the visible last step and must not appear.
    expect(seen.at(-1)).toEqual({ turn: 1, startStep: 1, keys: ['s1', 's2'], steps: 2, calls: 0 })
  })

  it('leaves a single-step turn untouched', () => {
    const view = mount([stepNode('only', 1, 1)], 'collapsed')
    expect(flow(view)).toEqual(['only'])
    expect(view.container.querySelector('[data-collapsed-turn]')).toBeNull()
  })

  it('folds a turn whose earlier steps the page withheld, and fetches them on opening', () => {
    const withheld = digests({
      turn: 1, step: 1, startSeq: 3, endSeq: 9, elided: 5, steps: 1, calls: 2, filePaths: ['a.ts'],
      added: 4, removed: 1, elapsedMs: 1200, inputTokens: 30, outputTokens: 10,
    })
    const expandTurn = vi.fn<(turn: number) => Promise<void>>().mockResolvedValue(undefined)
    const view = mount([stepNode('s2', 1, 2)], 'collapsed', {
      session: { stepDigests: withheld, stepAccounts: withheld },
      expandTurn,
    })
    expect(flow(view)).toEqual(['collapsed:1:1', 's2'])
    // The row reports the withheld step's own figures, not a fold of loaded nodes.
    expect(view.getByRole('button').textContent).toContain('2 次调用')

    fireEvent.click(view.getByRole('button'))
    expect(expandTurn).toHaveBeenCalledWith(1)
  })

  it('keeps the row after expansion loads the withheld steps into the window', () => {
    const accounts = digests({
      turn: 1, step: 1, startSeq: 3, elided: 5, steps: 1, calls: 1, filePaths: [],
      added: 0, removed: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0,
    })
    // The interior arrived and the withheld marker cleared, but the account remains.
    const view = mount([stepNode('s1', 1, 1), stepNode('s2', 1, 2)], 'collapsed', {
      session: { stepDigests: new Map(), stepAccounts: accounts },
    })
    expect(flow(view)).toEqual(['collapsed:1:1', 's2'])
    fireEvent.click(view.getByRole('button'))
    expect(flow(view)).toEqual(['collapsed:1:1', 's1', 's2'])
  })

  it('announces an in-flight expansion only on the opened row', () => {
    const withheld = digests({
      turn: 1, step: 1, startSeq: 3, elided: 5, steps: 1, calls: 1, filePaths: [],
      added: 0, removed: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0,
    })
    const view = mount([stepNode('s2', 1, 2)], 'collapsed', {
      session: { stepDigests: withheld, stepAccounts: withheld, expandingTurns: new Set([1]) },
    })
    expect(view.queryByRole('status')).toBeNull()
    fireEvent.click(view.getByRole('button'))
    expect(view.getByRole('status').textContent).toBe(commonZh.loading)
  })

  it('folds process-group members as flat rows, keeping both parts of the answer step', () => {
    const nodes = [
      chatNode({ key: 'ask', kind: 'user', turn: 1, step: 1 }),
      stepNode('think1', 1, 1),
      chatNode({ key: 'tool1', kind: 'tool-call', turn: 1, step: 1, data: { root: { callId: 'c1', subCalls: [] } } }),
      stepNode('answer', 1, 2, 'done'),
    ]
    const group = 'process:1' as GroupKey
    const entries: RenderEntry[] = [
      { kind: 'node', key: 'ask' as NodeKey },
      { kind: 'group', key: group },
      { kind: 'node', key: 'answer' as NodeKey, groupPart: 'response' },
    ]
    const groups: GroupSnapshot<ProcessGroupData>[] = [{
      key: group, data: { turn: 1, closed: true, summary: { counts: [], running: undefined, runningDetail: '' } },
      members: [
        { kind: 'node', key: 'think1' as NodeKey, groupPart: 'reasoning' },
        { kind: 'node', key: 'tool1' as NodeKey },
        { kind: 'node', key: 'answer' as NodeKey, groupPart: 'reasoning' },
      ],
    }]
    const collapsed = mount(nodes, 'collapsed', { entries, groups })
    expect(flow(collapsed)).toEqual(['ask', 'collapsed:1:1', 'answer', 'answer'])
    expect(collapsed.container.querySelector('[data-chat-group-key]')).toBeNull()
    fireEvent.click(collapsed.getByRole('button'))
    expect(flow(collapsed)).toEqual(['ask', 'collapsed:1:1', 'think1', 'tool1', 'answer', 'answer'])
    cleanup()

    // Other modes keep the group reference for its own seat.
    const detailed = mount(nodes, 'detailed', { entries, groups })
    expect(detailed.container.querySelector('[data-chat-group-key="process:1"]')).not.toBeNull()
    expect(detailed.container.querySelector('[data-collapsed-group]')).toBeNull()
  })

  it('keeps both answers of a steered turn visible and opens only the selected group', () => {
    const nodes = [
      chatNode({ key: 'ask', kind: 'user', turn: 1, step: 1 }),
      stepNode('work1', 1, 1),
      stepNode('answer1', 1, 2, 'first answer'),
      chatNode({ key: 'follow-up', kind: 'steering', turn: 1, step: 3 }),
      stepNode('work2', 1, 3),
      stepNode('answer2', 1, 4, 'second answer'),
    ]
    const expandTurn = vi.fn<(turn: number) => Promise<void>>()
    const view = mount(nodes, 'collapsed', { expandTurn })
    const first = view.container.querySelector<HTMLButtonElement>('[data-collapsed-group="1:1"] button')!
    const second = view.container.querySelector<HTMLButtonElement>('[data-collapsed-group="1:3"] button')!
    expect(flow(view)).toEqual(['ask', 'collapsed:1:1', 'answer1', 'follow-up', 'collapsed:1:3', 'answer2'])

    fireEvent.click(first)
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(second.getAttribute('aria-expanded')).toBe('false')
    expect(flow(view)).toEqual(['ask', 'collapsed:1:1', 'work1', 'answer1', 'follow-up', 'collapsed:1:3', 'answer2'])

    fireEvent.click(second)
    fireEvent.click(first)
    expect(flow(view)).toEqual(['ask', 'collapsed:1:1', 'answer1', 'follow-up', 'collapsed:1:3', 'work2', 'answer2'])
    // Nothing was withheld, so no group fetched.
    expect(expandTurn).not.toHaveBeenCalled()
  })
})

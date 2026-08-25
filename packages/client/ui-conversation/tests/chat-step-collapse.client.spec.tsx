// @vitest-environment jsdom
/**
 * ChatView's step-collapse behavior: the preference gates it entirely, a
 * turn's settled steps fold behind one row, and the disclosure restores them
 * through the same node seat that renders every other row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type {
  ChatConversationViewNode, ChatSnapshot, ConversationSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ChatView } from '../src/client/chat/ChatView.tsx'
import type { ChatViewSlotProps } from '../src/client/contract/slots.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const EMPTY_KEYS: readonly string[] = []

/** One assistant step node placed at an exact turn/step coordinate. */
function stepNode(key: string, turn: number, step: number): ChatConversationViewNode {
  return {
    key,
    kind: 'assistant-step',
    id: key,
    target: 'chat',
    anchorSeq: 0,
    visibility: 'visible',
    location: { kind: 'step', turn: { turn }, step: { step } },
    data: {},
  } as unknown as ChatConversationViewNode
}

function snapshot(nodes: readonly ChatConversationViewNode[]): ConversationSnapshot {
  const byKey = new Map(nodes.map(node => [node.key, node]))
  const chat: ChatSnapshot = {
    order: nodes.map(node => node.key),
    nodes: { get: key => byKey.get(key), values: () => nodes },
    locations: { getTurn: () => EMPTY_KEYS, getStep: () => EMPTY_KEYS },
    timeline: { turnOrder: [], turns: new Map() },
    legacy: {
      nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [],
    },
  }
  return {
    chat, queue: [], running: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false,
  } as unknown as ConversationSnapshot
}

/** Mount ChatView over a fixed snapshot, dispatching node rows to a probe. */
function mount(nodes: readonly ChatConversationViewNode[], collapse: boolean) {
  const state = snapshot(nodes)
  // Only the node seat renders a probe row; the contributed-metric slot is
  // empty here, matching a composition with no metric contributors.
  const renderSlot = ((key: string, owner: { node?: { key: string } }) =>
    (key === 'conversation.chat.node' && owner.node !== undefined
      ? <div data-node-key={owner.node.key}>{owner.node.key}</div>
      : null)) as unknown as ChatViewSlotProps['renderSlot']
  const props = {
    sessionId: 's1',
    useSession: ((selector: (value: ConversationSnapshot) => unknown) => selector(state)),
    useSessions: (() => undefined),
    useStore: (() => undefined),
    useCollapseSteps: ((selector: (value: boolean) => unknown) => selector(collapse)),
    renderSlot,
    openFile: vi.fn(),
    loadOlder: vi.fn(),
    loadImage: vi.fn(),
    inspectCall: vi.fn(),
    forkAt: vi.fn(),
    fileMentions: () => undefined,
    chatScroll: { save: vi.fn(), read: () => null },
    t: makeTranslate(zh, commonZh),
  } as unknown as ChatViewSlotProps
  return render(<ChatView {...props} />)
}

/** Rendered flow identity: node keys in order, with collapse markers named. */
function flow(view: ReturnType<typeof render>): string[] {
  return [...view.container.querySelectorAll('[data-node-key],[data-collapsed-turn]')]
    .map(el => el.getAttribute('data-node-key') ?? `collapsed:${String(el.getAttribute('data-collapsed-turn'))}`)
}

const THREE_STEPS = [stepNode('s1', 1, 1), stepNode('s2', 1, 2), stepNode('s3', 1, 3)]

describe('ChatView step collapse', () => {
  it('renders every step when the preference is off', () => {
    const view = mount(THREE_STEPS, false)
    expect(flow(view)).toEqual(['s1', 's2', 's3'])
    expect(view.container.querySelector('[data-collapsed-turn]')).toBeNull()
  })

  it('keeps only the last step visible when the preference is on', () => {
    const view = mount(THREE_STEPS, true)
    expect(flow(view)).toEqual(['collapsed:1', 's3'])
  })

  it('restores the hidden steps in place when the row is opened, and folds them again', () => {
    const view = mount(THREE_STEPS, true)
    const toggle = () => { fireEvent.click(view.getByRole('button')) }

    toggle()
    expect(flow(view)).toEqual(['collapsed:1', 's1', 's2', 's3'])

    toggle()
    expect(flow(view)).toEqual(['collapsed:1', 's3'])
  })

  it('hands a contributor exactly the keys the row hides', () => {
    // Scope parity with the built-in figures: a contributor that folds these
    // keys states the same thing they do, and never counts the visible step.
    let seen: unknown = null
    const state = snapshot(THREE_STEPS)
    const renderSlot = ((key: string, owner: unknown) => {
      if (key === 'conversation.chat.collapsedMetric') seen = owner
      return null
    }) as unknown as ChatViewSlotProps['renderSlot']
    render(<ChatView {...({
      sessionId: 's1',
      useSession: ((selector: (value: ConversationSnapshot) => unknown) => selector(state)),
      useSessions: (() => undefined),
      useStore: (() => undefined),
      useCollapseSteps: ((selector: (value: boolean) => unknown) => selector(true)),
      renderSlot,
      openFile: vi.fn(),
      loadOlder: vi.fn(),
      loadImage: vi.fn(),
      inspectCall: vi.fn(),
      forkAt: vi.fn(),
      fileMentions: () => undefined,
      chatScroll: { save: vi.fn(), read: () => null },
      t: makeTranslate(zh, commonZh),
    } as unknown as ChatViewSlotProps)} />)
    // s3 is the visible last step and must not appear.
    expect(seen).toMatchObject({ turn: 1, keys: ['s1', 's2'] })
  })

  it('leaves a single-step turn untouched', () => {
    const view = mount([stepNode('only', 1, 1)], true)
    expect(flow(view)).toEqual(['only'])
    expect(view.container.querySelector('[data-collapsed-turn]')).toBeNull()
  })
})

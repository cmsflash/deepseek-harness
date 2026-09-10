// @vitest-environment jsdom
/**
 * ChatView's step-collapse behavior: the preference gates it entirely, a
 * turn's settled steps fold behind one row, and the disclosure restores them
 * through the same node seat that renders every other row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type {
  ChatConversationViewNode, ChatSnapshot, TranscriptViewMode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { StepDigest } from '@deepseek-ai/dsh-api-remotes/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ChatView } from '../src/client/chat/ChatView.tsx'
import type { ChatViewSlotProps } from '../src/client/contract/slots.ts'
import { createChatStore } from '../src/client/stores.ts'
import { zh } from '../src/client/locale.ts'

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

const NO_SOURCE = { getSnapshot: () => undefined, subscribe: () => () => {} }

function snapshot(nodes: readonly ChatConversationViewNode[]): ChatSnapshot {
  const byKey = new Map(nodes.map(node => [node.key, node]))
  return {
    order: nodes.map(node => node.key),
    nodes: {
      get: key => byKey.get(key),
      values: () => nodes,
      source: key => ({ getSnapshot: () => byKey.get(key), subscribe: () => () => {} }),
      processSource: () => NO_SOURCE,
    },
    locations: { getTurn: () => EMPTY_KEYS, getStep: () => EMPTY_KEYS },
    navigation: { items: () => [] },
    timeline: { turnOrder: [], turns: new Map() },
    legacy: {
      nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [],
    },
  }
}

const SESSION = {
  queue: [], pendingSubmissions: [], running: false, openState: 'open', openError: null,
  hasMore: false, loadingOlder: false,
  stepDigests: new Map(), stepAccounts: new Map(), expandingTurns: new Set(),
} as unknown as SessionSnapshot

interface MountOptions {
  /** Receives every non-node slot render; the contributed-metric slot renders nothing by default. */
  readonly observeSlot?: (key: string, owner: unknown) => void
  /** Session snapshot fields layered over the quiescent default. */
  readonly session?: Partial<SessionSnapshot>
  /** The expansion request the view hands to the sessions domain. */
  readonly expandTurn?: (turn: number) => Promise<void>
}

/**
 * Mount ChatView over a fixed snapshot, dispatching node rows to a probe.
 * @param nodes - the snapshot's nodes, in render order.
 * @param mode - the transcript preference under test.
 * @param options - slot probe, session overrides, and the expansion stub.
 */
function mount(
  nodes: readonly ChatConversationViewNode[],
  mode: TranscriptViewMode,
  options: MountOptions = {},
) {
  const observeSlot = options.observeSlot ?? (() => {})
  const session = { ...SESSION, ...options.session } as SessionSnapshot
  const chat = snapshot(nodes)
  const store = createChatStore().create()
  const renderSlot = ((key: string, owner: { node?: { key: string } }) => {
    if (key === 'conversation.chat.node' && owner.node !== undefined) {
      return <div data-node-key={owner.node.key}>{owner.node.key}</div>
    }
    observeSlot(key, owner)
    return null
  }) as unknown as ChatViewSlotProps['renderSlot']
  const props = {
    sessionId: 's1',
    useSession: ((selector: (value: SessionSnapshot) => unknown) => selector(session)),
    useChat: ((selector: (value: ChatSnapshot) => unknown) => selector(chat)),
    useChatNode: ((key: string) => chat.nodes.get(key)),
    useChatNodeProcess: (() => undefined),
    useSessions: (() => undefined),
    useProjection: (() => undefined),
    useStore: ((selector: (value: unknown) => unknown) => selector(store.getSnapshot())),
    actions: store.actions,
    useTranscriptView: ((selector: (value: TranscriptViewMode) => unknown) => selector(mode)),
    renderSlot,
    openFile: vi.fn(),
    loadOlder: vi.fn(),
    loadThrough: vi.fn(),
    expandTurn: options.expandTurn ?? vi.fn(),
    loadImage: vi.fn(),
    openView: vi.fn(),
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
  it('renders every step outside the collapsed mode', () => {
    const view = mount(THREE_STEPS, 'compact')
    expect(flow(view)).toEqual(['s1', 's2', 's3'])
    expect(view.container.querySelector('[data-collapsed-turn]')).toBeNull()
  })

  it('keeps only the last step visible in the collapsed mode', () => {
    const view = mount(THREE_STEPS, 'collapsed')
    expect(flow(view)).toEqual(['collapsed:1', 's3'])
  })

  it('restores the hidden steps in place when the row is opened, and folds them again', () => {
    const view = mount(THREE_STEPS, 'collapsed')
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
    mount(THREE_STEPS, 'collapsed', {
      observeSlot: (key, owner) => {
        if (key === 'conversation.chat.collapsedMetric') seen = owner
      },
    })
    // s3 is the visible last step and must not appear.
    expect(seen).toMatchObject({ turn: 1, keys: ['s1', 's2'] })
  })

  it('leaves a single-step turn untouched', () => {
    const view = mount([stepNode('only', 1, 1)], 'collapsed')
    expect(flow(view)).toEqual(['only'])
    expect(view.container.querySelector('[data-collapsed-turn]')).toBeNull()
  })

  it('folds a turn whose earlier steps the page withheld, and fetches them on opening', () => {
    // Only the last step reached the window; the digest stands for step 1.
    const digest: StepDigest = {
      turn: 1, step: 1, startSeq: 3, endSeq: 9, elided: 5, steps: 1, calls: 2, files: 1,
      added: 4, removed: 1, elapsedMs: 1200, inputTokens: 30, outputTokens: 10,
    }
    const digests = new Map([[1, [digest]]])
    const expandTurn = vi.fn<(turn: number) => Promise<void>>().mockResolvedValue(undefined)
    const view = mount([stepNode('s2', 1, 2)], 'collapsed', {
      session: { stepDigests: digests, stepAccounts: digests },
      expandTurn,
    })
    expect(flow(view)).toEqual(['collapsed:1', 's2'])
    // The row reports the withheld step's own figures, not a fold of loaded nodes.
    expect(view.container.textContent).toContain('2')

    fireEvent.click(view.getByRole('button'))
    expect(expandTurn).toHaveBeenCalledWith(1)
  })

  it('keeps the row after expansion loads the withheld steps into the window', () => {
    const digest: StepDigest = {
      turn: 1, step: 1, startSeq: 3, elided: 5, steps: 1, calls: 1, files: 0,
      added: 0, removed: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0,
    }
    const accounts = new Map([[1, [digest]]])
    // The interior arrived (s1 is in the window) and the withheld marker
    // cleared, but the account remains: the row keeps standing for step 1.
    const view = mount([stepNode('s1', 1, 1), stepNode('s2', 1, 2)], 'collapsed', {
      session: { stepDigests: new Map(), stepAccounts: accounts },
    })
    expect(flow(view)).toEqual(['collapsed:1', 's2'])
    fireEvent.click(view.getByRole('button'))
    expect(flow(view)).toEqual(['collapsed:1', 's1', 's2'])
  })

  it('announces an in-flight expansion on the row', () => {
    const digest: StepDigest = {
      turn: 1, step: 1, startSeq: 3, elided: 5, steps: 1, calls: 1, files: 0,
      added: 0, removed: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0,
    }
    const digests = new Map([[1, [digest]]])
    const view = mount([stepNode('s2', 1, 2)], 'collapsed', {
      session: { stepDigests: digests, stepAccounts: digests, expandingTurns: new Set([1]) },
    })
    expect(view.getByRole('status').textContent).toBe(commonZh.loading)
  })
})

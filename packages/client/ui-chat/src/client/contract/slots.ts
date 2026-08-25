/** Chat-owned Slot declarations and composed component props. */
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {
  CommandNode, CompactionSummaryNode, ConversationLocationDataStore, ConversationTurnDataMap,
  MessageImageLoader, MessageImagesOwnerProps, RenderMessageImages, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  InjectFace, KeyedSnapshotSelectorHook, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
  SlotHookFactory, SnapshotSelectorHook,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { createChatStore } from '../stores.ts'
import type { ToolCallId } from './store.ts'
import type { ChatConversationViewNode, ChatNode, ChatNodeKind } from './chat-nodes.ts'
import type {
  ChatNodeProcessSource, ChatNodeSource, ChatSnapshot, ChatTurnProcessPresentation,
} from './snapshot.ts'
import type { TurnProcessSpec } from './turn-process.ts'
import type { TranscriptViewMode } from '../../chat-settings.ts'

/** Selector hook over the current Conversation binding's Chat target. */
export type UseChat = SnapshotSelectorHook<ChatSnapshot>

/** Per-key selector hook over one Chat Node. */
export type UseChatNode = KeyedSnapshotSelectorHook<ChatConversationViewNode | undefined>

/** Per-key selector hook over one Chat Node's Turn-process presentation. */
export type UseChatNodeProcess = KeyedSnapshotSelectorHook<ChatTurnProcessPresentation | undefined>

/** Where in a file an open should land. */
export interface OpenFileOptions {
  /** 1-based line to reveal; absent = the file's beginning. */
  readonly line?: number
}

/** Owner currency of the completed-Turn extension chain. */
export interface TurnTailOwnerProps {
  turn: TurnLocation
  seq: number
  openFile: (path: string) => void
}

/** Owner currency of finalized-assistant actions. */
export interface AssistantActionOwnerProps {
  messageId: MessageId
}

/**
 * Owner currency of one contributed collapsed-row figure: which turn's hidden
 * steps the row stands for, and the counts it already folded.
 */
export interface CollapsedMetricOwnerProps {
  /** Turn owning the hidden steps. */
  turn: number
  /**
   * Node keys this row hides, in render order.
   *
   * Every built-in figure sums these keys alone, so a contributor that folds
   * the same set states the same scope. Reading the whole turn instead counts
   * the still-visible last step, which no other figure on the line includes
   * and expanding the row cannot account for.
   */
  keys: readonly string[]
  /** Hidden model calls; zero when the group's work was entirely tool calls. */
  steps: number
  /** Hidden settled tool calls, counting nested subcalls. */
  calls: number
}

/** Optional prose file-mention provider consumed by Chat. */
export interface ChatFileMentions {
  /**
   * Resolve prose links for one closing Turn.
   * @param owner - closing-Turn identity and file opener.
   * @param sessionId - viewed Session, including when history is inherited from a fork.
   * @returns link resolver when available.
   */
  forClosing(owner: TurnTailOwnerProps, sessionId: SessionId): MarkdownFileMentions | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional prose file-mention provider. */
    chatFileMentions: ChatFileMentions
  }
}

/** Hook constrained to business data published on the current Chat Node's Turn. */
export type UseChatNodeTurnData = <Key extends Extract<keyof ConversationTurnDataMap, string>>(
  key: Key,
) => Readonly<ConversationTurnDataMap[Key]> | undefined

/** Slot-level Hook factory for keyed Chat renderers. */
export interface ChatNodeTurnDataInjected {
  hooks: { turnData: SlotHookFactory<'conversation.chat.node', UseChatNodeTurnData> }
}

/** Stable owner currency delivered to a keyed Chat renderer. */
export interface ChatNodeOwnerProps {
  cwd?: string | undefined
  /** Open the current source file of a skill referenced by a sent message. */
  openSkill: (name: string) => void
  openFile: (path: string, options?: OpenFileOptions) => void
  inspectCall: (callId: ToolCallId) => void
  forkAt: (seq: number) => void
  /**
   * Session-authorized image loader, down-threaded from the Chat view so a
   * chat-node renderer can render the attachment presentation slot directly
   * with only the durable references plus this loader, instead of receiving a
   * rendering closure.
   */
  loadImage: MessageImageLoader
  renderMessageImages: RenderMessageImages
  fileMentions: (owner: TurnTailOwnerProps) => MarkdownFileMentions | undefined
  /** Turn-process state when this Node belongs to a projected Turn. */
  turnProcess?: TurnProcessOwnerProps | undefined
}

/** Shared presentation state for one Turn-process answer generation. */
export interface TurnProcessOwnerProps {
  readonly spec: TurnProcessSpec
  readonly foldable: boolean
  readonly open: boolean
  setOpen(open: boolean): void
}

/** Full props of one keyed Chat renderer. */
export type ChatNodeViewProps<Kind extends ChatNodeKind = ChatNodeKind> =
  PropsRuntime<'conversation.chat.node', Kind> & PropsLocale<'chat'>

/** Command-row owner share. */
export interface CommandRowOwnerProps {
  node: CommandNode
  compaction?: CompactionSummaryNode
}

/** Full props of a registered command row. */
export type CommandRowProps = PropsRuntime<'conversation.chat.commandview'>

/** Shared Chat store handle. */
export type ChatStore = ReturnType<typeof createChatStore>

/** In-memory reader position resilient to transcript reflow. */
export interface ChatScrollPosition {
  readonly anchorKey: string
  readonly anchorTop: number
  readonly scrollTop: number
}

/** Business callbacks injected into the Chat view. */
export interface ChatViewInjected {
  hooks: {
    /** Persisted transcript presentation. */
    transcriptView: SnapshotStore<TranscriptViewMode>
  }
  keyedHooks: {
    /** Resolve the stable source for one Chat Node key. */
    chatNode: (key: string) => ChatNodeSource
    /** Resolve the stable Turn-process source for one Chat Node key. */
    chatNodeProcess: (key: string) => ChatNodeProcessSource
  }
  /** Open the current source file of a skill referenced by a sent message. */
  openSkill: (name: string) => void
  /** Open one HTTP(S) message link in a Sidebar Browser tab. */
  openExternalLink: (url: string) => void
  openFile: (path: string, options?: OpenFileOptions) => Promise<void>
  loadOlder: () => void
  /** Jump loader: page history back through seq; resolves when the window covers it. */
  loadThrough: (seq: SessionSeq) => Promise<void>
  loadImage: MessageImageLoader
  chatScroll: {
    save: (position: ChatScrollPosition | null) => void
    read: () => ChatScrollPosition | null
  }
  forkAt: (seq: number) => void
  fileMentions: (owner: TurnTailOwnerProps) => MarkdownFileMentions | undefined
}

/** Full Chat view props. */
export type ChatViewSlotProps =
  PropsRuntime<'conversation.view'>
  & PropsRenderSlots<'conversation.chat.node' | 'conversation.message.images' | 'conversation.chat.collapsedMetric'>
  & PropsStore<ChatStore>
  & InjectFace<ChatViewInjected>
  & PropsLocale<'chat'>

/** Full props of the durable-message image renderer. */
export type MessageImagesProps = PropsRuntime<'conversation.message.images'> & PropsLocale<'conversation'>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    /** Selector hook over the current Conversation binding's Chat target. */
    useChat: UseChat
  }

  interface LocaleNamespaceMap {
    /** Chat target, transcript node, statistics, and details copy. */
    chat: import('../locale.ts').ChatKey
  }

  interface SlotMap {
    /**
     * Final Chat node renderer, keyed by `ChatNodeKind`. The component receives
     * the typed node, shared Chat actions, and Turn-data hook. Reusing a key
     * replaces that node renderer; a kind with no occupant renders no row.
     */
    'conversation.chat.node': {
      kind: 'keyed'
      scope: 'session'
      owner: ChatNodeOwnerProps
      keyProps: { [Kind in ChatNodeKind]: { node: ChatNode<Kind> } }
      hookContext: ConversationLocationDataStore<ConversationTurnDataMap> | undefined
      inject: ChatNodeTurnDataInjected
    }
    /**
     * Renderer for one consecutive group of durable message images. The owner
     * supplies image references, an authorized loader, and alignment. A
     * registration replaces the shipped gallery; without one, images are omitted.
     */
    'conversation.message.images': { kind: 'single'; scope: 'session'; owner: MessageImagesOwnerProps }
    /**
     * Command row keyed by the command name. The component receives the folded
     * command lifecycle and linked compaction when present. Reusing a key
     * replaces that command renderer; an unoccupied key uses the generic card.
     */
    'conversation.chat.commandview': { kind: 'keyed'; scope: 'session'; owner: CommandRowOwnerProps }
    /**
     * Ordered feature contributions before a completed Turn's action row. Each
     * entry receives the Turn, closing sequence, and file opener. A fresh `id`
     * adds an entry; entries without content return null.
     */
    'conversation.chat.turnTail': { kind: 'list'; scope: 'session'; owner: TurnTailOwnerProps }
    /**
     * Ordered actions for one finalized assistant message. Each entry receives
     * the durable message id; a fresh `id` adds an action and reusing one replaces
     * that entry. With no entries, the standard action row remains unchanged.
     */
    'conversation.chat.assistant-actions': { kind: 'list'; scope: 'session'; owner: AssistantActionOwnerProps }
    /**
     * One contributed figure on a collapsed-steps row, rendered after every
     * figure the row itself computes. Built-ins always come first, so a
     * contributor never has to reserve an `order` band against figures this
     * row may gain later; entries render among themselves by ascending
     * `order`. The owner passes the collapsed group's identity and its
     * already-folded counts, so a contributor addresses the same hidden steps
     * without re-reading the Session.
     */
    'conversation.chat.collapsedMetric': { kind: 'list'; scope: 'session'; owner: CollapsedMetricOwnerProps }
  }
}

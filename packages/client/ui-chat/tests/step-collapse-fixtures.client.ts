import type {
  AssistantChatData, ChatConversationViewNode, ChatNodeStore,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationLocation, ConversationLocationDataStore, ConversationStepDataMap, ConversationTimelineSnapshot,
  ConversationTurnDataMap, StepLocation, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { KeyedSnapshotSelectorHook, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'

/** Read-only Location data: one optional value per key, never observed. */
function dataStore<DataMap extends object>(values: Partial<DataMap>): ConversationLocationDataStore<DataMap> {
  return {
    get: key => values[key],
    source: () => { throw new Error('step-collapse fixtures read Location data without subscribing') },
  }
}

const EMPTY_TURN_DATA = dataStore<ConversationTurnDataMap>({})

function stepLocation(turn: number, step: number, assistant?: AssistantChatData): StepLocation {
  return {
    turn, step, status: 'closed', end: undefined,
    start: { type: 'step/start', seq: SessionSeq(step * 10), time: 0, data: { turn, step } },
    data: dataStore<ConversationStepDataMap>(assistant === undefined ? {} : { 'assistant-step': assistant }),
  }
}

function turnLocation(turn: number, steps: readonly StepLocation[] = []): TurnLocation {
  return { turn, start: undefined, end: undefined, status: 'closed', steps, data: EMPTY_TURN_DATA }
}

/** A settled assistant step payload, as the Assistant Definition publishes it. */
export function settledAssistant(options: {
  turn?: number
  step?: number
  text?: string
  usage?: unknown
  stepStartTime?: number | null
  completedTime?: number
} = {}): AssistantChatData {
  const turn = options.turn ?? 1
  const step = options.step ?? 1
  const blocks = options.text === undefined ? [] : [{ kind: 'text' as const, text: options.text }]
  return {
    status: 'settled', turn, step, blocks, time: 0,
    ...options.usage === undefined ? {} : { usage: options.usage },
    finalNode: {
      kind: 'assistant', seq: 0, time: 0, turn, step, blocks,
      timing: { stepStartTime: options.stepStartTime ?? null, firstTokenTime: null, completedTime: options.completedTime ?? 0 },
    },
  }
}

/**
 * One visible Chat node at a Session, Turn, or Step coordinate. A Turn-only
 * node has no Step, as for rows logged before the Turn's first `step/start`.
 * @param options - identity, kind, coordinate, anchor, and payload.
 * @returns the materialized node.
 */
export function chatNode(options: {
  key: string
  kind?: string
  turn?: number
  step?: number
  anchorSeq?: number
  data?: unknown
}): ChatConversationViewNode {
  const kind = options.kind ?? 'assistant-step'
  const { turn, step } = options
  const location: ConversationLocation = turn === undefined
    ? { kind: 'session' }
    : step === undefined
      ? { kind: 'turn', turn: turnLocation(turn) }
      : { kind: 'step', turn: turnLocation(turn), step: stepLocation(turn, step) }
  return {
    key: options.key, kind, id: options.key, target: 'chat', anchorSeq: options.anchorSeq ?? 0,
    visibility: 'visible', location,
    data: options.data ?? (kind === 'assistant-step' ? settledAssistant({ turn: turn ?? 1, step: step ?? 1 }) : undefined),
  }
}

/**
 * A Node store serving exactly `nodes`; the fold reads only `get` and `values`.
 * @param nodes - all materialized test nodes.
 * @returns the store.
 */
export function chatNodeStore(nodes: readonly ChatConversationViewNode[]): ChatNodeStore {
  const byKey = new Map(nodes.map(entry => [entry.key, entry]))
  const unused = (): never => { throw new Error('step-collapse fixtures expose only get() and values()') }
  return {
    get: key => byKey.get(key),
    values: () => nodes,
    source: unused,
    bottomSource: unused,
    turnDataSource: unused,
    processSource: unused,
  }
}

function assistantDataOf(node: ChatConversationViewNode): AssistantChatData | undefined {
  if (node.kind !== 'assistant-step') return undefined
  const data = node.data
  return typeof data === 'object' && data !== null && 'blocks' in data ? data as AssistantChatData : undefined
}

/**
 * Publish each turn's steps with their assistant data, as the Assistant
 * Definition's Location data does. A step's start seq is `step * 10`.
 * @param nodes - all materialized test nodes.
 * @param extra - assistant data of steps that render no node, keyed `turn:step`.
 * @returns the turn/step facts the step-collapse fold reads.
 */
export function timelineOf(
  nodes: readonly ChatConversationViewNode[],
  extra: ReadonlyMap<string, AssistantChatData> = new Map(),
): ConversationTimelineSnapshot {
  const turns = new Map<number, Map<number, AssistantChatData | undefined>>()
  const touch = (turn: number, step: number, data: AssistantChatData | undefined): void => {
    let steps = turns.get(turn)
    if (steps === undefined) turns.set(turn, steps = new Map())
    if (!steps.has(step) || data !== undefined) steps.set(step, data)
  }
  for (const node of nodes) {
    if (node.location.kind !== 'step') continue
    touch(node.location.turn.turn, node.location.step.step, assistantDataOf(node))
  }
  for (const [key, data] of extra) {
    const [turn, step] = key.split(':').map(Number) as [number, number]
    touch(turn, step, data)
  }
  return {
    turnOrder: [...turns.keys()],
    turns: new Map([...turns].map(([turn, steps]) => [turn, turnLocation(
      turn,
      [...steps].sort(([left], [right]) => left - right).map(([step, data]) => stepLocation(turn, step, data)),
    )])),
  }
}

/**
 * Bind a keyed selector hook over per-key observable sources, one cached hook per source.
 * @param resolve - source for one key.
 * @returns the keyed hook.
 */
export function bindKeyedSnapshotSelector<Value>(
  resolve: (key: string) => ObservableSnapshot<Value>,
): KeyedSnapshotSelectorHook<Value> {
  const hooks = new WeakMap<object, SnapshotSelectorHook<Value>>()
  return ((key: string, selector?: (value: Value) => unknown, equal?: (left: unknown, right: unknown) => boolean) => {
    const source = resolve(key)
    let useValue = hooks.get(source)
    if (useValue === undefined) {
      useValue = bindSnapshotSelector(source)
      hooks.set(source, useValue)
    }
    return useValue(selector ?? ((value: Value) => value), equal)
  }) as KeyedSnapshotSelectorHook<Value>
}

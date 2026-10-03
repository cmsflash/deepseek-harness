// Response-group summaries: each human input starts a group within its turn.
// A group keeps its highest assistant/tool step and its latest text visible;
// earlier steps and turn-owned context injections fold behind one summary row.
//
// The fold reads the already-published order, node store, and timeline, so it
// adds no engine state and no per-node subscription.

import type { StepDigest } from '@deepseek-ai/dsh-api-remotes/client'
import type { StepDigestsByTurn } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationLocation, ConversationTimelineSnapshot, ToolCallBlock,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { appliedFileDiffs, fileDiffLineDelta } from '@deepseek-ai/dsh-tools/presentation'
import type { AssistantChatData, ChatConversationViewNode, ToolChatData } from '../contract/chat-nodes.ts'
import type { ChatNodeStore } from '../contract/snapshot.ts'

/** A window whose pages carried every step serves no digests. */
const EMPTY_DIGESTS: StepDigestsByTurn = new Map()

/** Metrics summarizing the settled steps hidden behind one summary row. */
export interface CollapsedStepMetrics {
  /** Hidden model calls, including requests that rendered no assistant row. */
  steps: number
  /** Settled tool calls across those steps, counting nested subcalls. */
  calls: number
  /** Turn-owned context rows of this response group, including those beside its visible steps. */
  contextInjections: number
  /** Distinct file paths their applied diffs touched, across every hidden step. */
  files: number
  added: number
  removed: number
  /** Summed step/start to assistant/message wall time; 0 when no step recorded both. */
  elapsedMs: number
  /** Billed prompt-side tokens: uncached input plus cache reads and writes. */
  inputTokens: number
  outputTokens: number
}

/** One entry of the rendered flow: either a normal row or a collapse marker. */
export type ChatFlowRow =
  | { readonly kind: 'node'; readonly key: string }
  | {
    readonly kind: 'collapsed'
    /** Backend turn owning the hidden steps; the unit a withheld-step fetch loads. */
    readonly turn: number
    /** Step of the human input starting this response group; 1 for the turn's opening group. */
    readonly startStep: number
    /** `turn:startStep`, the disclosure identity. */
    readonly key: string
    /** Hidden node keys, in render order, revealed on expand. */
    readonly keys: readonly string[]
    readonly metrics: CollapsedStepMetrics
    /**
     * Whether this group still holds steps the window never loaded.
     *
     * A collapsed history page withholds those steps' events, so expanding
     * reads its turn back before the rows can render.
     */
    readonly withheld: boolean
  }

function coordinates(location: ConversationLocation): { turn?: number; step?: number } {
  if (location.kind === 'step') return { turn: location.turn.turn, step: location.step.step }
  if (location.kind === 'turn') return { turn: location.turn.turn }
  return {}
}

interface UsageLike {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
}

/**
 * Fold one settled tool root and its subcalls into the running metrics.
 *
 * Applied diffs are read by {@link appliedFileDiffs} from the same persisted
 * record the diff card reads — call head, outcome, and `meta` — so a failed
 * call, an `edit` with no usable metadata, and a `write` whose result persisted
 * no hunk all count the way the rendered card shows them. A running root has
 * settled nothing and contributes no call; a nested dispatch counts as a call
 * but persists no `meta`, so it contributes no lines.
 */
function foldTool(tool: ToolCallBlock, metrics: CollapsedStepMetrics, paths: Set<string>): void {
  if ('kind' in tool) {
    metrics.calls += 1
    if (tool.parentCallId === undefined) {
      const diffs = appliedFileDiffs({
        name: tool.call?.name ?? null,
        argumentsRaw: tool.call?.argsRaw ?? null,
        isError: tool.isError || tool.error !== undefined,
        meta: tool.meta,
      })
      for (const diff of diffs) {
        const delta = fileDiffLineDelta(diff)
        metrics.added += delta.added
        metrics.removed += delta.removed
        paths.add(diff.path)
      }
    }
  }
  for (const child of tool.subCalls) foldTool(child, metrics, paths)
}

/** Only assistant and tool rows determine which steps remain visible. */
const STEP_WORK_KINDS: ReadonlySet<string> = new Set(['assistant-step', 'tool-call'])
/** Human inputs, each starting a response group. */
const INPUT_KINDS: ReadonlySet<string> = new Set(['user', 'steering'])

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Add one recorded model call: its count, wall time, and provider tokens.
 *
 * Only a durable `assistant/message` records timing, matching the host's
 * per-step count; a still-streaming step or a chunk-only interruption adds
 * nothing. `usage` is the provider's own payload, so each field is read
 * defensively, and `stepStartTime` is null once the step's start leaves the
 * loaded window.
 */
function foldAssistant(data: AssistantChatData, metrics: CollapsedStepMetrics): void {
  const timing = data.finalNode?.timing
  if (timing === undefined) return
  metrics.steps += 1
  if (timing.stepStartTime !== null) metrics.elapsedMs += Math.max(0, timing.completedTime - timing.stepStartTime)
  const usage = data.usage
  if (typeof usage !== 'object' || usage === null) return
  const fields = usage as UsageLike
  // Harness TokenUsage keeps the three prompt-side buckets disjoint.
  metrics.inputTokens += count(fields.inputTokens) + count(fields.cacheReadTokens) + count(fields.cacheWriteTokens)
  metrics.outputTokens += count(fields.outputTokens)
}

function carriesText(node: ChatConversationViewNode): boolean {
  if (node.kind !== 'assistant-step') return false
  const data = node.data as AssistantChatData | undefined
  return data?.blocks.some(block => block.kind === 'text' && block.text.trim() !== '') === true
}

function emptyMetrics(): CollapsedStepMetrics {
  return { steps: 0, calls: 0, contextInjections: 0, files: 0, added: 0, removed: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0 }
}

interface Group {
  readonly key: string
  readonly turn: number
  readonly start: number
  /** Highest loaded step with assistant/tool rows: the group's current or final step. */
  lastStep: number | undefined
  /** Step of the group's latest text-carrying assistant row: its answer. */
  lastText: number | undefined
  readonly accounts: Map<number, StepDigest>
  withheld: boolean
  readonly keys: string[]
  readonly paths: Set<string>
  readonly metrics: CollapsedStepMetrics
  /** Row the marker precedes; without one the marker follows {@link Group.tail}. */
  anchor: string | undefined
  tail: string | undefined
}

/**
 * Split the rendered order into response groups and fold each group's settled
 * intermediate steps behind one summary row.
 *
 * A backend turn can consume steered human input after it has answered, so a
 * turn is partitioned at every `user` or `steering` row, at the step that
 * claimed it; context injections do not partition. Each group keeps its
 * highest assistant/tool step and its latest text-carrying step visible, which
 * keeps an answer given before a steer readable. Earlier assistant/tool rows
 * and every turn-owned context row fold into the group's own marker; a group
 * that hides nothing renders no marker. An expanded group contributes its
 * hidden keys as ordinary rows after its marker, so expansion renders through
 * the same seat as everything else.
 *
 * A collapsed history page withholds a step's interior and reports it through
 * `accounts`, the host's per-step figures, which stay correct after expansion
 * loads that step. An accounted step is therefore always hidden and never
 * folded again from loaded data, so the row reads identically open or closed.
 * Model calls, time, and tokens of loaded steps come from `timeline`'s
 * step-scoped assistant data, which includes requests whose assistant row is
 * hidden because they produced only tool calls.
 * @param order - the snapshot's visible node keys, in render order.
 * @param store - live node reader for those keys.
 * @param expanded - group keys (`turn:startStep`) the reader has expanded.
 * @param timeline - the snapshot's turn and step facts.
 * @param digests - per-turn digests of steps still withheld (drives the fetch-on-open marker).
 * @param accounts - every per-step account received, expanded turns included; defaults to `digests`.
 * @returns the flow rows to render, in order.
 */
export function collapseSettledSteps(
  order: readonly string[],
  store: ChatNodeStore,
  expanded: ReadonlySet<string>,
  timeline: ConversationTimelineSnapshot,
  digests: StepDigestsByTurn = EMPTY_DIGESTS,
  accounts: StepDigestsByTurn = digests,
): readonly ChatFlowRow[] {
  const nodes: ChatConversationViewNode[] = []
  for (const key of order) {
    const node = store.get(key)
    if (node !== undefined) nodes.push(node)
  }
  const position = new Map(nodes.map((node, index) => [node.key, index]))

  // A row logged before any step of its turn started carries only a turn
  // Location; it belongs to the next step that turn starts.
  const stepOf = (node: ChatConversationViewNode): { turn?: number; step?: number } => {
    const at = coordinates(node.location)
    if (at.turn === undefined || at.step !== undefined) return at
    const steps = timeline.turns.get(at.turn)?.steps ?? []
    const next = steps.find(step => step.start !== undefined && step.start.seq > node.anchorSeq)
    return { turn: at.turn, step: next?.step ?? (steps.at(-1)?.step ?? 0) + 1 }
  }

  const starts = new Map<number, number[]>()
  for (const node of nodes) {
    if (!INPUT_KINDS.has(node.kind)) continue
    const { turn, step } = stepOf(node)
    if (turn === undefined || step === undefined) continue
    const list = starts.get(turn) ?? [1]
    if (!list.includes(step)) list.push(step)
    starts.set(turn, list)
  }
  for (const list of starts.values()) list.sort((left, right) => left - right)

  const groups = new Map<string, Group>()
  const groupOf = (turn: number, step: number): Group => {
    let start = 1
    for (const candidate of starts.get(turn) ?? []) if (candidate <= step) start = candidate
    const key = `${String(turn)}:${String(start)}`
    let group = groups.get(key)
    if (group === undefined) {
      group = {
        key, turn, start, lastStep: undefined, lastText: undefined, accounts: new Map(), withheld: false,
        keys: [], paths: new Set(), metrics: emptyMetrics(), anchor: undefined, tail: undefined,
      }
      groups.set(key, group)
    }
    return group
  }

  const owners = new Map<string, { readonly group: Group; readonly step: number }>()
  for (const node of nodes) {
    if (node.kind !== 'context' && !INPUT_KINDS.has(node.kind) && !STEP_WORK_KINDS.has(node.kind)) continue
    const { turn, step } = stepOf(node)
    if (turn === undefined || step === undefined) continue
    const group = groupOf(turn, step)
    owners.set(node.key, { group, step })
    group.tail = node.key
    if (!STEP_WORK_KINDS.has(node.kind)) continue
    if (group.lastStep === undefined || step > group.lastStep) group.lastStep = step
    if (carriesText(node) && (group.lastText === undefined || step > group.lastText)) group.lastText = step
  }
  for (const [turn, entries] of accounts) {
    for (const account of entries) groupOf(turn, account.step).accounts.set(account.step, account)
  }
  for (const [turn, entries] of digests) {
    for (const digest of entries) groupOf(turn, digest.step).withheld = true
  }

  const hiddenStep = (group: Group, step: number): boolean =>
    group.accounts.has(step) || (step !== group.lastStep && step !== group.lastText)
  const hidden = (node: ChatConversationViewNode): boolean => {
    const owner = owners.get(node.key)
    if (owner === undefined) return false
    if (node.kind === 'context') return true
    return STEP_WORK_KINDS.has(node.kind) && hiddenStep(owner.group, owner.step)
  }

  for (const group of groups.values()) {
    for (const account of group.accounts.values()) {
      group.metrics.steps += account.steps
      group.metrics.calls += account.calls
      group.metrics.added += account.added
      group.metrics.removed += account.removed
      group.metrics.elapsedMs += account.elapsedMs
      group.metrics.inputTokens += account.inputTokens
      group.metrics.outputTokens += account.outputTokens
      // Accounts carry paths rather than a count, so a file edited in a
      // withheld step and again in a loaded one counts once.
      for (const path of account.filePaths) group.paths.add(path)
    }
  }
  for (const turn of timeline.turns.values()) {
    for (const step of turn.steps) {
      const group = groupOf(turn.turn, step.step)
      // A step past the group's last loaded work is the live one, not yet rendered.
      if (group.lastStep === undefined || step.step > group.lastStep) continue
      if (group.accounts.has(step.step) || !hiddenStep(group, step.step)) continue
      const assistant = step.data.get('assistant-step')
      if (assistant !== undefined) foldAssistant(assistant, group.metrics)
    }
  }
  for (const node of nodes) {
    if (!hidden(node)) continue
    const { group, step } = owners.get(node.key) as { readonly group: Group; readonly step: number }
    group.keys.push(node.key)
    group.anchor ??= node.key
    if (node.kind === 'context') group.metrics.contextInjections += 1
    else if (node.kind === 'tool-call' && !group.accounts.has(step)) {
      foldTool((node.data as ToolChatData).root, group.metrics, group.paths)
    }
  }
  for (const group of groups.values()) {
    group.metrics.files = group.paths.size
    if (group.accounts.size === 0) continue
    // Withheld steps have no rows until expansion loads them, so the marker
    // opens at the group's first loaded work and stays there once they arrive.
    const first = nodes.find(node => owners.get(node.key)?.group === group
      && (node.kind === 'context' || STEP_WORK_KINDS.has(node.kind)))
    if (first === undefined) continue
    const anchorAt = group.anchor === undefined ? Infinity : position.get(group.anchor) as number
    if ((position.get(first.key) as number) < anchorAt) group.anchor = first.key
  }

  const rows: ChatFlowRow[] = []
  const emitted = new Set<Group>()
  const emit = (group: Group): void => {
    if (emitted.has(group) || (group.keys.length === 0 && group.accounts.size === 0)) return
    emitted.add(group)
    rows.push({
      kind: 'collapsed',
      turn: group.turn,
      startStep: group.start,
      key: group.key,
      keys: group.keys,
      metrics: group.metrics,
      withheld: group.withheld,
    })
  }
  for (const node of nodes) {
    const group = owners.get(node.key)?.group
    if (group?.anchor === node.key) emit(group)
    if (group === undefined || !hidden(node) || expanded.has(group.key)) rows.push({ kind: 'node', key: node.key })
    if (group !== undefined && group.anchor === undefined && group.tail === node.key) emit(group)
  }
  return rows
}

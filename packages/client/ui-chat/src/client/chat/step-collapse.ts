// Step-collapse fold: split the rendered Chat order into rows that stay
// visible and the settled steps that hide behind one per-turn summary.
//
// Granularity is the log's own: a `turn` is one user round, and each `step`
// inside it is one model call with its tool calls. Only a turn's LAST step
// carries current work, so earlier steps collapse; a node with no step
// coordinate (the prompting message, the turn tail) is never collapsed.
//
// The fold reads the already-published order and node store, so it adds no
// engine state and no per-node subscription.

import type { StepDigest } from '@deepseek-ai/dsh-api-remotes/client'
import type { StepDigestsByTurn } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '../contract/chat-nodes.ts'
import type { ChatNodeStore } from '../contract/snapshot.ts'

/** A window whose pages carried every step serves no digests. */
const EMPTY_DIGESTS: StepDigestsByTurn = new Map()

/** Identity of one step within its turn. */
function stepKey(turn: number, step: number): string {
  return `${String(turn)}:${String(step)}`
}

/** Metrics summarizing the settled steps hidden behind one summary row. */
export interface CollapsedStepMetrics {
  /** Collapsed model calls (one per hidden step). */
  steps: number
  /** Settled tool calls across those steps, counting nested subcalls. */
  calls: number
  /** Distinct file paths their diff cards touched. */
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
    /** Turn owning the hidden steps; also the expansion identity. */
    readonly turn: number
    /** Hidden node keys, in render order, revealed on expand. */
    readonly keys: readonly string[]
    readonly metrics: CollapsedStepMetrics
    /**
     * Whether this turn still holds steps the window never loaded.
     *
     * A collapsed history page withholds those steps' events, so expanding
     * reads them back before the rows can render. A row without withheld
     * steps expands from material already in the window.
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

interface DiffLike {
  path?: unknown
  oldText?: unknown
  newText?: unknown
}

interface AssistantLike {
  usage?: unknown
  finalNode?: { timing?: { stepStartTime: number | null; completedTime: number } }
}

interface ToolLike {
  kind?: unknown
  callId?: unknown
  resultView?: { card?: unknown; diffs?: unknown } | null
  subCalls?: readonly unknown[]
}

/**
 * Split one file image into its lines. A single terminating newline ends the
 * last line rather than starting an empty one.
 */
function lines(text: string): readonly string[] {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body === '' ? [] : body.split('\n')
}

/**
 * Added and removed line counts for one applied diff card entry.
 *
 * Diff cards carry whole before/after images rather than hunks, so this is a
 * line-multiset difference: lines present in both cancel regardless of
 * position, which reads a moved line as unchanged and a modified line as one
 * addition plus one removal.
 * @param oldText - prior content, or null for a created file.
 * @param newText - content after the change.
 * @returns the added and removed line counts.
 */
export function diffLineDelta(oldText: string | null, newText: string): { added: number; removed: number } {
  if (oldText === null) return { added: lines(newText).length, removed: 0 }
  const remaining = new Map<string, number>()
  for (const line of lines(oldText)) remaining.set(line, (remaining.get(line) ?? 0) + 1)
  let added = 0
  for (const line of lines(newText)) {
    const available = remaining.get(line) ?? 0
    if (available > 0) remaining.set(line, available - 1)
    else added += 1
  }
  let removed = 0
  for (const surplus of remaining.values()) removed += surplus
  return { added, removed }
}

/** Fold one settled tool root and its subcalls into the running metrics. */
function foldTool(tool: ToolLike, metrics: CollapsedStepMetrics, paths: Set<string>): void {
  metrics.calls += 1
  const view = tool.resultView
  // The result view crosses the wire with only `card` schema-checked, so each
  // entry is validated here rather than trusted.
  if (view != null && view.card === 'diff' && Array.isArray(view.diffs)) {
    for (const entry of view.diffs) {
      if (typeof entry !== 'object' || entry === null) continue
      const { path, oldText, newText } = entry as DiffLike
      if (typeof path !== 'string' || typeof newText !== 'string') continue
      if (oldText !== null && typeof oldText !== 'string') continue
      const delta = diffLineDelta(oldText ?? null, newText)
      metrics.added += delta.added
      metrics.removed += delta.removed
      paths.add(path)
    }
  }
  for (const child of tool.subCalls ?? []) {
    if (typeof child === 'object' && child !== null) foldTool(child, metrics, paths)
  }
}

/**
 * Node kinds that stand for a turn's intermediate work.
 *
 * Collapsibility is decided by kind, not by whether a node sits inside a step
 * window: the engine assigns a step Location by log position, so the prompting
 * user message and any context injections logged inside a step carry one too.
 * Hiding those would remove the reader's own words from the transcript.
 */
const COLLAPSIBLE_KINDS: ReadonlySet<string> = new Set(['assistant-step', 'tool-call'])

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Add one settled step's wall time and provider-reported tokens.
 *
 * `usage` is typed `unknown` on the client because it is the provider's own
 * payload, so each field is read defensively; a step whose provider reported
 * nothing contributes zeros. Wall time needs both boundaries, and `stepStartTime`
 * is null once the step's start leaves the loaded window.
 */
function foldAssistant(data: AssistantLike | undefined, metrics: CollapsedStepMetrics): void {
  const timing = data?.finalNode?.timing
  if (timing !== undefined && timing.stepStartTime !== null) {
    metrics.elapsedMs += Math.max(0, timing.completedTime - timing.stepStartTime)
  }
  const usage = data?.usage
  if (typeof usage !== 'object' || usage === null) return
  const fields = usage as UsageLike
  // Harness TokenUsage keeps the three prompt-side buckets disjoint.
  metrics.inputTokens += count(fields.inputTokens) + count(fields.cacheReadTokens) + count(fields.cacheWriteTokens)
  metrics.outputTokens += count(fields.outputTokens)
}

/**
 * Accumulate one hidden node's contribution.
 *
 * A step is counted per assistant node, which the engine emits once per model
 * call whether that call produced prose, tool calls, or both.
 */
function foldNode(node: ChatConversationViewNode, metrics: CollapsedStepMetrics, paths: Set<string>): void {
  if (node.kind === 'assistant-step') {
    metrics.steps += 1
    foldAssistant(node.data as AssistantLike | undefined, metrics)
    return
  }
  const data = node.data as { root?: unknown } | undefined
  const root = data?.root
  if (typeof root === 'object' && root !== null) foldTool(root, metrics, paths)
}

/**
 * Group the rendered order so each turn keeps only its last step visible.
 *
 * Only assistant and tool rows collapse, so the prompting message, context
 * injections, and the turn tail stay visible wherever the log placed them. A
 * turn whose collapsible rows all belong to its last step produces no marker.
 * An expanded turn contributes its hidden keys as ordinary rows, so expansion
 * renders through the same seat as everything else.
 * A collapsed history page serves a step's boundaries and withholds its
 * interior, so `accounts` — the host's per-step figures — is what the row
 * reports. Those figures describe the whole step, so they stay correct after
 * expansion loads it, and the row reads identically open or closed. A step an
 * account covers is skipped when folding loaded nodes, so the two sources
 * never count the same work twice.
 * @param order - the snapshot's visible node keys, in render order.
 * @param store - live node reader for those keys.
 * @param expanded - turns the reader has expanded.
 * @param digests - per-turn digests of steps still withheld (drives the fetch-on-open marker).
 * @param accounts - every per-step account received, expanded turns included; defaults to `digests`.
 * @returns the flow rows to render, in order.
 */
export function collapseSettledSteps(
  order: readonly string[],
  store: ChatNodeStore,
  expanded: ReadonlySet<number>,
  digests: StepDigestsByTurn = EMPTY_DIGESTS,
  accounts: StepDigestsByTurn = digests,
): readonly ChatFlowRow[] {
  // Steps an account already describes: their loaded nodes must not be folded
  // a second time once expansion brings them into the window.
  const accountedSteps = new Set<string>()
  for (const [turn, entries] of accounts) {
    for (const entry of entries) accountedSteps.add(stepKey(turn, entry.step))
  }

  const lastStep = new Map<number, number>()
  for (const key of order) {
    const node = store.get(key)
    if (node === undefined) continue
    if (!COLLAPSIBLE_KINDS.has(node.kind)) continue
    const { turn, step } = coordinates(node.location)
    if (turn === undefined || step === undefined) continue
    const seen = lastStep.get(turn)
    if (seen === undefined || step > seen) lastStep.set(turn, step)
  }

  // Where each turn's marker opens: its first assistant or tool row.
  //
  // Resolved over the whole order before any row is emitted, because the set
  // of rows the marker would otherwise latch onto changes as the reader
  // expands and folds. Anchoring on kind — rather than on the first row
  // carrying a step coordinate — is also what keeps the marker below the
  // prompting message and any context injection: the engine assigns a step
  // Location by log position, so those carry one too.
  //
  // Only a turn that actually hides something gets an anchor: one whose
  // collapsible rows all belong to its last step, and which withheld nothing,
  // renders as an ordinary transcript.
  const anchors = new Map<number, string>()
  for (const key of order) {
    const node = store.get(key)
    if (node === undefined || !COLLAPSIBLE_KINDS.has(node.kind)) continue
    const { turn, step } = coordinates(node.location)
    if (turn === undefined || step === undefined) continue
    if (!accounts.has(turn) && step === lastStep.get(turn)) continue
    if (anchors.has(turn)) continue
    anchors.set(turn, key)
  }
  // The last step of each turn stays visible: it is the turn's current work,
  // and while streaming it is the live one.

  const rows: ChatFlowRow[] = []
  // One open marker per turn, so a turn's hidden steps collapse into a single
  // row even when later-turn rows interleave.
  const markers = new Map<number, { keys: string[]; metrics: CollapsedStepMetrics; paths: Set<string> }>()
  const openMarker = (turn: number): { keys: string[]; metrics: CollapsedStepMetrics; paths: Set<string> } => {
    let marker = markers.get(turn)
    if (marker === undefined) {
      // The marker is emitted for an expanded turn too: it carries the same
      // metrics and doubles as the control that folds the group back. Its
      // figures come from the turn's own account, which stays whole whether or
      // not the withheld steps have since been loaded.
      marker = {
        keys: [],
        metrics: foldDigests(accounts.get(turn)),
        paths: new Set(),
      }
      markers.set(turn, marker)
      rows.push({
        kind: 'collapsed',
        turn,
        keys: marker.keys,
        metrics: marker.metrics,
        withheld: digests.has(turn),
      })
    }
    return marker
  }
  for (const key of order) {
    const node = store.get(key)
    if (node === undefined) continue
    const { turn, step } = coordinates(node.location)
    // The marker opens at the turn's own anchor, decided before this pass, so
    // expanding a turn cannot move its summary row.
    if (turn !== undefined && anchors.get(turn) === key) openMarker(turn)
    const collapsible = COLLAPSIBLE_KINDS.has(node.kind)
      && turn !== undefined && step !== undefined && step !== lastStep.get(turn)
    if (!collapsible) {
      rows.push({ kind: 'node', key })
      continue
    }
    const marker = openMarker(turn)
    marker.keys.push(key)
    // A step described by an account is already counted there; folding its
    // loaded nodes too would double it once expansion materializes them.
    if (!accountedSteps.has(stepKey(turn, step))) {
      foldNode(node, marker.metrics, marker.paths)
    }
    if (expanded.has(turn)) rows.push({ kind: 'node', key })
  }
  for (const [turn, marker] of markers) {
    // Accounted steps report their file count as a total rather than as paths,
    // so the two sources add without overlapping.
    marker.metrics.files = marker.paths.size + digestFiles(accounts.get(turn))
  }
  return rows
}

/** Digest-side file total, kept separate from the loaded rows' path set. */
function digestFiles(digests: readonly StepDigest[] | undefined): number {
  let files = 0
  for (const digest of digests ?? []) files += digest.files
  return files
}

/**
 * Seed a marker's metrics from the steps the window withheld.
 *
 * The host computed each digest over its whole step, so these figures do not
 * depend on where the page boundary fell; the loaded rows then add to them.
 * @param digests - withheld steps of one turn, or undefined when none.
 * @returns metrics carrying the withheld work.
 */
function foldDigests(digests: readonly StepDigest[] | undefined): CollapsedStepMetrics {
  const metrics: CollapsedStepMetrics = {
    steps: 0, calls: 0, files: 0, added: 0, removed: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0,
  }
  for (const digest of digests ?? []) {
    metrics.steps += digest.steps
    metrics.calls += digest.calls
    metrics.added += digest.added
    metrics.removed += digest.removed
    metrics.elapsedMs += digest.elapsedMs
    metrics.inputTokens += digest.inputTokens
    metrics.outputTokens += digest.outputTokens
  }
  return metrics
}

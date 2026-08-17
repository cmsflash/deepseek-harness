// Per-turn metric folds over the settled conversation node stream.
//
// Source choice: this reads the target-neutral `ConversationNode` compatibility
// stream plus the engine-owned timeline, never another plugin's Chat Node
// payloads (those belong to their declaring Definition). Every figure is
// window-scoped by construction — the loaded history window is paged, so a
// summary describes the turns currently loaded, and `FocusMetrics` carries the
// truncation flag the view renders.

import type {
  ConversationNode, ConversationTimelineSnapshot, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'

/** One file's before/after images, as a validated `card:'diff'` view carries them. */
export interface DiffImages {
  path: string
  /** Prior content, or null for a created file. */
  oldText: string | null
  newText: string
}

/** Added/removed line counts folded from one turn's applied diff cards. */
export interface LineDelta {
  added: number
  removed: number
}

/** Prompt-side and completion token counts a turn's steps reported. */
export interface TurnTokens {
  /** Billed prompt tokens: uncached input plus cache reads and writes. */
  input: number
  output: number
  /** Cache-read share of `input`; absent when no step reported cache activity. */
  cacheRead?: number
}

/** One earlier turn folded into the figures its collapsed row displays. */
export interface TurnSummary {
  turn: number
  /** Assistant steps that settled inside this turn. */
  steps: number
  /** Settled tool calls, counting nested subcalls. */
  calls: number
  /** Distinct file paths the turn's diff cards touched. */
  filesTouched: number
  lines: LineDelta
  tokens: TurnTokens
  /** turn/start → turn/end wall time; absent when either boundary is outside the window. */
  elapsedMs?: number
  /** Whether the turn's own `turn/start` is inside the loaded window. */
  boundaryKnown: boolean
}

/** The complete fold the Focus view renders. */
export interface FocusMetrics {
  /** Earlier turns, ascending, each collapsed to one summary row. */
  previous: readonly TurnSummary[]
  /** The turn rendered in full — the latest one present, running or settled. */
  latestTurn: number | undefined
  /** Whether older history remains unloaded, so the totals are partial. */
  truncated: boolean
}

interface MutableSummary extends Omit<TurnSummary, 'lines' | 'tokens'> {
  lines: LineDelta
  tokens: { input: number; output: number; cacheRead: number; sawCache: boolean }
  paths: Set<string>
}

interface UsageLike {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Read one assistant node's provider-reported usage.
 *
 * `AssistantMessageNode.usage` is typed `unknown` on the client, so each field
 * is read defensively; a provider that reported nothing contributes zeros.
 * @param usage - the node's recorded usage value.
 * @returns billed input, output, and cache-read counts.
 */
export function readUsage(usage: unknown): { input: number; output: number; cacheRead: number } {
  if (typeof usage !== 'object' || usage === null) return { input: 0, output: 0, cacheRead: 0 }
  const fields = usage as UsageLike
  const cacheRead = count(fields.cacheReadTokens)
  return {
    // Harness TokenUsage keeps the three prompt-side buckets disjoint, so
    // billed input is their sum (`StatsLine.billedInputTokens` parity).
    input: count(fields.inputTokens) + cacheRead + count(fields.cacheWriteTokens),
    output: count(fields.outputTokens),
    cacheRead,
  }
}

/**
 * Split one file image into its lines.
 *
 * A single terminating newline ends the last line rather than starting an empty
 * one, so it is stripped before the split; that keeps the terminator out of the
 * counts instead of correcting for it afterwards.
 */
function lines(text: string): readonly string[] {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body === '' ? [] : body.split('\n')
}

/**
 * Fold one diff card's before/after text into added and removed line counts.
 *
 * Diff cards carry whole before/after images rather than hunks, so this is a
 * line-multiset difference: lines present in both images cancel regardless of
 * position, which counts a pure move as unchanged and a modified line as one
 * addition plus one removal.
 * @param diff - one file entry of an applied diff card.
 * @returns the added and removed line counts.
 */
export function diffLineDelta(diff: DiffImages): LineDelta {
  if (diff.oldText === null) return { added: lines(diff.newText).length, removed: 0 }
  const remaining = new Map<string, number>()
  for (const line of lines(diff.oldText)) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1)
  }
  let added = 0
  for (const line of lines(diff.newText)) {
    const available = remaining.get(line) ?? 0
    if (available > 0) remaining.set(line, available - 1)
    else added += 1
  }
  let removed = 0
  for (const surplus of remaining.values()) removed += surplus
  return { added, removed }
}

/**
 * Read the applied before/after images off a settled `card:'diff'` result view.
 *
 * The view crosses the wire and only its `card` string is schema-validated, so
 * a version mismatch or an anomalous plugin can deliver a diff card whose
 * `diffs` is absent, not an array, or carries malformed entries. A payload that
 * is not usable contributes no lines rather than throwing inside the fold.
 * @param view - the settled result view, or null for the generic default.
 * @returns validated file images, empty when this is not a usable diff card.
 */
function appliedDiffs(view: ToolResultNode['resultView']): readonly DiffImages[] {
  if (view === null || view.card !== 'diff') return []
  const raw: unknown = view.diffs
  if (!Array.isArray(raw)) return []
  const images: DiffImages[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const { path, oldText, newText } = entry as Record<string, unknown>
    if (typeof path !== 'string' || typeof newText !== 'string') continue
    if (oldText !== null && typeof oldText !== 'string') continue
    images.push({ path, oldText, newText })
  }
  return images
}

function emptySummary(turn: number): MutableSummary {
  return {
    turn,
    steps: 0,
    calls: 0,
    filesTouched: 0,
    lines: { added: 0, removed: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, sawCache: false },
    paths: new Set(),
    boundaryKnown: false,
  }
}

/** Count a settled tool result and its nested subcalls into its turn. */
function foldToolResult(summary: MutableSummary, node: ToolResultNode): void {
  summary.calls += 1
  for (const diff of appliedDiffs(node.resultView)) {
    const delta = diffLineDelta(diff)
    summary.lines.added += delta.added
    summary.lines.removed += delta.removed
    summary.paths.add(diff.path)
  }
  for (const subCall of node.subCalls) {
    if ('kind' in subCall) foldToolResult(summary, subCall)
    else summary.calls += 1
  }
}

function freeze(summary: MutableSummary): TurnSummary {
  const { paths, tokens, ...rest } = summary
  return {
    ...rest,
    filesTouched: paths.size,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      ...tokens.sawCache ? { cacheRead: tokens.cacheRead } : {},
    },
  }
}

/**
 * Fold the loaded window into per-turn summaries plus the latest turn number.
 *
 * A tool result carries no turn coordinate of its own, so it is attributed to
 * the turn of the nearest preceding assistant step — the same log order the
 * agent loop writes. Results preceding any in-window step belong to a turn
 * whose steps were paged out and are dropped rather than misattributed.
 * @param nodes - settled nodes of the loaded window, ascending by seq.
 * @param timeline - engine-owned turn boundaries for the same window.
 * @param hasMore - whether older history remains unloaded.
 * @returns summaries for earlier turns and the latest turn's number.
 */
export function deriveFocusMetrics(
  nodes: readonly ConversationNode[],
  timeline: ConversationTimelineSnapshot,
  hasMore: boolean,
): FocusMetrics {
  const summaries = new Map<number, MutableSummary>()
  const summaryFor = (turn: number): MutableSummary => {
    const existing = summaries.get(turn)
    if (existing !== undefined) return existing
    const created = emptySummary(turn)
    summaries.set(turn, created)
    return created
  }
  let currentTurn: number | undefined
  for (const node of nodes) {
    if (node.kind === 'assistant') {
      currentTurn = node.turn
      const summary = summaryFor(node.turn)
      summary.steps += 1
      const usage = readUsage(node.usage)
      summary.tokens.input += usage.input
      summary.tokens.output += usage.output
      summary.tokens.cacheRead += usage.cacheRead
      summary.tokens.sawCache ||= usage.cacheRead > 0
      continue
    }
    if (node.kind === 'tool-result' && currentTurn !== undefined) {
      foldToolResult(summaryFor(currentTurn), node)
    }
  }
  for (const [turn, summary] of summaries) {
    const boundary = timeline.turns.get(turn)
    summary.boundaryKnown = boundary?.start !== undefined
    if (boundary?.start !== undefined && boundary.end !== undefined) {
      summary.elapsedMs = Math.max(0, boundary.end.time - boundary.start.time)
    }
  }
  // The latest turn is whichever the engine knows of last: a turn that has
  // started but produced no step yet still owns the full-render slot, so the
  // reader sees it live from its first token.
  const latestTurn = timeline.turnOrder.at(-1)
    ?? [...summaries.keys()].sort((left, right) => left - right).at(-1)
  const previous = [...summaries.values()]
    .filter(summary => summary.turn !== latestTurn)
    .sort((left, right) => left.turn - right.turn)
    .map(freeze)
  return { previous, latestTurn, truncated: hasMore }
}

/**
 * Sum of a turn's billed input and output tokens.
 * @param tokens - one turn's folded token buckets.
 * @returns the combined prompt-side and completion token count.
 */
export function totalTokens(tokens: TurnTokens): number {
  return tokens.input + tokens.output
}

/**
 * Step-level history elision: decide which of a turn's steps a collapsing
 * reader is not looking at, describe each of those through a {@link StepDigest},
 * and withhold its interior until the reader expands the turn.
 *
 * The unit is the log's own. A `turn` is one user round; each `step` inside it
 * is one model call with its tool calls. A step's interior is by far the bulk
 * of a session log — settled tool results and streaming chunks — while the
 * boundaries that place it are a few dozen bytes, so eliding interiors lets one
 * page span far more turns without the client losing the shape of the history
 * it did not receive.
 *
 * @module
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { StepDigest } from './sessions.ts'

/** Step coordinate carried by every event logged inside a step window. */
interface StepCoordinate {
  readonly turn: number
  readonly step: number
}

/**
 * Read an event's own turn/step coordinate.
 *
 * The coordinate is read from the payload rather than from log position: an
 * event without both fields (a user message, a turn boundary, a request
 * header) belongs to no step and is never elided.
 * @param event - the event to place.
 * @returns its coordinate, or undefined when it carries none.
 */
function coordinateOf(event: SessionEvent): StepCoordinate | undefined {
  const data = event.data as { turn?: unknown; step?: unknown }
  const { turn, step } = data
  if (!Number.isSafeInteger(turn) || (turn as number) < 0) return undefined
  if (!Number.isSafeInteger(step) || (step as number) < 0) return undefined
  return { turn: turn as number, step: step as number }
}

/** Whether an assistant message carries non-blank text the transcript shows. */
function carriesText(event: SessionEvent): boolean {
  if (event.type !== 'assistant/message') return false
  const { message } = event.data as { message?: { content?: readonly unknown[] } }
  return (message?.content ?? []).some((block) => {
    const candidate = block as { type?: unknown; text?: unknown }
    return candidate.type === 'text' && typeof candidate.text === 'string' && candidate.text.trim() !== ''
  })
}

/** Steps of one turn that stay whole regardless of collapse. */
interface RetainedSteps {
  /** The turn's highest step: the reader's current work, and the live one while streaming. */
  readonly last: number
  /**
   * The step carrying the turn's last text-carrying assistant message.
   *
   * The turn footer picks its closing message, branch anchor, and latency
   * figures from that message, so eliding the step it lives in would degrade a
   * settled turn's footer rather than merely hide steps. It is almost always
   * the last step already; when it is not, retaining it costs one extra step.
   */
  readonly closing: number | undefined
}

/**
 * Locate, per turn, the steps that must be served whole.
 * @param events - the complete event range under consideration, ascending by seq.
 * @returns per-turn retained steps.
 */
function retainedSteps(events: readonly SessionEvent[]): Map<number, RetainedSteps> {
  const last = new Map<number, number>()
  const closing = new Map<number, number>()
  for (const event of events) {
    const at = coordinateOf(event)
    if (at === undefined) continue
    const seen = last.get(at.turn)
    if (seen === undefined || at.step > seen) last.set(at.turn, at.step)
    if (carriesText(event)) closing.set(at.turn, at.step)
  }
  const retained = new Map<number, RetainedSteps>()
  for (const [turn, step] of last) retained.set(turn, { last: step, closing: closing.get(turn) })
  return retained
}

/** Event types that place a step and therefore always ride the page. */
const STEP_BOUNDARIES: ReadonlySet<string> = new Set(['step/start', 'step/end'])

/**
 * Whether a step's interior may be withheld from a collapsed page.
 * @param at - the step's coordinate.
 * @param retained - per-turn steps that stay whole.
 * @returns true when the step is neither the turn's last nor its closing one.
 */
function isElidableStep(at: StepCoordinate, retained: ReadonlyMap<number, RetainedSteps>): boolean {
  const keep = retained.get(at.turn)
  if (keep === undefined) return false
  return at.step !== keep.last && at.step !== keep.closing
}

/**
 * Whether one event may be withheld from a collapsed page: interior to a step,
 * and that step is elidable.
 * @param event - candidate event.
 * @param retained - per-turn steps that stay whole.
 * @returns the owning coordinate when the event is elidable, else undefined.
 */
function elidableAt(
  event: SessionEvent,
  retained: ReadonlyMap<number, RetainedSteps>,
): StepCoordinate | undefined {
  if (STEP_BOUNDARIES.has(event.type)) return undefined
  const at = coordinateOf(event)
  if (at === undefined || !isElidableStep(at, retained)) return undefined
  return at
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

/** Non-negative finite reading of a provider-reported figure. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
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

/** Mutable accumulator behind one published digest. */
interface DigestDraft {
  readonly digest: StepDigest
  readonly paths: Set<string>
  /** `step/start` time, pending the final assistant message that closes the interval. */
  startTime: number | undefined
}

function draftFor(at: StepCoordinate, startSeq: number): DigestDraft {
  return {
    digest: {
      turn: at.turn,
      step: at.step,
      startSeq,
      elided: 0,
      steps: 0,
      calls: 0,
      files: 0,
      added: 0,
      removed: 0,
      elapsedMs: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    paths: new Set(),
    startTime: undefined,
  }
}

/**
 * Accumulate one elided event into its step's digest.
 *
 * Tool results are counted through the host-computed render intent that the
 * same pagination pass produces, so the figures match what the expanded rows
 * would show. A view whose entries fail validation contributes counts without
 * line volume rather than being dropped.
 */
function foldElided(draft: DigestDraft, event: SessionEvent, view: unknown): void {
  const { digest } = draft
  digest.elided += 1
  if (event.type === 'assistant/message') {
    digest.steps += 1
    const { usage } = event.data as { usage?: unknown }
    if (typeof usage === 'object' && usage !== null) {
      const fields = usage as UsageLike
      // Harness TokenUsage keeps the three prompt-side buckets disjoint.
      digest.inputTokens += count(fields.inputTokens) + count(fields.cacheReadTokens) + count(fields.cacheWriteTokens)
      digest.outputTokens += count(fields.outputTokens)
    }
    if (draft.startTime !== undefined) {
      digest.elapsedMs = Math.max(0, event.time - draft.startTime)
    }
    return
  }
  if (event.type !== 'tool/result') return
  digest.calls += 1
  const entry = view as { for?: unknown; view?: { card?: unknown; diffs?: unknown } } | undefined
  const card = entry?.view
  if (card?.card !== 'diff' || !Array.isArray(card.diffs)) return
  for (const item of card.diffs) {
    if (typeof item !== 'object' || item === null) continue
    const { path, oldText, newText } = item as DiffLike
    if (typeof path !== 'string' || typeof newText !== 'string') continue
    if (oldText !== null && typeof oldText !== 'string') continue
    const delta = diffLineDelta(oldText ?? null, newText)
    digest.added += delta.added
    digest.removed += delta.removed
    draft.paths.add(path)
  }
}

/** One page row: the event and the render intent computed for it. */
export interface CollapseCandidate {
  readonly event: SessionEvent
  readonly view?: unknown
}

/** A collapsed page: the rows that survive, and one digest per elided step. */
export interface CollapsedPage<Row> {
  readonly rows: Row[]
  readonly digests: StepDigest[]
}

/**
 * Split one already-paginated range into the rows a collapsed page serves and
 * the digests describing what it withheld.
 *
 * Retention is decided over `scope` rather than over the page, so a turn split
 * across pages keeps the same steps whole on each: deciding per page would let
 * the page boundary change which step counts as a turn's last, and the two
 * pages would then disagree about the same turn.
 * @param page - the rows this page would serve under `full`.
 * @param scope - the complete range the retention decision is made over.
 * @returns surviving rows and the digests for the elided steps.
 */
export function collapseSteps<Row extends CollapseCandidate>(
  page: readonly Row[],
  scope: readonly SessionEvent[],
): CollapsedPage<Row> {
  const retained = retainedSteps(scope)
  const drafts = new Map<string, DigestDraft>()
  const rows: Row[] = []
  // A step whose own `step/start` fell on an earlier page still needs a digest,
  // so a draft is created by whichever of the two arrives first and the other
  // fills in what it knows.
  const draftFrom = (at: StepCoordinate, seq: number): DigestDraft => {
    const key = `${String(at.turn)}:${String(at.step)}`
    let draft = drafts.get(key)
    if (draft === undefined) {
      draft = draftFor(at, seq)
      drafts.set(key, draft)
    }
    return draft
  }
  for (const row of page) {
    const { event } = row
    const boundary = STEP_BOUNDARIES.has(event.type) ? coordinateOf(event) : undefined
    if (boundary !== undefined && isElidableStep(boundary, retained)) {
      const draft = draftFrom(boundary, event.seq)
      if (event.type === 'step/start') {
        draft.digest.startSeq = event.seq
        draft.startTime = event.time
      } else draft.digest.endSeq = event.seq
    }
    const at = elidableAt(event, retained)
    if (at === undefined) {
      rows.push(row)
      continue
    }
    foldElided(draftFrom(at, event.seq), event, row.view)
  }
  const digests: StepDigest[] = []
  for (const draft of drafts.values()) {
    if (draft.digest.elided === 0) continue
    draft.digest.files = draft.paths.size
    digests.push(draft.digest)
  }
  digests.sort((left, right) => left.startSeq - right.startSeq)
  return { rows, digests }
}

/**
 * Select the events one collapsed page elided from a single turn.
 *
 * Retention is decided over the whole `events` range, matching
 * {@link collapseSteps}, so the two agree on which steps a turn withheld.
 *
 * `fromSeq` bounds the result to the window the caller actually holds. A turn
 * routinely starts before the page that shows it, and its earlier steps belong
 * to pages the client has not loaded: returning them would splice events below
 * the window head, leaving `baseSeq` describing a range the client no longer
 * holds contiguously. Those steps arrive with their own page instead, already
 * carrying their own digests.
 * @param events - the complete event range, ascending by seq.
 * @param turn - the turn the reader expanded.
 * @param fromSeq - lowest seq the caller's window holds; omitted expands the whole turn.
 * @returns the elided events of that turn within the bound, ascending by seq.
 */
export function elidedEventsOfTurn(
  events: readonly SessionEvent[],
  turn: number,
  fromSeq?: number,
): SessionEvent[] {
  const retained = retainedSteps(events)
  return events.filter(event => (fromSeq === undefined || event.seq >= fromSeq)
    && elidableAt(event, retained)?.turn === turn)
}

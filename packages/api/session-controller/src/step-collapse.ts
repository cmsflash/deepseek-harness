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

import { isAppendSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session'
import { appliedFileDiffs, fileDiffLineDelta } from '@deepseek-ai/dsh-tools/presentation'
import type { StepDigest } from './types.ts'

/** Step coordinate carried by every event logged inside a step window. */
interface StepCoordinate {
  readonly turn: number
  readonly step: number
}

/** PTC events inherit their root call's step; unrelated events remain unassigned. */
function coordinateOf(event: SessionEvent, heads: ReadonlyMap<string, CallHead>): StepCoordinate | undefined {
  if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') {
    return heads.get(event.data.rootCallId)?.at
  }
  const { turn, step } = event.data as { turn?: unknown; step?: unknown }
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
function retainedSteps(events: readonly SessionEvent[], heads: ReadonlyMap<string, CallHead>): Map<number, RetainedSteps> {
  const last = new Map<number, number>()
  const closing = new Map<number, number>()
  for (const event of events) {
    const at = coordinateOf(event, heads)
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
  heads: ReadonlyMap<string, CallHead>,
): StepCoordinate | undefined {
  if (STEP_BOUNDARIES.has(event.type)) return undefined
  const at = coordinateOf(event, heads)
  if (at === undefined || !isElidableStep(at, retained)) return undefined
  return at
}

interface UsageLike {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
}

/** Non-negative finite reading of a provider-reported figure. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Call head of one root `tool/call`, kept until its `tool/result` settles it. */
interface CallHead {
  readonly name: string
  readonly argumentsRaw: string
  readonly at: StepCoordinate
}

/**
 * Index every root call head by call id so a result can be read together with
 * the arguments it settled. A `write` whose result persisted no hunk applies
 * the content its head carries, and only the head says which tool ran.
 * @param events - the complete event range under consideration.
 * @returns call heads by call id.
 */
function callHeads(events: readonly SessionEvent[]): Map<string, CallHead> {
  const heads = new Map<string, CallHead>()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    heads.set(String(event.data.callId), {
      name: event.data.name,
      argumentsRaw: event.data.arguments,
      at: { turn: event.data.turn, step: event.data.step },
    })
  }
  return heads
}

/** Mutable accumulator behind one published digest. */
interface DigestDraft {
  turn: number
  step: number
  startSeq: number
  endSeq: number | undefined
  /** Events of this step withheld from the page being encoded. */
  elided: number
  steps: number
  readonly startedCalls: Set<string>
  readonly settledCalls: Set<string>
  closed: boolean
  added: number
  removed: number
  elapsedMs: number
  inputTokens: number
  outputTokens: number
  /** Distinct paths the step's applied diffs touched, in first-touch order. */
  readonly paths: Set<string>
  /** `step/start` time, pending the final assistant message that closes the interval. */
  startTime: number | undefined
}

function draftFor(at: StepCoordinate, startSeq: number): DigestDraft {
  return {
    turn: at.turn,
    step: at.step,
    startSeq,
    endSeq: undefined,
    elided: 0,
    steps: 0,
    startedCalls: new Set(),
    settledCalls: new Set(),
    closed: false,
    added: 0,
    removed: 0,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    paths: new Set(),
    startTime: undefined,
  }
}

/**
 * Accumulate one interior event into its step's account.
 *
 * File volume follows the shared persisted-diff/whole-file-write rule.
 * Root results and settled PTC dispatches both count as calls; PTC events
 * carry no file-mutation metadata and therefore add no line volume.
 */
function foldInterior(draft: DigestDraft, event: SessionEvent, heads: ReadonlyMap<string, CallHead>): void {
  if (event.type === 'assistant/message') {
    draft.steps += 1
    const { usage } = event.data as { usage?: unknown }
    if (typeof usage === 'object' && usage !== null) {
      const fields = usage as UsageLike
      // Harness TokenUsage keeps the three prompt-side buckets disjoint.
      draft.inputTokens += count(fields.inputTokens) + count(fields.cacheReadTokens) + count(fields.cacheWriteTokens)
      draft.outputTokens += count(fields.outputTokens)
    }
    if (draft.startTime !== undefined) {
      draft.elapsedMs = Math.max(0, event.time - draft.startTime)
    }
    return
  }
  if (event.type === 'tool/call') {
    draft.startedCalls.add(`root:${event.data.callId}`)
    return
  }
  if (event.type === 'tool/ptc-dispatch-start') {
    draft.startedCalls.add(`nested:${event.data.subCallId}`)
    return
  }
  if (event.type === 'tool/ptc-dispatch') {
    draft.settledCalls.add(`nested:${event.data.subCallId}`)
    return
  }
  if (event.type !== 'tool/result' || !isAppendSurfaceEvent(event)) return
  const { message, error, meta } = event.data
  draft.settledCalls.add(`root:${message.source.callId}`)
  const head = heads.get(String(message.source.callId))
  const diffs = appliedFileDiffs({
    name: head?.name ?? null,
    argumentsRaw: head?.argumentsRaw ?? null,
    isError: message.content[0].isError === true || error !== undefined,
    meta,
  })
  for (const diff of diffs) {
    const delta = fileDiffLineDelta(diff)
    draft.added += delta.added
    draft.removed += delta.removed
    draft.paths.add(diff.path)
  }
}

/**
 * Account every elidable step over the whole scope: boundaries and interior
 * figures of each step, independent of any page cut.
 * @param scope - the complete range retention is decided over.
 * @param retained - per-turn steps that stay whole.
 * @returns whole-step accounts keyed by `turn:step`.
 */
function accountSteps(
  scope: readonly SessionEvent[],
  retained: ReadonlyMap<number, RetainedSteps>,
  heads: ReadonlyMap<string, CallHead>,
): Map<string, DigestDraft> {
  const accounts = new Map<string, DigestDraft>()
  const closedTurns = new Set<number>()
  const accountFor = (at: StepCoordinate, firstSeq: number): DigestDraft => {
    const key = `${String(at.turn)}:${String(at.step)}`
    let draft = accounts.get(key)
    if (draft === undefined) {
      draft = draftFor(at, firstSeq)
      accounts.set(key, draft)
    }
    return draft
  }
  for (const event of scope) {
    if (event.type === 'turn/end') closedTurns.add(event.data.turn)
    const boundary = STEP_BOUNDARIES.has(event.type) ? coordinateOf(event, heads) : undefined
    if (boundary !== undefined && isElidableStep(boundary, retained)) {
      const draft = accountFor(boundary, event.seq)
      if (event.type === 'step/start') {
        draft.startSeq = event.seq
        draft.startTime = event.time
      } else {
        draft.endSeq = event.seq
        draft.closed = true
      }
      continue
    }
    const at = elidableAt(event, retained, heads)
    if (at !== undefined) foldInterior(accountFor(at, event.seq), event, heads)
  }
  for (const draft of accounts.values()) {
    if (closedTurns.has(draft.turn)) draft.closed = true
  }
  return accounts
}

function publish(draft: DigestDraft): StepDigest {
  return {
    turn: draft.turn,
    step: draft.step,
    startSeq: draft.startSeq,
    ...draft.endSeq === undefined ? {} : { endSeq: draft.endSeq },
    elided: draft.elided,
    steps: draft.steps,
    calls: draft.closed
      ? new Set([...draft.startedCalls, ...draft.settledCalls]).size
      : draft.settledCalls.size,
    filePaths: [...draft.paths],
    added: draft.added,
    removed: draft.removed,
    elapsedMs: draft.elapsedMs,
    inputTokens: draft.inputTokens,
    outputTokens: draft.outputTokens,
  }
}

/** A collapsed page: the events that survive, and one digest per elided step. */
export interface CollapsedPage {
  readonly events: SessionEvent[]
  readonly digests: StepDigest[]
}

/**
 * Split one already-paginated range into the events a collapsed page serves
 * and the digests describing what it withheld.
 *
 * Retention is decided over `scope` rather than over the page, so a turn split
 * across pages keeps the same steps whole on each: deciding per page would let
 * the page boundary change which step counts as a turn's last, and the two
 * pages would then disagree about the same turn. A digest's figures are
 * likewise accounted over the whole step in `scope`, so a step cut by a page
 * boundary reports the same steps, calls, lines, paths, tokens, and wall time
 * from either page; only `elided` — the events this page withheld, which is
 * what expansion returns — is page-specific, and a client holding both pages
 * sums those counts under one account per step.
 * @param page - the events this page would serve under `full`, ascending by seq.
 * @param scope - the complete range the retention decision is made over.
 * @returns surviving events and the digests for the elided steps.
 */
export function collapseSteps(
  page: readonly SessionEvent[],
  scope: readonly SessionEvent[],
): CollapsedPage {
  const heads = callHeads(scope)
  const retained = retainedSteps(scope, heads)
  const accounts = accountSteps(scope, retained, heads)
  const events: SessionEvent[] = []
  for (const event of page) {
    const at = elidableAt(event, retained, heads)
    if (at === undefined) {
      events.push(event)
      continue
    }
    const key = `${String(at.turn)}:${String(at.step)}`
    const account = accounts.get(key)
    /* v8 ignore next -- every page event is in scope, so accountSteps has drafted its step. */
    if (account === undefined) continue
    account.elided += 1
  }
  const digests: StepDigest[] = []
  for (const account of accounts.values()) {
    if (account.elided === 0) continue
    digests.push(publish(account))
  }
  digests.sort((left, right) => left.startSeq - right.startSeq)
  return { events, digests }
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
 * the window head, leaving the head describing a range the client no longer
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
  const heads = callHeads(events)
  const retained = retainedSteps(events, heads)
  return events.filter(event => (fromSeq === undefined || event.seq >= fromSeq)
    && elidableAt(event, retained, heads)?.turn === turn)
}

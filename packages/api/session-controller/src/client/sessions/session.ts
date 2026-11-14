/** Reference-owned Session history, commands, and observable state. */

import type { Context } from '@deepseek-ai/cordis'
import type { InboxState, InboxTarget } from '@deepseek-ai/dsh-agent/types'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import { SessionLogOffset, SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionEventStream } from '../transport.ts'
import type { ClientSessionPageRequest, SessionJournalChange } from '../transport.ts'
import { historyEntries, historyInteriorEntries, historyPageFirstSeq, shareLocalHeaders } from './history-records.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  LocalHistoryPage, LocalHistoryRecord, SessionHistorySource,
} from '../contract/history-source.ts'
import { scheduleIdle } from './schedule.ts'
import type {
  PromptContentPart,
  QueueAction,
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionChainLink,
  SessionHistoryRecord,
  SessionProjectionBaseline,
  SessionRequestId,
  SessionStepDetail,
  StepDigest,
} from '../../types.ts'
import type {
  BeginSubmissionInput, PendingSubmissionRetirement, SessionFace, SubmissionHandle,
} from '../contract/session.ts'
import type {
  OpenState, PendingSubmission, PromptError, SessionSnapshot, StepDigestsByTurn,
} from '../contract/snapshot.ts'
import { MutableSessionEventSource } from '../contract/events.ts'
import type {
  SessionEventLike, SessionEventLikeEntry, SessionLiveEventEntry,
} from '../contract/events.ts'
import { Notifier } from './notifier.ts'
import { isRemoteFailure } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionRemotes } from './remotes.ts'
import { ProjectionValueStore } from './projection-store.ts'
import type { ProjectionsBaseline } from './projection-store.ts'
import { resolvedClientTimeZone } from '../time-zone.ts'
import {
  ClientAssistantStream,
  type ClientAssistantStreamResult,
} from './assistant-stream.ts'

function projectionsBaseline(value: SessionProjectionBaseline): ProjectionsBaseline {
  return {
    ...value,
    asOfSeq: value.asOfSeq === -1 ? -1 : SessionSeq(value.asOfSeq),
  }
}

/** Minimum message count for ordinary history windows. */
export const PAGE_MESSAGES = 50

/**
 * Minimum messages per collapsed page. A collapsed page carries a fraction of
 * a full page's bytes per message, and the point of collapsing is to reach
 * further back rather than to send a smaller response.
 */
export const COLLAPSED_PAGE_MESSAGES = 300

/** Turn-aligned window: at least 50 messages and two Turn starts, capped at 500 messages. */
const HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: PAGE_MESSAGES, minTurns: 2 } }

/** Cap of one requestIdleCallback measurement slice, per the memory plan's idle budget. */
const MEASURE_SLICE_MS = 5

/** Minimum messages per page while a turn jump loops backwards. */
export const JUMP_PAGE_MESSAGES = 200

const JUMP_PAGE_OPTIONS = {
  ...HISTORY_PAGE_OPTIONS,
  turnWindow: { ...HISTORY_PAGE_OPTIONS.turnWindow, minMessages: JUMP_PAGE_MESSAGES },
}

interface PendingHistory {
  beforeSeq: SessionLogOffset
  hasMore: boolean
  readonly pages: {
    readonly entries: readonly SessionEventLikeEntry[]
    readonly digests: readonly StepDigest[]
    readonly coveredFrom: number
  }[]
}

/** One contiguous window page the device memory budget tracks. */
export interface SessionWindowPage {
  /** First seq the page covers, including events a collapsed record stands for. */
  readonly from: number
  /** Last seq the page covers. */
  readonly to: number
  /** Wall time of the reader's last view of the page; null while never viewed. */
  viewedAt: number | null
  /** Wall time {@link Session.loadOlder} or {@link Session.loadThrough} added the page; null for every other page. */
  readonly loadedAt: number | null
  /** Measured bytes of the page's event text; null until measured. */
  bytes: number | null
}

/** Mutable bookkeeping behind one {@link SessionWindowPage}. */
interface WindowPageData {
  from: number
  to: number
  viewedAt: number | null
  readonly loadedAt: number | null
  bytes: number | null
}

/** Manager-owned observers of a Session object's local state edges. */
export interface SessionOptions {
  /** Catalog-discovered address selecting non-activating subagent transport. */
  address?: SubagentAddress
  /** Whether the exact direct parent Agent is available in Host summaries; absent until known. */
  parentAvailable?: boolean
  /**
   * Local copy this Session reads history from before asking the Host. An
   * addressed subagent never consults it: subagent Sessions are not copied.
   */
  historySource?: SessionHistorySource
  /**
   * Publish each accepted prompt to the Manager, including after this Session
   * object is replaced. Acceptance converts display state, but does not
   * establish that a turn started or reached durable history.
   */
  onEngaged?(session: Session): void
  /**
   * Manager-owned projection value store to adopt (frames route through the
   * manager and values outlive instantiation); omitted, the Session owns a
   * private store (bare object-layer construction).
   */
  projections?: ProjectionValueStore
  /** Step detail every page of this Session requests; omitted means `full`. */
  stepDetail?: SessionStepDetail
}

/**
 * Owns a session's event window, lifecycle state, and observable
 * snapshot. React bindings remain outside this data layer. Features see only
 * the {@link SessionFace} slice (ISession verbs + the snapshot source); the
 * remaining public members are Session Controller internals.
 */
export class Session implements SessionFace {
  // ---- Window and derived state (all private; the snapshot is the only read API) ----
  private baseSeq = SessionLogOffset(0)
  private hasMore = false
  private openState: OpenState = 'cold'
  private openError: RemoteFailure | null = null
  private openPromise: Promise<void> | null = null
  /** Bumped by stream replacement to invalidate an in-flight doOpen. Stale
   *  passes drop all writes once the generation moves on. */
  private openGeneration = 0
  private loadingOlder = false
  /** Shared low-water target of the running jump loop; null when no jump is paging. */
  private jumpTargetSeq: SessionSeq | null = null
  /** The running jump loop's completion, shared by retargeting callers. */
  private jumpPromise: Promise<void> | null = null
  private pendingHistory: PendingHistory | null = null
  private readonly stopObservingInbox: () => void
  private readonly assistantStream = new ClientAssistantStream()
  private running = false
  private address: SubagentAddress | undefined
  private parentAvailable: boolean | undefined
  /**
   * Sticky send marker, private input of the composerPhase derivation: set
   * when the Host accepts a prompt, never reset — the blank → engaging edge of
   * the phase machine (see ComposerPhase).
   */
  private promptAttempted = false
  /** A first accepted prompt stays in the engaging phase until its turn is observable. */
  private firstPromptPendingTurn = false
  /** New Session display state; unknown bare sessions begin conservatively blank. */
  private blankBit = true
  private removed = false
  private promptError: PromptError | null = null
  private lastAgentError: string | null = null
  /** Local submission echoes, insertion-ordered, including those the Host has not accepted yet. */
  private pendingSubmissions: readonly PendingSubmission[] = []
  /** The accepted echoes, published as SessionSnapshot.pendingSubmissions; rebuilt when one is accepted or removed. */
  private acceptedSubmissions: readonly PendingSubmission[] = []
  /** Per-echo settlement state; `retiring` latches the first observation so a
   *  Inbox projection and its durable event cannot both retire one echo. */
  private readonly submissionSettlements = new Map<SessionRequestId, {
    readonly placement: PendingSubmission['placement']
    /** Latest received Inbox position; null means removed from that queue. */
    receipt?: {
      readonly target: InboxTarget
      readonly seq: number
      readonly index: number | null
      readonly attachments: readonly (ImageAttachmentRef | FileAttachmentRef)[]
    }
    /** Durable admission may precede the Inbox projection acknowledging its claim. */
    admitted?: readonly (ImageAttachmentRef | FileAttachmentRef)[]
    /** Whether the Host accepted the prompt; the echo is published only from then on. */
    accepted: boolean
    readonly onAccept?: (() => void) | undefined
    readonly onRetire?: ((retirement: PendingSubmissionRetirement) => void) | undefined
    retiring: boolean
  }>()
  /** Owns the addressed page/follow lifecycle while this Session is open. */
  private events: SessionEventStream | undefined
  private stepDetail: SessionStepDetail = 'full'
  private fullHistoryRequired = false
  /** Physical follow replacement invalidates reads even when the Session stream object survives. */
  private windowGeneration = 0
  private detailLoad: { readonly source: SessionEventStream; readonly promise: Promise<void> } | undefined
  private stepDetailError: RemoteFailure | null = null
  /**
   * The window came from the local copy and no Host opening has confirmed it
   * yet; the first remote change clears it.
   */
  private unconfirmed = false
  /** The unconfirmed window came from a partial copy; cleared with {@link unconfirmed}. */
  private incompleteCopy = false
  /** One header object per distinct local `request/header` content held in this window. */
  private readonly sharedHeaders = new Map<string, JsonValue>()
  /**
   * Elided-step digests of the loaded window, by turn: the window's account of
   * what it does NOT hold. A turn drops out once {@link expandTurn} loads it.
   */
  private digests: StepDigestsByTurn = new Map()
  /**
   * Every digest this window has been told about, including turns already
   * expanded. A digest describes a whole step, so loading its events does not
   * change what it cost; the collapsed row keeps its figures after expansion.
   */
  private accounts: StepDigestsByTurn = new Map()
  private readonly expanding = new Map<number, Promise<void>>()
  /** Published keys of {@link expanding}; replaced only when membership changes, so selectors keep identity. */
  private expandingTurns: ReadonlySet<number> = new Set()
  /** Window pages, seq-ascending; rebuilt by window replacement and trimming, extended by live appends. */
  private windowPages: WindowPageData[] = []
  /** Entry event-text sizes; filled from local records on arrival and idle-time for the rest. */
  private readonly entrySizes = new WeakMap<SessionEventLikeEntry, number>()
  private measureQueue: SessionEventLikeEntry[] = []
  private measureScheduled = false
  /** The seq range the reader last reported through {@link markViewed}. */
  private viewportRange: { readonly from: number; readonly to: number } | undefined
  /**
   * The held window a suspended follow resumes from, captured at
   * {@link suspendFollow}; undefined while follow is live or never suspended.
   */
  private revival: { readonly last: number; readonly newest: SessionHistoryRecord } | undefined

  /**
   * Per-session projection value store (push model; see the session-projection
   * subsystem page, docs/subsystems/session-projection.md): finished whole
   * values computed on the Host, seeded by the tail page's
   * projections block and updated by Session Controller control frames;
   * Host-sequenced writes merge under higher-seq-wins and cached list blocks
   * yield to them (projection-store.ts). Keys are read via `projections.faceOf(key)`
   * (the useProjection resolution face); the conversation snapshot never
   * carries projection values, and no client-side domain folding exists.
   * Manager-owned when constructed through SessionManager (frames route and
   * the store outlives instantiation, the title-snapshot precedent); a bare
   * construction gets a private store.
   */
  readonly projections: ProjectionValueStore

  /** Contiguous history and live tail consumed by Conversation assembly. */
  readonly eventSource = new MutableSessionEventSource()
  private snapshotCache: SessionSnapshot
  private readonly notifier: Notifier
  /**
   * Agent-scoped cordis context, bound once by ClientSessions when it
   * mints the scope (the client mirror of the host Agent's loopCtx). The
   * Session dispatches its own scoped events through it; undefined means
   * unbound (bare object-layer construction) or already pruned — both skip
   * dispatch-dependent behavior rather than fail.
   */
  private actx: Context | undefined

  /**
   * @param sessionId - Host session identity (client sessions are always Host-born).
   * @param remote - generated Remote namespaces this session calls.
   * @param options - optional manager-owned state observers.
   */
  constructor(
    readonly sessionId: SessionId,
    private readonly remote: SessionRemotes,
    private readonly options: SessionOptions = {},
  ) {
    this.projections = options.projections ?? new ProjectionValueStore()
    this.stepDetail = options.stepDetail ?? 'full'
    this.address = options.address
    this.parentAvailable = options.parentAvailable
    this.notifier = new Notifier(() => {
      this.snapshotCache = this.buildSnapshot()
    })
    this.snapshotCache = this.buildSnapshot()
    this.stopObservingInbox = this.projections.faceOf('inbox').subscribe(() => {
      this.observeSubmissionInbox()
    })
  }

  /**
   * Bind the Agent-scoped context minted by ClientSessions (single write;
   * a second bind is a wiring error and throws). Direction stays one-way at
   * this binding boundary: consumers still reach the Session via `sessions.sessionOf`,
   * while the Session holds its own dispatch point (host Agent.loopCtx
   * mirror).
   * @param actx - the agent's scoped context.
   */
  bindScope(actx: Context): void {
    if (this.actx !== undefined) throw new Error(`session ${this.sessionId} already has a bound scope`)
    this.actx = actx
  }

  /** Release the bound scope at prune time (a later rebind accompanies a freshly minted scope). */
  unbindScope(): void {
    this.actx = undefined
  }

  // ---- Operations ----

  /**
   * Register one local submission echo (see the ISession declaration). The
   * echo reconciles against Host events from now on, but it enters the
   * snapshot only once the prompt receipt or an Inbox row carrying its
   * request id shows that the Host accepted it.
   * @param input - echo content and the optional settlement callback.
   * @returns the minted identity for {@link prompt} plus the pre-prompt abandon path.
   */
  beginSubmission(input: BeginSubmissionInput): SubmissionHandle {
    const requestId = randomUUID() as SessionRequestId
    const placement = this.running ? input.mode === 'steer' ? 'steering' : 'queued' : 'transcript'
    this.pendingSubmissions = [...this.pendingSubmissions, {
      requestId,
      placement,
      time: Date.now(),
      text: input.text,
      attachments: input.attachments,
    }]
    this.submissionSettlements.set(requestId, {
      placement, accepted: false, onAccept: input.onAccept, onRetire: input.onRetire, retiring: false,
    })
    return { requestId, abandon: () => { this.retireFailedSubmission(requestId) } }
  }

  /**
   * Send (queue/steer passed through 1:1); failures land in the snapshot's
   * promptError. The Host can hold the prompt at its admission stage, so the
   * call can stay open; the echo appears and the blank → engaging edge flips
   * only once the Host accepts the prompt.
   * @param content - text, browser-owned temporary image uploads, and staged-file receipts.
   * @param mode - queue appends after the current turn; steer interrupts it.
   * @param signal - optional caller cancellation for the complete admission round-trip.
   * @param requestId - identity from {@link beginSubmission}; a failed identified prompt retires its echo.
   * @returns the prompt result (also mirrored into promptError on failure).
   */
  async prompt(
    content: PromptContentPart[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    requestId?: SessionRequestId,
  ): Promise<RemoteResult<{ accepted: true }>> {
    this.promptError = null
    this.lastAgentError = null
    // Before the first await, so a turn observed ahead of the receipt clears it.
    const firstPrompt = this.blankBit && !this.firstPromptPendingTurn
    if (firstPrompt) this.firstPromptPendingTurn = true
    let result: RemoteResult<{ accepted: true }>
    if (this.address === undefined) {
      const clientTimeZone = resolvedClientTimeZone()
      result = await this.remote.session.prompt({
        requestId: requestId ?? randomUUID() as SessionRequestId,
        sessionId: this.sessionId,
        mode,
        content,
        clientTimeZone,
      }, signal)
    } else if (content.some(part => part.type === 'file')) {
      result = {
        ok: false,
        error: new RemoteError(
          'subagent/attachment-invalid',
          'subagent continuation does not accept files',
          { reason: 'SUBAGENT_FILE_UNSUPPORTED' },
        ),
      }
    } else {
      // The preceding branch rejects file parts before the narrower subagent
      // wire type is used; this array is not filtered or reordered.
      const routedContent = content as Exclude<PromptContentPart, { readonly type: 'file' }>[]
      const routed = await this.remote.subagents.prompt({
        requestId: requestId ?? randomUUID() as SessionRequestId,
        parentSessionId: this.address.parentSessionId,
        childSessionId: this.address.childSessionId,
        mode: 'continuable',
        delivery: mode,
        content: routedContent,
        clientTimeZone: resolvedClientTimeZone(),
      }, signal)
      result = routed.ok ? { ok: true, value: { accepted: true } } : routed
    }
    if (!result.ok) {
      // Rejection must leave a first prompt blank and eligible for workspace reuse.
      if (firstPrompt) this.firstPromptPendingTurn = false
      if (requestId !== undefined) this.retireFailedSubmission(requestId)
      this.promptError = { op: 'send', error: result.error }
      this.notifier.markDirty()
      return result
    }
    this.acceptPrompt(requestId)
    return result
  }

  /**
   * Apply the Host's acceptance of one prompt: publish its echo, move a blank
   * Session to engaging, and tell the submitter. The prompt receipt and an
   * Inbox row carrying the prompt's request id both prove acceptance.
   * Whichever arrives first publishes the echo; a later proof for an echo
   * still pending changes nothing.
   * @param requestId - identity from {@link beginSubmission}; absent for a prompt sent without an echo.
   */
  private acceptPrompt(requestId: SessionRequestId | undefined): void {
    const settlement = requestId === undefined ? undefined : this.submissionSettlements.get(requestId)
    if (settlement?.accepted === true) return
    if (settlement !== undefined) {
      settlement.accepted = true
      this.refreshAcceptedSubmissions()
    }
    this.promptAttempted = true
    this.blankBit = false
    this.notifier.markDirty()
    this.options.onEngaged?.(this)
    settlement?.onAccept?.()
  }

  /**
   * Resolve one stored image into browser-consumable bytes using this Session's gateway permission scope.
   * @param attachment - complete image reference from the folded session log.
   * @returns the supplied reference after storage verification, and decoded bytes.
   */
  async readAttachment(
    attachment: ImageAttachmentRef,
  ): Promise<RemoteResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>> {
    const result = await this.remote.session.attachment({
      sessionId: this.sessionId,
      attachment,
    })
    if (!result.ok) return result
    const binary = atob(result.value.data)
    const data = Uint8Array.from(binary, char => char.charCodeAt(0))
    return { ok: true, value: { attachment: result.value.attachment, data } }
  }

  /** Apply one operation to a still-pending queue occurrence. */
  async updateQueue(itemId: MessageId, action: QueueAction): Promise<RemoteResult<{ accepted: true }>> {
    return this.remote.session.updateQueue({ sessionId: this.sessionId, itemId, action })
  }

  /**
   * Stop the active turn while the Host preserves pending inbox work; failures
   * land in promptError (same error-strip display slot). A subagent address
   * routes through `subagents.interruptByParent`, whose durable parent-address
   * authority works without a live parent Agent.
   * @returns the cancel result.
   */
  async cancel(): Promise<RemoteResult<{ accepted: true }>> {
    const address = this.address
    const result = address !== undefined
      ? await this.remote.subagents.interruptByParent(
        address.childSessionId,
        address.parentSessionId,
        'continuable',
      )
      : await this.remote.session.cancel({ sessionId: this.sessionId })
    if (!result.ok) {
      this.promptError = { op: 'stop', error: result.error }
      this.notifier.markDirty()
    }
    return result
  }

  /**
   * Rename: contract session.rename 1:1. On success settle the 'title'
   * projection cell from the response's `{title, seq}` under the store's
   * higher-seq-wins rule (the push frame arriving later is a no-op replay),
   * so the list row and any useProjection('title') reader update without
   * waiting for the control-stream projection update.
   * @param title - raw title text (the host normalizes acceptance).
   * @returns the rename result (normalized accepted title + title event seq).
   */
  async rename(title: string): Promise<RemoteResult<{ title: string; seq: SessionSeq }>> {
    const result = await this.remote.session.rename({ sessionId: this.sessionId, title })
    if (!result.ok) return result
    const seq = SessionSeq(result.value.seq)
    this.projections.apply('title', result.value.title, seq)
    return { ok: true, value: { title: result.value.title, seq } }
  }

  /**
   * Execute one slash-command line against this session's agent — pure
   * admission semantics (the host executor durably logs the lifecycle;
   * outcomes render as flow nodes, never as a response echo).
   * @param line - the full command line, leading slash included.
   * @returns the admission result.
   */
  async command(line: string): Promise<RemoteResult<{ matched: boolean }>> {
    const result = await this.remote.commands.execute(this.sessionId, line, [])
    if (!result.ok) return result
    return { ok: true, value: { matched: result.value !== undefined } }
  }

  /** First open: pull the tail page (idempotent — in-flight/already-open returns the existing promise). */
  open(): Promise<void> {
    if (this.openState === 'open') return Promise.resolve()
    if (this.openPromise !== null) return this.openPromise
    const promise = this.doOpen(this.openGeneration).finally(() => {
      // Identity-guarded: a superseded open must not null out the promise resync just started.
      if (this.openPromise === promise) this.openPromise = null
    })
    this.openPromise = promise
    return promise
  }

  /** @inheritdoc */
  setStepDetail(detail: SessionStepDetail): Promise<void> {
    this.stepDetail = detail
    return this.completeHistoryIfRequired()
  }

  /** @inheritdoc */
  requireFullHistory(): Promise<void> {
    this.fullHistoryRequired = true
    return this.openState === 'error' ? this.open() : this.completeHistoryIfRequired()
  }

  /** @inheritdoc */
  expandTurn(turn: number): Promise<void> {
    const pending = this.expanding.get(turn)
    if (pending !== undefined) return pending
    if (this.openState !== 'open' || !this.digests.has(turn) || this.events === undefined) return Promise.resolve()
    const events = this.events
    const generation = this.windowGeneration
    const promise = this.expandTurnWindow(turn, events, generation).finally(() => {
      if (this.expanding.get(turn) === promise) {
        this.expanding.delete(turn)
        this.expandingTurns = new Set(this.expanding.keys())
      }
      this.notifier.markDirty()
    })
    this.expanding.set(turn, promise)
    this.expandingTurns = new Set(this.expanding.keys())
    this.notifier.markDirty()
    return promise
  }

  /**
   * Report the seq range the reader currently sees (see ISession). Pages the
   * range intersects are stamped as viewed, which keeps them out of memory
   * eviction, and the range becomes the Session's protected viewport.
   * @param fromSeq - first seq of the visible range.
   * @param toSeq - last seq of the visible range.
   */
  markViewed(fromSeq: SessionSeq, toSeq: SessionSeq): void {
    this.viewportRange = { from: fromSeq, to: toSeq }
    const viewedAt = Date.now()
    for (const page of this.windowPages) {
      if (page.viewedAt !== viewedAt && page.to >= fromSeq && page.from <= toSeq) page.viewedAt = viewedAt
    }
  }

  /**
   * Window pages with their last-view stamps, for the device memory budget.
   * @returns every window page as a copy, in order.
   */
  pages(): readonly SessionWindowPage[] {
    return this.windowPages.map(page => ({ ...page }))
  }

  /**
   * Seq range the reader last reported viewing.
   * @returns the last reported viewport range, or undefined before any report.
   */
  viewedRange(): { readonly from: number; readonly to: number } | undefined {
    return this.viewportRange
  }

  /**
   * Sum of event-text bytes the window holds, from local record sizes and
   * idle-time measurements; unmeasured entries contribute zero until measured.
   * @returns the measured total.
   */
  bytes(): number {
    const stale: WindowPageData[] = []
    let cached = 0
    for (const page of this.windowPages) {
      if (page.bytes === null) stale.push(page)
      else cached += page.bytes
    }
    const sums = stale.length === 0 ? [] : this.measureFromEntries(stale)
    let measured = 0
    for (const [index, page] of stale.entries()) {
      const sum = sums[index] ?? 0
      measured += sum
      // A page consumes a cache only once every queued entry measurement has
      // landed, so an early read cannot freeze a partial sum.
      if (this.measureQueue.length === 0) page.bytes = sum
    }
    return cached + measured
  }

  /**
   * Drop the oldest pages, moving the window's head forward. Reads become
   * locally reloadable (`hasMore` turns true) and the next {@link loadOlder}
   * pages back from the new head; digests whose whole step is gone are
   * dropped with them. A running older-history load, step expansion or
   * full-history reload blocks trimming: each would write records from below
   * the new head back into the window.
   * @param pageCount - number of oldest pages to drop.
   * @returns whether any page was dropped.
   */
  trimHead(pageCount: number): boolean {
    if (pageCount <= 0 || this.openState !== 'open') return false
    if (this.loadingOlder || this.expanding.size > 0 || this.detailLoad !== undefined) return false
    const removed = this.windowPages.slice(0, pageCount)
    const last = removed.at(-1)
    if (last === undefined) return false
    const kept = this.windowPages.slice(pageCount)
    const nextBase = kept[0] === undefined ? SessionLogOffset(last.to + 1) : SessionLogOffset(kept[0].from)
    this.windowPages = kept
    this.events?.dropBefore(nextBase)
    this.digests = dropDigestsBefore(this.digests, nextBase)
    this.accounts = dropDigestsBefore(this.accounts, nextBase)
    const entries = this.eventSource.getSnapshot().entries.filter(entry =>
      entry.type !== 'event' || entryCoveredLastSeq(entry) >= nextBase,
    )
    this.baseSeq = nextBase
    this.hasMore = true
    this.clearMeasureQueue()
    this.eventSource.replace(entries, true)
    this.notifier.markDirty()
    return true
  }

  // ---- Page accounting ----

  /**
   * Sum every stale page's entries' known sizes, one window pass.
   * @param stale - pages whose cached bytes are unknown, seq-ascending.
   * @returns each page's sum, in the given order.
   */
  private measureFromEntries(stale: readonly WindowPageData[]): number[] {
    const entries = this.eventSource.getSnapshot().entries
    const sums: number[] = Array.from({ length: stale.length }, () => 0)
    let next = 0
    for (const entry of entries) {
      const seq = Math.floor(entry.event.seq)
      while (next < stale.length - 1 && (stale[next]?.to ?? seq) < seq) next += 1
      const index = Math.min(next, stale.length - 1)
      const page = stale[index]
      if (page === undefined || seq < page.from) continue
      sums[index] = (sums[index] ?? 0) + (this.entrySizes.get(entry) ?? 0)
    }
    return sums
  }

  /**
   * Fill entry sizes for the entries that enter the window: local records'
   * stored sizes immediately, every other entry measured at idle time.
   * @param entries - durable or transient entries about to be published.
   */
  private admitEntries(entries: readonly SessionEventLikeEntry[]): void {
    for (const entry of entries) this.admitEntry(entry)
  }

  private admitEntry(entry: SessionEventLikeEntry): void {
    if (this.entrySizes.has(entry)) return
    const bytes = localBytesOf(entry)
    if (bytes !== undefined) {
      this.entrySizes.set(entry, bytes)
      return
    }
    this.measureQueue.push(entry)
    this.scheduleMeasure()
  }

  private scheduleMeasure(): void {
    if (this.measureScheduled) return
    this.measureScheduled = true
    scheduleIdle(() => {
      this.measureScheduled = false
      const startedAt = Date.now()
      while (this.measureQueue.length > 0 && Date.now() - startedAt < MEASURE_SLICE_MS) {
        const entry = this.measureQueue.shift()
        if (entry === undefined || this.entrySizes.has(entry)) continue
        this.entrySizes.set(entry, JSON.stringify(entry.event).length)
      }
      if (this.measureQueue.length > 0) this.scheduleMeasure()
    })
  }

  private clearMeasureQueue(): void {
    this.measureQueue = []
    this.measureScheduled = false
  }

  /** Invalidate byte caches of pages the spliced-in or replaced entries changed. */
  private invalidateEntryBytes(entries: readonly SessionEventLikeEntry[]): void {
    const first = entries[0]
    const last = entries.at(-1)
    if (first === undefined || last === undefined) return
    const from = Math.floor(first.event.seq)
    const to = Math.floor(last.event.seq)
    for (const page of this.windowPages) {
      if (page.to >= from && page.from <= to) page.bytes = null
    }
  }

  /** Invalidate the newest page's byte cache; every live fold change happens there. */
  private invalidateTailPage(): void {
    const last = this.windowPages.at(-1)
    if (last !== undefined) last.bytes = null
  }

  /** Drop all memory accounting; the next publication rebuilds pages without history. */
  private resetMemoryTracking(): void {
    this.windowPages = []
    this.viewportRange = undefined
    this.revival = undefined
    this.clearMeasureQueue()
  }

  /** Grow the newest page to cover one appended durable event. */
  private extendTailPage(seq: number): void {
    const last = this.windowPages.at(-1)
    if (last === undefined) {
      if (this.eventSource.getSnapshot().entries.length === 0) return
      this.windowPages = [{ from: this.baseSeq, to: seq, viewedAt: null, loadedAt: null, bytes: null }]
      return
    }
    if (seq > last.to) last.to = seq
    last.bytes = null
  }

  /** Replace the page list with one page covering `from` through the window's covered tail. */
  private resetPages(from: number, entries: readonly SessionEventLikeEntry[]): void {
    const page = freshPage(from, entries, null)
    this.windowPages = page === undefined ? [] : [page]
  }

  private async expandTurnWindow(turn: number, events: SessionEventStream, generation: number): Promise<void> {
    while (this.events === events && generation === this.windowGeneration) {
      const requested = this.digests.get(turn)
      if (requested === undefined) return
      const window = this.eventSource.getSnapshot().entries
      let records: readonly SessionHistoryRecord[]
      try {
        records = await events.expandSteps(turn, this.baseSeq)
      } catch (error) {
        if (!isRemoteFailure(error)) console.error('[session-controller] expandTurn failed:', error)
        return
      }
      if (this.events !== events || generation !== this.windowGeneration) return
      this.restoreStepHistory(records, window, new Map([[turn, requested]]))
    }
  }

  private effectiveStepDetail(): SessionStepDetail {
    return this.fullHistoryRequired ? 'full' : this.stepDetail
  }

  private completeHistoryIfRequired(): Promise<void> {
    const source = this.events
    if (source !== undefined && this.detailLoad?.source === source) return this.detailLoad.promise
    if (this.effectiveStepDetail() !== 'full' || this.openState !== 'open'
      || source === undefined || (this.digests.size === 0 && !this.fullHistoryStripped())) return Promise.resolve()
    this.stepDetailError = null
    const promise = this.completeHistoryWindow(source).finally(() => {
      if (this.detailLoad?.promise !== promise) return
      this.detailLoad = undefined
      this.notifier.markDirty()
      // A pending older page may publish between the read loop and its settlement.
      if (this.stepDetailError === null) void this.completeHistoryIfRequired()
    })
    this.detailLoad = { source, promise }
    this.notifier.markDirty()
    return promise
  }

  /** Whether the window holds an entry whose recorded stream was cut to its first-token prefix. */
  private holdsStrippedEntry(): boolean {
    return this.eventSource.getSnapshot().entries.some(
      entry => entry.type === 'event' && entry.stripped === true,
    )
  }

  /**
   * Read the window's whole range from the local copy when it covers it.
   * @param events - the stream whose published cursor bounds the read.
   * @returns the local records, or `undefined` when the copy does not cover the range.
   */
  private async localFullRange(events: SessionEventStream): Promise<readonly LocalHistoryRecord[] | undefined> {
    const source = this.options.historySource
    if (source === undefined) return undefined
    try {
      return await source.interval(this.sessionId, {
        fromSeq: this.baseSeq,
        throughSeq: events.cursor(),
        full: true,
      })
    } catch (error) {
      console.error('[session-controller] local full history failed:', error)
      return undefined
    }
  }

  /** Whether full history is required and the window still holds a cut recorded stream. */
  private fullHistoryStripped(): boolean {
    return this.fullHistoryRequired && this.holdsStrippedEntry()
  }

  private async completeHistoryWindow(events: SessionEventStream): Promise<void> {
    while (this.events === events && this.openState === 'open'
      && this.effectiveStepDetail() === 'full'
      && (this.digests.size > 0 || this.fullHistoryStripped())) {
      const generation = this.windowGeneration
      const requested = this.digests
      const window = this.eventSource.getSnapshot().entries
      const local = await this.localFullRange(events)
      if (this.events !== events || generation !== this.windowGeneration) continue
      if (local !== undefined) {
        this.replaceWindowRecords(local)
        continue
      }
      // The Host path splices interiors; it cannot rebuild an entry whose
      // recorded stream was cut, so a window that only holds those waits for
      // the next trigger instead of looping.
      if (this.digests.size === 0) return
      let records: readonly SessionHistoryRecord[]
      try {
        records = await events.readFullRange(this.baseSeq)
      } catch (error) {
        if (this.events !== events || generation !== this.windowGeneration) continue
        if (!isRemoteFailure(error)) console.error('[session-controller] full history failed:', error)
        this.stepDetailError = isRemoteFailure(error)
          ? error
          : new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {})
        return
      }
      if (this.events !== events || generation !== this.windowGeneration) continue
      this.restoreStepHistory(records, window, requested)
    }
  }

  /**
   * Replace the window with the full-detail records the local copy re-read for
   * it. The window's bounds and accounts are kept; elided turns and cut
   * recorded streams are gone, and reads stay full for this Session's lifetime.
   */
  private replaceWindowRecords(records: readonly LocalHistoryRecord[]): void {
    this.windowGeneration++
    this.expanding.clear()
    if (this.expandingTurns.size > 0) this.expandingTurns = new Set()
    const visible = this.assistantStream.replace(historyEntries(shareLocalHeaders(records, this.sharedHeaders)))
    this.admitEntries(visible)
    this.digests = new Map()
    this.resetPages(this.baseSeq, visible)
    this.eventSource.replace(visible, this.hasMore)
    this.notifier.markDirty()
  }

  private restoreStepHistory(
    records: readonly SessionHistoryRecord[],
    window: readonly SessionEventLikeEntry[],
    requested: StepDigestsByTurn,
  ): void {
    const digests = new Map(this.digests)
    for (const [turn, captured] of requested) {
      // A concurrently prepended page may add omissions to this same turn.
      if (digests.get(turn) === captured) digests.delete(turn)
    }
    this.digests = digests
    const interiors = historyInteriorEntries(records, window)
    this.admitEntries(interiors)
    this.invalidateEntryBytes(interiors)
    this.eventSource.splice(interiors)
    this.notifier.markDirty()
  }

  /** Prepend one Turn-aligned page: at least 50 messages and two Turn starts, capped at 500 messages. */
  async loadOlder(): Promise<void> {
    if (this.openState !== 'open' || !this.hasMore || this.loadingOlder) return
    const events = this.events
    if (events === undefined) return
    this.loadingOlder = true
    this.notifier.markDirty()
    try {
      await events.prepend(this.pageRequest(this.baseSeq, HISTORY_PAGE_OPTIONS))
    } catch (error) {
      if (!isRemoteFailure(error)) {
        console.error('[session-controller] loadOlder failed:', error)
      }
    } finally {
      this.loadingOlder = false
      this.notifier.markDirty()
    }
  }

  /** Jump loader: page backwards until the window covers seq (see ISession.loadThrough). */
  loadThrough(seq: SessionSeq): Promise<void> {
    if (this.openState !== 'open' || !this.hasMore || this.baseSeq <= seq) return Promise.resolve()
    if (this.jumpPromise !== null) {
      // Retarget the running loop to the lowest requested seq.
      this.jumpTargetSeq = SessionSeq(Math.min(this.jumpTargetSeq ?? seq, seq))
      return this.jumpPromise
    }
    // A plain single-page pull owns the busy flag; the jump does not queue
    // behind it (the caller retries once it settles) and must leave no
    // target behind — only the loop's finally clears that field, and no
    // loop starts here.
    if (this.loadingOlder) return Promise.resolve()
    const events = this.events
    if (events === undefined) return Promise.resolve()
    const pending: PendingHistory = {
      beforeSeq: this.baseSeq,
      hasMore: this.hasMore,
      pages: [],
    }
    this.pendingHistory = pending
    this.jumpTargetSeq = seq
    this.loadingOlder = true
    this.notifier.markDirty()
    // Stale-pass guard (the doOpen pattern): a resync mid-loop replaces the
    // stream generation; this pass then stops instead of paging the new
    // generation toward its old target.
    const generation = this.openGeneration
    this.jumpPromise = (async () => {
      try {
        while (pending.hasMore && this.jumpTargetSeq !== null && pending.beforeSeq > this.jumpTargetSeq) {
          if (generation !== this.openGeneration) return
          const before = pending.beforeSeq
          await events.prepend(this.pageRequest(before, JUMP_PAGE_OPTIONS))
          // No-progress guard: an empty or dropped page that still claims more
          // history must end the loop, not spin it.
          if (pending.beforeSeq >= before) return
        }
      } catch (error) {
        if (!isRemoteFailure(error)) {
          console.error('[session-controller] loadThrough failed:', error)
        }
      } finally {
        this.jumpTargetSeq = null
        this.jumpPromise = null
        this.pendingHistory = null
        this.loadingOlder = false
        if (generation === this.openGeneration && pending.pages.length > 0) {
          const pages = pending.pages.reverse()
          this.prependWindow(
            pages.flatMap(page => page.entries),
            pending.hasMore,
            pending.beforeSeq,
            pages.flatMap(page => page.digests),
            pages.map(page => ({ entries: page.entries, coveredFrom: page.coveredFrom })),
          )
        }
        this.notifier.markDirty()
      }
    })()
    return this.jumpPromise
  }

  /** Rebuild an opened history source after address replacement.
   *  Invalidates any in-flight open first; projection state belongs to the independently
   *  reconnecting control stream and remains untouched. */
  async resync(): Promise<void> {
    if (this.openState === 'cold') return // never opened: no window to rebuild (doOpen flips to 'loading' synchronously, so cold implies no in-flight open)
    this.openGeneration++
    const events = this.events
    this.events = undefined
    await events?.dispose()
    this.openPromise = null
    this.openState = 'cold'
    this.openError = null
    this.baseSeq = SessionLogOffset(0)
    this.digests = new Map()
    this.accounts = new Map()
    this.resetMemoryTracking()
    this.notifier.markDirty()
    await this.open()
  }

  // ---- Subscription API (useSyncExternalStore direct wiring) ----

  /**
   * uSES subscription entry.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Cached Session snapshot (rebuilt lazily when dirty with no listeners).
   * @returns the cached reference (stable until the next flush).
   */
  getSnapshot(): SessionSnapshot {
    this.notifier.ensureFresh()
    return this.snapshotCache
  }

  // ---- Manager-only entry points (@internal; never called by the UI) ----

  /**
   * Running-bit relay from the host stream (list entry and snapshot stay consistent).
   * @param running - the new running state.
   */
  handleRunning(running: boolean): void {
    // Running converts display state without establishing durable turn history.
    if (running && this.blankBit) {
      this.blankBit = false
      this.notifier.markDirty()
    }
    if (running) this.firstPromptPendingTurn = false
    if (this.running === running) return
    this.running = running
    this.notifier.markDirty()
  }

  /**
   * Install or clear the catalog-discovered transport address. A changed
   * address rebuilds an already-open window through its new history route.
   * @param address - direct parent/child address, or undefined for ordinary transport.
   * @param parentAvailable - latest exact-parent availability hint, or undefined before a catalog read.
   */
  configureSubagent(address: SubagentAddress | undefined, parentAvailable?: boolean): void {
    const same = this.address?.parentSessionId === address?.parentSessionId
      && this.address?.childSessionId === address?.childSessionId
      && this.address?.mode === address?.mode
    this.address = address
    this.parentAvailable = parentAvailable
    if (!same && this.openState !== 'cold') void this.resync()
    else this.notifier.markDirty()
  }

  /**
   * Update only the parent availability hint from a catalog refresh.
   * @param available - whether the exact direct parent is live.
   */
  handleSubagentParentAvailable(available: boolean): void {
    if (this.parentAvailable === available) return
    this.parentAvailable = available
    this.notifier.markDirty()
  }

  /**
   * Apply the Manager's effective display blank, further reconciled with the
   * current `sessionListMetadata` projection. Local send attempts and current
   * running state prevent re-blanking; an earlier false summary alone does not.
   * The Manager retains acceptance and earlier running observations across
   * Session-object replacement.
   * @param blank - New Session display state after Manager reconciliation.
   */
  handleBlank(blank: boolean): void {
    blank = blank && this.projections.values().sessionListMetadata?.blank !== false
    if (blank === this.blankBit) return
    if (blank && (this.promptAttempted || this.running)) return
    this.blankBit = blank
    this.notifier.markDirty()
  }

  /** `api-session/removed` relay: flag the snapshot while retaining the resident instance. */
  handleRemoved(): void {
    this.removed = true
    this.notifier.markDirty()
  }

  /**
   * `api-session/error` relay: the outlet for live failures with no turn position.
   * @param message - the stringified error.
   */
  handleAgentError(message: string): void {
    this.lastAgentError = message
    this.notifier.markDirty()
  }

  /**
   * Stop the Session's live Remote source.
   * @returns when the Remote iterator has completed teardown.
   */
  async dispose(): Promise<void> {
    this.stopObservingInbox()
    // Unsettled echoes retire as failed so their owners can restore or
    // release browser resources; admitted echoes keep their observed outcome.
    for (const [requestId, settlement] of [...this.submissionSettlements]) {
      if (settlement.admitted !== undefined) this.scheduleObservedRetirement(requestId, settlement.admitted)
      else this.retireFailedSubmission(requestId)
    }
    this.openGeneration++
    const events = this.events
    this.events = undefined
    this.resetMemoryTracking()
    await events?.dispose()
  }

  // ---- Private ----

  /**
   * Build the addressed journal stream wired to this Session's publication
   * sinks; the guards bind the caller's open generation.
   * @param generation - openGeneration owning the stream's publications.
   * @returns the unstarted stream.
   */
  private buildEventStream(generation: number): SessionEventStream {
    // A subagent child is never copied, so it always opens from the Host.
    const historySource = this.address === undefined ? this.options.historySource : undefined
    const events = new SessionEventStream(this.remote, this.sessionAddress(), {
      stepDetail: () => this.effectiveStepDetail(),
      sessionId: this.sessionId,
      full: () => this.fullHistoryRequired,
      ...(historySource === undefined ? {} : { source: historySource, sharedHeaders: this.sharedHeaders }),
      publish: (change) => {
        if (generation !== this.openGeneration || this.events !== events) return
        this.acceptEventChange(change)
      },
      failed: (error) => {
        this.failEventStream(events, generation, error)
      },
    })
    return events
  }

  /** @param generation - openGeneration at launch; stale passes cannot publish after replacement. */
  private async doOpen(generation: number): Promise<void> {
    this.openState = 'loading'
    this.openError = null
    this.revival = undefined
    this.notifier.markDirty()
    const events = this.buildEventStream(generation)
    this.events = events
    try {
      const request = this.pageRequest(undefined, HISTORY_PAGE_OPTIONS)
      let local: { readonly page: LocalHistoryPage; readonly cursor: number } | undefined
      const historySource = this.address === undefined ? this.options.historySource : undefined
      if (historySource !== undefined) {
        historySource.opened(this.sessionId)
        try {
          const page = await historySource.opening(this.sessionId, { ...request, full: this.fullHistoryRequired })
          if (generation !== this.openGeneration || this.events !== events) return
          if (page !== undefined) local = { page, cursor: page.cursor }
        } catch (error) {
          console.error('[session-controller] local opening failed:', error)
        }
      }
      this.unconfirmed = local !== undefined
      this.incompleteCopy = local?.page.partial === true
      await events.open(request, local === undefined ? undefined : {
        page: {
          records: shareLocalHeaders(local.page.records, this.sharedHeaders),
          hasMore: local.page.hasMore,
          ...(local.page.digests === undefined ? {} : { digests: local.page.digests }),
        },
        cursor: local.cursor,
      })
      if (generation !== this.openGeneration || this.events !== events) return
      this.openState = 'open'
      await this.completeHistoryIfRequired()
    } catch (error) {
      if (generation !== this.openGeneration || this.events !== events) return
      if (!isRemoteFailure(error)) throw error
      this.events = undefined
      this.openState = 'error'
      this.openError = error
    } finally {
      if (generation === this.openGeneration) this.notifier.markDirty()
    }
  }

  /**
   * Release the remote follow while keeping the open window, so a warm Session
   * survives until its revival or disposal without live traffic.
   */
  async suspendFollow(): Promise<void> {
    const events = this.events
    if (events === undefined || this.openState !== 'open') return
    const last = events.cursor()
    const newest = this.newestHeldRecord()
    this.events = undefined
    this.revival = newest === undefined ? undefined : { last, newest }
    await events.dispose()
  }

  /**
   * Resume following a suspended warm Session from its held window: the first
   * remote opening continues after the newest held record, or replaces the
   * window when the Host cannot continue it. Older pages load from the
   * window's current head, which eviction may have moved during suspension.
   */
  reviveFollow(): void {
    if (this.events !== undefined || this.openState !== 'open') return
    const revival = this.revival
    if (revival === undefined) return
    const events = this.buildEventStream(this.openGeneration)
    this.events = events
    events.adopt(this.pageRequest(undefined, HISTORY_PAGE_OPTIONS), { ...revival, first: this.baseSeq })
  }

  /**
   * The held window's newest durable record with its Host chain link, the
   * resume identity a revival offers its reopening stream.
   */
  private newestHeldRecord(): SessionHistoryRecord | undefined {
    const entries = this.eventSource.getSnapshot().entries
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      if (entry === undefined || entry.type !== 'event') continue
      const link = entryLinkOf(entry)
      // The window entry is the record's stored form; the one-way structural
      // step covers the JSON-value envelope like historyEntries' cast mirrors.
      return {
        type: 'event',
        event: entry.event,
        ...(link === undefined ? {} : { link }),
      } as SessionHistoryRecord
    }
    return undefined
  }

  /** Apply one contiguous journal update already reconciled by the Remote stream. */
  private acceptEventChange(change: SessionJournalChange): void {
    const confirmed = change.type !== 'replace' || change.local !== true
    if (this.unconfirmed && change.type !== 'prepend' && confirmed) {
      this.unconfirmed = false
      this.incompleteCopy = false
      // A snapshot that replaces an unconfirmed local window means the copy's
      // log disagrees with the Host's; the copy repair is queued.
      if (change.type === 'replace') this.options.historySource?.diverged(this.sessionId)
    }
    switch (change.type) {
      case 'replace':
        this.installWindow(
          change.entries,
          change.hasMore,
          historyPageFirstSeq(change.page.records),
          change.page.projections === undefined ? undefined : projectionsBaseline(change.page.projections),
          change.page.assistantStream,
          change.page.digests,
        )
        return
      case 'prepend':
        this.prependWindow(change.entries, change.hasMore, historyPageFirstSeq(change.page.records), change.page.digests)
        return
      case 'resume':
        this.resumeWindow(
          change.entries,
          change.page.projections === undefined ? undefined : projectionsBaseline(change.page.projections),
          change.page.assistantStream,
        )
        return
      case 'append':
        this.publishAssistantEntry(this.assistantStream.acceptDurable(change.entry))
        return
      case 'assistant-stream':
        this.publishAssistantEntry(this.assistantStream.acceptFrame(change.frame))
    }
  }

  /**
   * Replace the complete contiguous window and apply page-owned projection metadata.
   * `coveredHead` is the first seq the page stands for, which precedes its first
   * event when a collapsed page withheld the events before it.
   */
  private installWindow(
    entries: readonly SessionEventLikeEntry[],
    hasMore: boolean,
    coveredHead: number | undefined,
    projections?: ProjectionsBaseline,
    assistantStream?: SessionAssistantStreamBaseline,
    digests?: readonly StepDigest[],
  ): void {
    // A durable gap-repair page has no assistant baseline. Clearing transient
    // attempts makes a held notification reopen follow once for an atomic
    // page/baseline pair instead of applying it to an unrelated repair cut.
    this.windowGeneration++
    this.expanding.clear()
    if (this.expandingTurns.size > 0) this.expandingTurns = new Set()
    this.stepDetailError = null
    const visible = this.assistantStream.replace(entries, assistantStream)
    this.admitEntries(visible)
    this.baseSeq = SessionLogOffset(coveredHead ?? entries[0]?.event.seq ?? 0)
    this.hasMore = hasMore
    this.resetPages(this.baseSeq, visible)
    if (this.pendingHistory !== null) {
      this.pendingHistory.beforeSeq = this.baseSeq
      this.pendingHistory.hasMore = hasMore
      this.pendingHistory.pages.length = 0
    }
    this.digests = groupDigests(digests)
    this.accounts = groupDigests(digests)
    if (visible.some(entry => entry.event.type === 'turn/start')) this.firstPromptPendingTurn = false
    if (projections !== undefined) this.projections.seed(projections)
    this.eventSource.replace(visible, hasMore)
    this.observeBaseline(visible, projections)
    this.notifier.markDirty()
    void this.completeHistoryIfRequired()
  }

  /**
   * Continue the held window with the events a resumed opening added after it.
   * The window keeps its head, older pages, collapsed-step digests and expanded
   * turns. When nothing needs rebuilding — no settlement is staged, the window
   * holds no transient row, and the opening carries no live attempt — the new
   * entries are appended one by one, so a resumed reconnect that adds nothing
   * re-renders nothing. Otherwise the window is rebuilt through the Assistant
   * stream fold from the opening's baseline.
   */
  private resumeWindow(
    entries: readonly SessionEventLikeEntry[],
    projections?: ProjectionsBaseline,
    assistantStream?: SessionAssistantStreamBaseline,
  ): void {
    const held = this.eventSource.getSnapshot().entries
    if (assistantStream?.activeAttempt === undefined
      && this.assistantStream.staged().length === 0
      && !held.some(entry => entry.type === 'transient')) {
      for (const [index, entry] of entries.entries()) {
        const result = this.assistantStream.acceptDurable(entry as SessionLiveEventEntry)
        if (result === undefined) {
          // The entry is a settlement staged for an attempt whose live frames
          // predate this opening; rebuild through the fold so it becomes visible.
          this.resumeWindowFromFold(entries.slice(index), projections, assistantStream)
          return
        }
        this.publishAssistantEntry(result)
      }
      if (entries.some(entry => entry.event.type === 'turn/start')) this.firstPromptPendingTurn = false
      if (projections !== undefined) this.projections.seed(projections)
      this.observeBaseline(entries, projections)
      this.notifier.markDirty()
      return
    }
    this.resumeWindowFromFold(entries, projections, assistantStream)
  }

  /** Rebuild the held window and its live Assistant rows from a resumed opening's baseline. */
  private resumeWindowFromFold(
    entries: readonly SessionEventLikeEntry[],
    projections?: ProjectionsBaseline,
    assistantStream?: SessionAssistantStreamBaseline,
  ): void {
    const staged = this.assistantStream.staged()
    const held = this.eventSource.getSnapshot().entries.filter(entry => entry.type === 'event')
    const durable = staged.length === 0
      ? held
      : [...held, ...staged].sort((left, right) => left.event.seq - right.event.seq)
    const visible = this.assistantStream.replace([...durable, ...entries], assistantStream)
    this.admitEntries(visible)
    this.resetPages(this.baseSeq, visible)
    if (entries.some(entry => entry.event.type === 'turn/start')) this.firstPromptPendingTurn = false
    if (projections !== undefined) this.projections.seed(projections)
    this.eventSource.replace(visible, this.hasMore)
    this.observeBaseline([...staged, ...entries], projections)
    this.notifier.markDirty()
  }

  /** Reconcile submission echoes with newly visible events and an opening's projections. */
  private observeBaseline(entries: readonly SessionEventLikeEntry[], projections?: ProjectionsBaseline): void {
    // A new follow baseline replaces confirmed optimistic inputs with Host-owned rows.
    // Receipt-backed inputs are accepted, not failed, even if their history is outside this window.
    if (projections !== undefined) {
      for (const [requestId, { receipt }] of this.submissionSettlements) {
        if (receipt !== undefined && receipt.seq <= projections.asOfSeq) {
          this.scheduleObservedRetirement(requestId, receipt.attachments)
        }
      }
    }
    for (const entry of entries) this.observeSubmissionEvent(entry.event)
    if (projections !== undefined) {
      const inbox = projections.values.inbox as InboxState | undefined
      for (const target of ['next-turn', 'next-step'] as const) {
        this.observeSubmissionInsertions(target, inbox?.[target] ?? [], 0, projections.asOfSeq)
      }
    }
  }

  private publishAssistantEntry(result: ClientAssistantStreamResult): void {
    if (result?.type === 'rebaseline') {
      const events = this.events
      queueMicrotask(() => {
        if (events !== undefined && this.events === events) events.restart()
      })
      return
    }
    if (result?.type === 'settlement') {
      this.admitEntry(result.entry)
      this.eventSource.settleAssistant(result.attemptId, result.entry)
      this.invalidateTailPage()
      this.observeSubmissionEvent(result.entry.event)
      this.notifier.markDirty()
      return
    }
    if (result?.type === 'abandonment') {
      this.eventSource.settleAssistant(result.attemptId)
      this.invalidateTailPage()
      this.notifier.markDirty()
      return
    }
    if (result?.type === 'publish') {
      const changed = this.appendLive(result.entry)
      if (result.retireAttemptId !== undefined) {
        this.eventSource.settleAssistant(result.retireAttemptId)
        this.invalidateTailPage()
      }
      if (changed || result.retireAttemptId !== undefined) this.notifier.markDirty()
    } else if (result?.type === 'transient') {
      this.admitEntry(result.entry)
      this.eventSource.append(result.entry)
      this.invalidateTailPage()
      this.notifier.markDirty()
    }
  }

  /** Prepend one stream-validated history page; `coveredHead` as for {@link installWindow}. */
  private prependWindow(
    entries: readonly SessionEventLikeEntry[],
    hasMore: boolean,
    coveredHead: number | undefined,
    digests?: readonly StepDigest[],
    segments?: readonly { readonly entries: readonly SessionEventLikeEntry[]; readonly coveredFrom: number }[],
  ): void {
    const head = entries.length === 0 ? undefined : coveredHead ?? entries[0]?.event.seq
    if (this.pendingHistory !== null) {
      const pending = this.pendingHistory
      pending.beforeSeq = head === undefined ? pending.beforeSeq : SessionLogOffset(head)
      pending.hasMore = hasMore
      pending.pages.push({ entries, digests: digests ?? [], coveredFrom: head ?? pending.beforeSeq })
      return
    }
    this.baseSeq = head === undefined ? this.baseSeq : SessionLogOffset(head)
    this.hasMore = hasMore
    this.admitEntries(entries)
    // A jump loop publishes one combined prepend; its queued segments keep the
    // page granularity each fetched page carries.
    const pageSegments = segments
      ?? (entries.length > 0 && head !== undefined ? [{ entries, coveredFrom: head }] : [])
    const fresh: WindowPageData[] = []
    const loadedAt = Date.now()
    for (const { entries: segmentEntries, coveredFrom: segmentHead } of pageSegments) {
      const page = freshPage(segmentHead, segmentEntries, loadedAt)
      if (page !== undefined) fresh.push(page)
    }
    if (fresh.length > 0) this.windowPages = [...fresh, ...this.windowPages]
    if (entries.length > 0 && digests !== undefined && digests.length > 0) {
      this.digests = mergeDigests(this.digests, digests)
      this.accounts = mergeDigests(this.accounts, digests)
    }
    this.eventSource.prepend(entries, hasMore)
    void this.completeHistoryIfRequired()
  }

  /**
   * One Turn-aligned page request carrying the current step detail. A
   * collapsed page raises the window's message minimum to
   * {@link COLLAPSED_PAGE_MESSAGES}, within the same cap.
   */
  private pageRequest(
    beforeSeq: number | undefined,
    window: typeof HISTORY_PAGE_OPTIONS,
  ): ClientSessionPageRequest {
    const stepDetail = this.effectiveStepDetail()
    const minMessages = stepDetail === 'collapsed'
      ? Math.min(window.maxMessages, Math.max(window.turnWindow.minMessages, COLLAPSED_PAGE_MESSAGES))
      : window.turnWindow.minMessages
    return {
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages: window.maxMessages,
      turnWindow: { ...window.turnWindow, minMessages },
      stepDetail,
    }
  }

  /** Append one stream-validated live event. */
  private appendLive(entry: SessionLiveEventEntry): boolean {
    const event = entry.event
    const awaitingFirstTurn = this.firstPromptPendingTurn
    if (event.type === 'turn/start') this.firstPromptPendingTurn = false
    this.admitEntry(entry)
    this.extendTailPage(event.seq)
    this.eventSource.append(entry)
    // After the feed append: the conversation assembly's animation frame is
    // registered by the feed subscribers above, so the echo-retirement frame
    // scheduled here always runs after the durable node became renderable.
    this.observeSubmissionEvent(event)
    return awaitingFirstTurn !== this.firstPromptPendingTurn
  }

  /** Observe durable acceptance even when insertion and claim share one projection notification. */
  private observeSubmissionEvent(event: SessionEventLike): void {
    if (this.submissionSettlements.size === 0) return
    if (event.type === 'agent/inbox/spliced') {
      const { target, start, removedCount = 0, inserted, outcome } = event.data
      for (const [requestId, settlement] of this.submissionSettlements) {
        const receipt = settlement.receipt
        if (receipt?.target !== target || receipt.index === null || receipt.seq >= event.seq) continue
        const removed = receipt.index >= start && receipt.index < start + removedCount
        if (removed && outcome === 'canceled') this.retireFailedSubmission(requestId)
        else settlement.receipt = {
          ...receipt,
          seq: event.seq,
          index: removed ? null : receipt.index < start ? receipt.index : receipt.index + inserted.length - removedCount,
        }
      }
      this.observeSubmissionInsertions(target, inserted, start, event.seq)
      // A queued echo waits for the inbox projection the queue dock renders, which can arrive after this
      // event; retiring it here would empty the dock for a frame. A claim in the same projection notification
      // still retires it through the durable user message.
      for (const message of inserted) this.observeSubmissionMessage(message, false, false)
      return
    }
    if (event.type === 'request/context' || event.type === 'turn/end') {
      for (const [requestId, settlement] of this.submissionSettlements) {
        if (settlement.admitted === undefined && settlement.receipt?.index === null
          && settlement.receipt.seq < event.seq) this.retireFailedSubmission(requestId)
      }
      return
    }
    if (event.type === 'user/message') this.observeSubmissionMessage(event.data, true)
  }

  private observeSubmissionInsertions(target: InboxTarget, messages: readonly UserMessage[], start: number, seq: number): void {
    for (const [index, message] of messages.entries()) {
      const source = message.source
      if (source.kind !== 'user' || !('rpcId' in source)) continue
      const settlement = this.submissionSettlements.get(source.rpcId)
      if (settlement === undefined || settlement.retiring || (settlement.receipt?.seq ?? -1) > seq) continue
      // Either proof accepts a prompt; an Inbox row can reach the Client before the prompt receipt. Later splices
      // move the recorded position, so a canceled splice that removes the row retires its echo, queued ones
      // included; a queued echo otherwise leaves once the queue dock renders its row or its message is admitted.
      settlement.receipt = { target, seq, index: start + index, attachments: attachmentRefsIn(message.content) }
      this.acceptPrompt(source.rpcId)
    }
  }

  private observeSubmissionMessage(message: UserMessage, admitted: boolean, retireQueued = true): void {
    const source = message.source
    if (source.kind !== 'user' || !('rpcId' in source)) return
    const settlement = this.submissionSettlements.get(source.rpcId)
    if (settlement === undefined || settlement.retiring) return
    if (!admitted) {
      if (settlement.placement === 'queued' && retireQueued) {
        this.scheduleObservedRetirement(source.rpcId, attachmentRefsIn(message.content))
      }
      return
    }
    settlement.admitted = attachmentRefsIn(message.content)
    this.retireAdmittedSubmission(source.rpcId)
  }

  /** Retire admitted Chat identities only after stale Inbox rows can no longer reappear. */
  private retireAdmittedSubmission(requestId: SessionRequestId): void {
    const settlement = this.submissionSettlements.get(requestId)
    if (settlement?.admitted === undefined) return
    const receipt = settlement.receipt
    if (receipt?.index === null
      && (this.projections.seqOf('inbox') ?? -1) < receipt.seq) return
    this.scheduleObservedRetirement(requestId, settlement.admitted)
  }

  /** Inbox acceptance retires queued echoes; its watermark completes admitted Chat handoffs. */
  private observeSubmissionInbox(): void {
    if (this.submissionSettlements.size === 0) return
    const inbox = this.projections.get('inbox') as InboxState | undefined
    if (inbox === undefined) return
    const seq = this.projections.seqOf('inbox')
    for (const target of ['next-turn', 'next-step'] as const) {
      if (seq !== undefined) this.observeSubmissionInsertions(target, inbox[target], 0, seq)
      for (const message of inbox[target]) this.observeSubmissionMessage(message, false)
    }
    for (const requestId of this.submissionSettlements.keys()) this.retireAdmittedSubmission(requestId)
  }

  /**
   * Latch one observed settlement and remove the echo an animation frame
   * later. The delay keeps the echo in the snapshot until the frame in which
   * the durable node (whose assembly frame was registered first) is
   * renderable; the render-time rpcId dedupe hides the one-frame overlap.
   */
  private scheduleObservedRetirement(
    requestId: SessionRequestId,
    attachments: readonly (ImageAttachmentRef | FileAttachmentRef)[],
  ): void {
    const settlement = this.submissionSettlements.get(requestId)
    if (settlement === undefined || settlement.retiring) return
    settlement.retiring = true
    scheduleFrame(() => { this.finishSubmission(requestId, { reason: 'observed', attachments }) })
  }

  /** Remove one unsettled echo immediately (prompt rejection, abort, or disposal). */
  private retireFailedSubmission(requestId: SessionRequestId): void {
    const settlement = this.submissionSettlements.get(requestId)
    if (settlement === undefined || settlement.retiring || settlement.admitted !== undefined) return
    settlement.retiring = true
    this.finishSubmission(requestId, { reason: 'failed' })
  }

  private refreshAcceptedSubmissions(): void {
    this.acceptedSubmissions = this.pendingSubmissions
      .filter(echo => this.submissionSettlements.get(echo.requestId)?.accepted === true)
  }

  /** Single removal point: drop the echo, publish, then notify the owner. */
  private finishSubmission(requestId: SessionRequestId, retirement: PendingSubmissionRetirement): void {
    const settlement = this.submissionSettlements.get(requestId)
    /* v8 ignore next -- retiring latches before every schedule, so one settlement never finishes twice. */
    if (settlement === undefined) return
    this.submissionSettlements.delete(requestId)
    this.pendingSubmissions = this.pendingSubmissions.filter(echo => echo.requestId !== requestId)
    if (settlement.accepted) this.refreshAcceptedSubmissions()
    this.notifier.markDirty()
    settlement.onRetire?.(retirement)
  }

  /** Publish a terminal background failure only while this stream still owns the Session. */
  private failEventStream(events: SessionEventStream, generation: number, error: unknown): void {
    if (generation !== this.openGeneration || this.events !== events) return
    if (!isRemoteFailure(error)) throw error
    this.openGeneration++
    this.events = undefined
    this.openPromise = null
    this.openState = 'error'
    this.openError = error
    void events.dispose()
    this.notifier.markDirty()
  }

  private buildSnapshot(): SessionSnapshot {
    const identity = this.projections.values().subagent
    return {
      sessionId: this.sessionId,
      pendingSubmissions: this.acceptedSubmissions,
      running: this.running,
      subagent: this.address === undefined
        ? null
        : {
          address: this.address.mode === 'unknown' && identity != null
            ? { ...this.address, mode: identity.mode }
            : this.address,
          ...(this.parentAvailable === undefined ? {} : { parentAvailable: this.parentAvailable }),
        },
      removed: this.removed,
      openState: this.openState,
      unconfirmed: this.unconfirmed,
      incompleteCopy: this.incompleteCopy,
      openError: this.openError,
      hasMore: this.hasMore,
      loadingOlder: this.loadingOlder,
      stepDigests: this.digests,
      stepAccounts: this.accounts,
      expandingTurns: this.expandingTurns,
      loadingStepDetail: this.events !== undefined && this.detailLoad?.source === this.events,
      stepDetailError: this.stepDetailError,
      promptError: this.promptError,
      blank: this.blankBit,
      lastAgentError: this.lastAgentError,
      promptAttempted: this.promptAttempted,
      // The flag is set before the receipt; the Session leaves blank only once the Host accepted the prompt.
      awaitingFirstTurn: this.firstPromptPendingTurn && !this.blankBit,
    }
  }

  private sessionAddress(): SessionAddress {
    return this.address === undefined
      ? { kind: 'session', sessionId: this.sessionId }
      : { kind: 'subagent', ...this.address }
  }
}

/**
 * Index one page's elided-step digests by the turn that owns them.
 * @param digests - digests as served, ascending by startSeq.
 * @returns per-turn digests, preserving that order.
 */
function groupDigests(digests: readonly StepDigest[] = []): StepDigestsByTurn {
  const byTurn = new Map<number, StepDigest[]>()
  for (const digest of digests) {
    const held = byTurn.get(digest.turn)
    if (held === undefined) byTurn.set(digest.turn, [digest])
    else held.push(digest)
  }
  return byTurn
}

/** Merge an older page's digests ahead of the ones already held for each turn. */
function mergeDigests(held: StepDigestsByTurn, added: readonly StepDigest[]): StepDigestsByTurn {
  const merged = new Map(held)
  for (const [turn, digests] of groupDigests(added)) {
    const byStep = new Map((merged.get(turn) ?? []).map(digest => [digest.step, digest]))
    for (const digest of digests) {
      const existing = byStep.get(digest.step)
      byStep.set(digest.step, existing === undefined ? digest : {
        ...digest,
        elided: existing.elided + digest.elided,
      })
    }
    merged.set(turn, [...byStep.values()].sort((left, right) => left.startSeq - right.startSeq))
  }
  return merged
}

/** Remove per-turn digests whose whole elided step lies below `base`, keeping the rest. */
function dropDigestsBefore(held: StepDigestsByTurn, base: number): StepDigestsByTurn {
  let changed = false
  const kept = new Map<number, StepDigest[]>()
  for (const [turn, digests] of held) {
    const remaining = digests.filter(digest => (digest.endSeq ?? digest.startSeq) >= base)
    if (remaining.length !== digests.length) changed = true
    if (remaining.length > 0) kept.set(turn, remaining)
    else changed = true
  }
  return changed ? kept : held
}

/**
 * Event-text bytes a record carries from the local copy, when it arrived with
 * its recorded size.
 * @param entry - a history or live entry.
 * @returns the record's byte size, or undefined when the size is Host-side.
 */
function localBytesOf(entry: SessionEventLikeEntry): number | undefined {
  if (entry.type !== 'event' || !('bytes' in entry)) return undefined
  const bytes = entry.bytes
  return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined
}

/** First inclusive seq an entry occupies; transient rows round into their durable page. */
function eventFirstSeq(entry: SessionEventLikeEntry): number {
  return Math.floor(entry.event.seq)
}

/** Last inclusive seq an entry's event or coverage stands for. */
function entryCoveredLastSeq(entry: SessionEventLikeEntry): number {
  if (entry.type !== 'event') return eventFirstSeq(entry)
  return entry.covers?.to ?? entry.event.seq
}

/**
 * Build one page covering `from` through the entries' covered tail.
 * @param from - first covered seq, including events a collapsed record stands for.
 * @param entries - the entries the page holds, ascending.
 * @param loadedAt - wall time an older-history load added the page, or null.
 * @returns the page, or undefined when the entries hold no durable event.
 */
function freshPage(
  from: number,
  entries: readonly SessionEventLikeEntry[],
  loadedAt: number | null,
): WindowPageData | undefined {
  let last: SessionEventLikeEntry | undefined
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry !== undefined && entry.type === 'event') {
      last = entry
      break
    }
  }
  if (last === undefined) return undefined
  return { from, to: entryCoveredLastSeq(last), viewedAt: null, loadedAt, bytes: null }
}

/**
 * The chain link an entry arrived with, which carries only at runtime.
 * @param entry - a history entry.
 * @returns the Host's link for the entry's covered tail, or undefined without one.
 */
function entryLinkOf(entry: SessionEventLikeEntry): SessionChainLink | undefined {
  if (entry.type !== 'event' || !('link' in entry)) return undefined
  const link = entry.link
  return typeof link === 'string' && /^[0-9a-f]{64}$/.test(link) ? brandString<SessionChainLink>(link) : undefined
}

/** Run one callback on the next animation frame, or a macrotask where no frame clock exists. */
function scheduleFrame(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { fn() })
  else setTimeout(fn, 0)
}

/** Attachment references in one structurally-read content block list, in block order. */
function attachmentRefsIn(content: unknown): readonly (ImageAttachmentRef | FileAttachmentRef)[] {
  if (!Array.isArray(content)) return []
  const refs: Array<ImageAttachmentRef | FileAttachmentRef> = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { readonly type?: unknown; readonly attachment?: unknown }
    if ((candidate.type === 'image' || candidate.type === 'file')
      && typeof candidate.attachment === 'object' && candidate.attachment !== null) {
      refs.push(candidate.attachment as ImageAttachmentRef | FileAttachmentRef)
    }
  }
  return refs
}

/** Session-specific adapters for Gateway-owned Remote stream lifecycles. */

import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  RemoteJournalStream,
  RemoteSnapshotStream,
  RemoteStreamCarrierError,
  type ClientRemote,
  type RemoteJournalChange,
  type RemoteJournalFrame,
  type RemoteJournalResumePoint,
} from '@deepseek-ai/dsh-api-gateway/client'
import type {
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
  SessionChainLink,
  SessionControlFrame,
  SessionControlKnown,
  SessionFollowResume,
  SessionHistoryRecord,
  SessionLineEntry,
  SessionPage,
  SessionPageRequest,
  SessionProjectionBaseline,
  SessionStepDetail,
} from '../types.ts'
import {
  historyEntries,
  historyRecordFirstSeq,
  historyRecordLastSeq,
  shareLocalHeaders,
} from './sessions/history-records.ts'
import type {
  LocalHistoryPage, SessionHistorySource,
} from './contract/history-source.ts'
import type { SessionEventLikeEntry, SessionLiveEventEntry } from './contract/events.ts'
import type { SessionRemotes } from './sessions/remotes.ts'
import { assertSessionWireEvent, decodeStoredLine } from '../history-shared/wire-event.ts'

export {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from '../types.ts'

/** Pagination fields bound to an already-addressed Session journal. */
export type ClientSessionPageRequest = Omit<SessionPageRequest, 'address' | 'throughSeq' | 'fromSeq'>

/** Complete generated `ctx.remote.session` namespace. */
export type SessionRemote = ClientRemote['session']

/** Opening metadata carried only by a follow snapshot, never by loadOlder pages; digests ride both. */
interface SessionJournalPage extends SessionPage {
  readonly projections?: SessionProjectionBaseline
  readonly assistantStream?: SessionAssistantStreamBaseline
}

/** One complete publication from the Session journal stream. */
export type SessionJournalChange =
  | {
    readonly type: 'replace' | 'prepend'
    readonly page: SessionJournalPage
    readonly entries: readonly SessionEventLikeEntry[]
    readonly hasMore: boolean
    /** The page came from the local copy; no remote opening has confirmed it yet. */
    readonly local?: true
  }
  | {
    /** A reconnect continued the held window: `entries` are every full-detail event after it. */
    readonly type: 'resume'
    readonly page: SessionJournalPage
    readonly entries: readonly SessionEventLikeEntry[]
  }
  | { readonly type: 'append'; readonly entry: SessionLiveEventEntry }
  | { readonly type: 'assistant-stream'; readonly frame: SessionAssistantStreamFrame }

function toSessionJournalChange(
  change: RemoteJournalChange<
    SessionJournalPage, SessionHistoryRecord, SessionAssistantStreamFrame
  >,
): SessionJournalChange {
  switch (change.type) {
    case 'replace':
    case 'prepend':
    case 'resume':
      return { ...change, entries: historyEntries(change.entries) }
    case 'append': {
      return {
        type: 'append',
        entry: change.entry as unknown as SessionLiveEventEntry,
      }
    }
    case 'notification':
      return { type: 'assistant-stream', frame: change.notification }
  }
}

/**
 * Describe a held window by the chain link of its newest record. A record
 * without a link cannot name the window, so that generation opens with a
 * snapshot.
 * @param held - the journal's resume point, when the window holds a record.
 * @returns the follow request's resume point, or `undefined` to request a snapshot.
 */
function resumePoint(
  held: RemoteJournalResumePoint<SessionHistoryRecord, number> | undefined,
): SessionFollowResume | undefined {
  const newest = held?.entries.at(-1)
  const link = newest?.link
  if (held === undefined || link === undefined) return undefined
  return { afterSeq: held.after, link }
}

/**
 * The held window a snapshot opening already ends at. Equal links at the same
 * seq identify byte-identical log prefixes, so the window holds every event the
 * snapshot carries, and the snapshot's baselines are as of that same cursor.
 * @param records - records of the snapshot opening.
 * @param cursor - the snapshot's cursor.
 * @param resume - the resume point this generation offered.
 * @returns the resume point the opening ends at, or `undefined` when it opens a new window.
 */
function continuation(
  records: readonly SessionHistoryRecord[],
  cursor: number,
  resume: SessionFollowResume | undefined,
): SessionFollowResume | undefined {
  const newest = records.at(-1)
  if (resume === undefined || cursor !== resume.afterSeq || newest === undefined) return undefined
  return historyRecordLastSeq(newest) === resume.afterSeq && newest.link === resume.link ? resume : undefined
}

/**
 * Decode one stored-line entry into the event record the journal holds.
 * @param entry - a line entry the Host sent for one followed event.
 * @returns the decoded event record with the Host's link and whole-turn accounting.
 */
function lineEntryRecord(entry: SessionLineEntry): SessionHistoryRecord {
  return {
    type: 'event',
    event: decodeStoredLine(entry.line, entry.seq),
    link: entry.link,
    ...(entry.turnUsage === undefined ? {} : { turnUsage: entry.turnUsage }),
  }
}

/** @returns the failure for a full-detail interval that is not complete and uncollapsed. */
function incompleteFullInterval(fromSeq: number, throughSeq: number): RemoteError<'gateway/internal'> {
  return new RemoteError('gateway/internal', 'session full-detail interval is incomplete', { fromSeq, throughSeq })
}

/**
 * Assert a full-detail interval is complete: one uncropped record per seq.
 * @param records - the records an interval read returned.
 * @param fromSeq - inclusive head of the requested interval.
 * @param throughSeq - inclusive tail of the requested interval.
 * @throws when records are missing, duplicated, out of order, or cover elided events.
 */
function assertFullInterval(records: readonly SessionHistoryRecord[], fromSeq: number, throughSeq: number): void {
  if (records.length !== throughSeq - fromSeq + 1
    || records.some((record, index) => record.event.seq !== fromSeq + index || record.covers !== undefined)) {
    throw incompleteFullInterval(fromSeq, throughSeq)
  }
}

/**
 * Convert one local page into the journal page a prepend consumes.
 * @param page - the page the local copy served.
 * @param shared - header-sharing map of the owning Session.
 * @returns the page with shared headers, its digests when it carries any.
 */
function localPage(
  page: LocalHistoryPage,
  shared: Map<string, JsonValue>,
): SessionJournalPage {
  return {
    records: shareLocalHeaders(page.records, shared),
    hasMore: page.hasMore,
    ...(page.digests === undefined ? {} : { digests: page.digests }),
  }
}

type SessionControlBaselineFrame = Extract<SessionControlFrame, { type: 'baseline' }>
type SessionControlDeltaFrame = Exclude<SessionControlFrame, SessionControlBaselineFrame>

/** Gateway-owned control snapshot stream configured for Session frames. */
export type SessionControlStream = RemoteSnapshotStream<
  SessionControlBaselineFrame,
  SessionControlDeltaFrame
>

/** Domain sinks used by the Host-wide Session control stream. */
export interface SessionControlStreamOptions {
  /** Apply a complete baseline or one later update. */
  readonly accept: (frame: SessionControlFrame) => void
  /** Read the Sessions whose projections this Client holds, once per physical generation. */
  readonly known: () => readonly SessionControlKnown[]
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** Publish a terminal business or protocol failure. */
  readonly failed: (error: unknown) => void
}

/** Domain sinks used by one addressed Session event journal. */
export interface SessionEventStreamOptions {
  /** Resolve the current consumer requirement for every physical follow and page read. */
  readonly stepDetail?: () => SessionStepDetail
  /** Local copy consulted before the Host for every page, expansion, and interval read. */
  readonly source?: SessionHistorySource
  /** Session the copy is keyed by. */
  readonly sessionId: SessionId
  /** Whether full history is currently required, passed to local reads as their `full` flag. */
  readonly full: () => boolean
  /**
   * Map sharing identical local request headers inside one Session; omitted, the
   * stream keeps a private one, so the reads it serves do not share headers
   * with any other stream's window.
   */
  readonly sharedHeaders?: Map<string, JsonValue>
  /** Apply one complete event-window change. */
  readonly publish: (change: SessionJournalChange) => void
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** Publish a terminal stream, page, or protocol failure after opening. */
  readonly failed: (error: unknown) => void
}

/**
 * Create the Host-wide Session control snapshot stream.
 * @param remote - generated Session namespace and Gateway stream factory.
 * @param options - Session state destinations, including the checkpoints every opening reports.
 * @returns an unstarted stream owned by the Client Session runtime.
 */
export function createSessionControlStream(
  remote: SessionRemotes,
  options: SessionControlStreamOptions,
): SessionControlStream {
  const stream = remote.$stream<SessionControlFrame>({
    name: 'session control stream',
    open: signal => remote.session.control({ known: options.known() }, signal),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('session control stream ended without a terminal result')
      : new Error('session control stream ended before its opening snapshot'),
    ...(options.carrierFailed === undefined ? {} : { carrierFailed: options.carrierFailed }),
  })
  return new RemoteSnapshotStream(stream, {
    name: 'session control stream',
    isSnapshot: (frame): frame is SessionControlBaselineFrame => frame.type === 'baseline',
    replace: options.accept,
    update: options.accept,
    failed: options.failed,
  })
}

/** Gateway-owned event journal bound to one ordinary or direct-subagent Session address. */
export class SessionEventStream extends RemoteJournalStream<
  SessionJournalPage,
  SessionHistoryRecord,
  number,
  ClientSessionPageRequest,
  SessionAssistantStreamFrame
> {
  private readonly stepDetail: (() => SessionStepDetail) | undefined
  private readonly source: SessionHistorySource | undefined
  private readonly sessionId: SessionId
  private readonly full: () => boolean
  private headers: Map<string, JsonValue> | undefined
  private localFailureLogged = false

  /**
   * @param remote - generated Session namespace and Gateway stream factory.
   * @param address - durable ordinary-Session or direct-subagent address.
   * @param options - Session event-window destinations and the local copy to consult first.
   */
  constructor(
    private readonly remote: SessionRemotes,
    private readonly address: SessionAddress,
    options: SessionEventStreamOptions,
  ) {
    super(remote, {
      name: 'session event stream',
      emptyCursor: -1,
      entries: page => page.records,
      hasMore: page => page.hasMore,
      first: historyRecordFirstSeq,
      last: historyRecordLastSeq,
      compare: (left, right) => left - right,
      follows: (left, right) => right === left + 1,
      resumeEntries: 1,
      publish: (change) => { options.publish(toSessionJournalChange(change)) },
      ...(options.carrierFailed === undefined
        ? {}
        : { carrierFailed: options.carrierFailed }),
      failed: options.failed,
    })
    this.stepDetail = options.stepDetail
    this.source = options.source
    this.sessionId = options.sessionId
    this.full = options.full
    this.headers = options.sharedHeaders
  }

  /** The per-Session header map, created on first local read when the caller passed none. */
  private sharedHeaders(): Map<string, JsonValue> {
    this.headers ??= new Map()
    return this.headers
  }

  /**
   * Ask the local copy, answering `undefined` (read from the Host) when the read
   * rejects; the first rejection of this stream is logged.
   * @param read - one local copy read.
   * @returns the copy's answer, or `undefined` when it failed.
   */
  private async localRead<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
    try {
      return await read()
    } catch (error) {
      if (!this.localFailureLogged) {
        this.localFailureLogged = true
        console.warn('[session-controller] local copy read failed; reading from the Host instead:', error)
      }
      return undefined
    }
  }

  /**
   * Durable journal cursor the published window currently reaches, including
   * entries an assistant settlement still holds back.
   * @returns the cursor after a successful open.
   */
  override cursor(): number {
    return super.cursor()
  }

  /**
   * Open from a local page published before any remote frame, or from the
   * opening snapshot carried by the first follow frame.
   * @param request - opening-window request.
   * @param local - page read from the local copy and its cursor.
   * @returns after the window is published.
   */
  override open(
    request: ClientSessionPageRequest,
    local?: { readonly page: SessionJournalPage; readonly cursor: number },
  ): Promise<void> {
    return super.open(request, local)
  }

  /**
   * Take over an already-published window without republishing it; the first
   * remote opening resumes after it or replaces it.
   * @param request - opening-window request.
   * @param window - the held window's bounds and newest entry.
   */
  override adopt(request: ClientSessionPageRequest, window: {
    readonly first: number
    readonly last: number
    readonly newest: SessionHistoryRecord
  }): void {
    super.adopt(request, window)
  }

  /**
   * Read every durable event in the currently held interval, without reopening follow.
   * @param fromSeq - inclusive head of the caller's loaded window.
   * @returns complete records through the cursor captured when the request starts.
   */
  async readFullRange(fromSeq: number): Promise<readonly SessionHistoryRecord[]> {
    const throughSeq = this.cursor()
    const source = this.source
    if (source !== undefined) {
      const records = await this.localRead(() => source.interval(this.sessionId, { fromSeq, throughSeq, full: this.full() }))
      if (records !== undefined) {
        const local = shareLocalHeaders(records, this.sharedHeaders())
        assertFullInterval(local, fromSeq, throughSeq)
        return local
      }
    }
    const result = await this.remote.session.page(
      { address: this.address, fromSeq, throughSeq, stepDetail: 'full' },
      this.signal,
    )
    if (!result.ok) throw result.error
    const { records, digests } = result.value
    for (const record of records) assertSessionWireEvent(record.event)
    assertFullInterval(records, fromSeq, throughSeq)
    if (digests !== undefined && digests.length > 0) throw incompleteFullInterval(fromSeq, throughSeq)
    return records
  }

  private resolveRequest(request: ClientSessionPageRequest): ClientSessionPageRequest {
    return this.stepDetail === undefined ? request : { ...request, stepDetail: this.stepDetail() }
  }

  /**
   * Read back the events one collapsed page withheld from a turn, at the
   * journal's current cursor so the result never outruns the published window.
   * @param turn - the turn the reader expanded.
   * @param fromSeq - lowest seq the caller's window holds.
   * @param signal - caller cancellation for the read.
   * @returns the withheld records, ascending by seq.
   */
  async expandSteps(turn: number, fromSeq: number, signal?: AbortSignal): Promise<readonly SessionHistoryRecord[]> {
    const source = this.source
    if (source !== undefined) {
      const records = await this.localRead(() => source.elided(this.sessionId, {
        turn,
        fromSeq,
        throughSeq: this.cursor(),
        full: this.full(),
      }))
      if (records !== undefined) return shareLocalHeaders(records, this.sharedHeaders())
    }
    const result = await this.remote.session.expandSteps(
      { address: this.address, throughSeq: this.cursor(), turn, fromSeq },
      signal ?? this.signal,
    )
    if (!result.ok) throw result.error
    for (const record of result.value.records) assertSessionWireEvent(record.event)
    return result.value.records
  }

  /** @inheritdoc */
  protected override async * follow(
    request: ClientSessionPageRequest,
    signal: AbortSignal,
    held: RemoteJournalResumePoint<SessionHistoryRecord, number> | undefined,
  ): AsyncIterable<RemoteJournalFrame<
    SessionHistoryRecord, number, SessionJournalPage, SessionAssistantStreamFrame
  >> {
    let assistantRevision: number | undefined
    const resolved = this.resolveRequest(request)
    const resume = resumePoint(held)
    for await (const frame of this.remote.session.follow({
      address: this.address,
      activate: true,
      assistantStream: true,
      ...(this.source === undefined ? {} : { lines: true }),
      ...this.repairRequest(resolved),
      ...(resume === undefined ? {} : { resume }),
    }, signal)) {
      if (frame.type === 'line') {
        yield { type: 'entry', entry: lineEntryRecord(frame) }
        this.source?.append(this.sessionId, [{ seq: frame.seq, line: frame.line, link: frame.link }])
        continue
      }
      if (frame.type === 'snapshot' || frame.type === 'resumed') {
        // The lines a resumed opening carries are offered to the copy as one
        // batch, after the opening itself is published.
        const lines: { readonly seq: number; readonly line: string; readonly link: SessionChainLink }[] = []
        const records: readonly SessionHistoryRecord[] = frame.type === 'resumed'
          ? frame.records.map((record: SessionHistoryRecord | SessionLineEntry): SessionHistoryRecord => {
            if (record.type !== 'line') return record
            lines.push({ seq: record.seq, line: record.line, link: record.link })
            return lineEntryRecord(record)
          })
          : frame.records
        for (const record of records) assertSessionWireEvent(record.event)
        if (frame.assistantStream === undefined) {
          throw new RemoteError(
            'gateway/internal',
            'session assistant stream omitted its opted-in opening baseline',
            {},
          )
        }
        assistantRevision = frame.assistantStream.revision
        if (frame.type === 'resumed') {
          if (resume === undefined) {
            throw new RemoteError('gateway/internal', 'session follow resumed a window it was not offered', {})
          }
          yield {
            type: 'resumed',
            after: frame.after,
            cursor: frame.cursor,
            page: {
              records,
              // A resumed page continues the held window; it carries no older-history bound.
              hasMore: false,
              projections: frame.projections,
              assistantStream: frame.assistantStream,
            },
          }
          if (lines.length > 0) this.source?.append(this.sessionId, lines)
          continue
        }
        const continues = continuation(records, frame.cursor, resume)
        if (continues !== undefined) {
          yield {
            type: 'resumed',
            after: continues.afterSeq,
            cursor: continues.afterSeq,
            page: {
              records: [],
              // The snapshot already ends at the held window, so continuing it carries no entry.
              hasMore: false,
              projections: frame.projections,
              assistantStream: frame.assistantStream,
            },
          }
          continue
        }
        yield {
          type: 'opened',
          cursor: frame.cursor,
          page: {
            records,
            hasMore: frame.hasMore,
            ...(frame.digests === undefined ? {} : { digests: frame.digests }),
            projections: frame.projections,
            assistantStream: frame.assistantStream,
          },
        }
        continue
      }
      if (frame.type === 'assistant-stream') {
        const expected = (assistantRevision ?? 0) + 1
        if (frame.frame.revision !== expected) {
          throw new RemoteStreamCarrierError(
            `session assistant stream skipped revision ${String(expected)}`,
          )
        }
        assistantRevision = frame.frame.revision
        yield { type: 'notification', notification: frame.frame }
        continue
      }
      assertSessionWireEvent(frame.event)
      yield { type: 'entry', entry: frame }
    }
  }

  /** @inheritdoc */
  protected override async readPage(
    request: ClientSessionPageRequest,
    throughSeq: number,
    signal: AbortSignal,
  ): Promise<SessionJournalPage> {
    const source = this.source
    if (source !== undefined) {
      const page = await this.localRead(() => source.page(this.sessionId, {
        ...this.resolveRequest(request),
        throughSeq,
        full: this.full(),
      }))
      if (page !== undefined) return localPage(page, this.sharedHeaders())
    }
    const result = await this.remote.session.page(
      { address: this.address, throughSeq, ...this.resolveRequest(request) },
      signal,
    )
    if (!result.ok) throw result.error
    for (const record of result.value.records) assertSessionWireEvent(record.event)
    return result.value
  }

  /** @inheritdoc */
  protected override repairRequest(
    request: ClientSessionPageRequest,
  ): ClientSessionPageRequest {
    return {
      ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
      ...(request.turnWindow === undefined ? {} : { turnWindow: request.turnWindow }),
      ...(request.stepDetail === undefined ? {} : { stepDetail: request.stepDetail }),
    }
  }
}

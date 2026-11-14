/** Copy-backed page, interval and step-expansion reads (§2.8, §2.9). */

import type { LocalHistoryPage, LocalHistoryRecord, LocalHistoryWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionChainLink, SessionHistoryRecord, SessionWireEvent, StepDigest } from '@deepseek-ai/dsh-api-session-controller/types'
import {
  DEFAULT_MAX_MESSAGES, decodeStoredLine, detailPage, elidedEventsOfTurn, historyTurnUsage, pageRecords, paginate,
} from '@deepseek-ai/dsh-api-session-controller/history-shared'
import { assistantStreamFirstTokenTime } from '@deepseek-ai/dsh-llm/assistant-stream'
import { SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { linkOf, toHex } from './chain.ts'
import type { ChunkRecord, ThreadRecord } from './store.ts'

/** One decoded line of one stored chunk. */
interface RunLine {
  readonly seq: number
  readonly event: SessionEvent
  readonly byteLen: number
  readonly link: Uint8Array
}

/** Initial event count one page read starts from; every retry doubles it. */
const INITIAL_READ_EVENTS = 512

/** Block width of the backward and forward history scans. */
const SCAN_BLOCK_EVENTS = 256

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** Reads the local copy serves history from. */
export interface PagesStore {
  readThread(sessionId: SessionId): Promise<ThreadRecord | undefined>
  readChunks(sessionId: SessionId, fromSeq: number, throughSeq: number): Promise<readonly ChunkRecord[]>
}

/** One page cut: the window plus the exclusive top and inclusive bottom request bounds. */
type PageCut = LocalHistoryWindow & { readonly beforeSeq?: number; readonly throughSeq: number }

/** One step-expansion request (§3 C6). */
type ElidedRequest = {
  readonly turn: number
  readonly fromSeq?: number
  readonly throughSeq: number
  readonly full: boolean
}

/** One exact-interval request (§3 C6). */
type IntervalRequest = { readonly fromSeq: number; readonly throughSeq: number; readonly full: boolean }

/**
 * Read the newest window of a complete copy, or of a partial one while the Host is unreachable.
 * @param store - the chunk store.
 * @param sessionId - the thread to open.
 * @param window - the opening window.
 * @param offline - whether the page reported the Host unreachable.
 * @returns the page, marked `partial` when the copy is partial, or `undefined` to open from the Host.
 */
export async function localOpening(
  store: PagesStore, sessionId: SessionId, window: LocalHistoryWindow, offline: boolean,
): Promise<LocalHistoryPage | undefined> {
  const record = await readable(store, sessionId)
  if (record === undefined) return undefined
  // §2.7: a partial copy opens only while the Host cannot answer; §2.6 keeps an unverifiable copy unused.
  if (!record.complete && !offline) return undefined
  const page = await pageRead(store, record, { ...window, throughSeq: record.head })
  return page === undefined || record.complete ? page : { ...page, partial: true }
}

/**
 * Read one older page at a cut.
 * @param store - the chunk store.
 * @param sessionId - the thread.
 * @param request - the window, the exclusive `beforeSeq` and the inclusive cut.
 * @returns the page, or `undefined` when the copy does not cover it.
 */
export async function localPage(store: PagesStore, sessionId: SessionId, request: PageCut): Promise<LocalHistoryPage | undefined> {
  const record = await readable(store, sessionId)
  if (record === undefined) return undefined
  return await pageRead(store, record, request)
}

/**
 * Read every event of an inclusive interval.
 * @param store - the chunk store.
 * @param sessionId - the thread.
 * @param request - the interval and whether to keep heavy parts.
 * @returns the records, or `undefined` when the copy does not cover it.
 */
export async function localInterval(
  store: PagesStore, sessionId: SessionId, request: IntervalRequest,
): Promise<readonly LocalHistoryRecord[] | undefined> {
  const record = await readable(store, sessionId)
  if (record === undefined || request.throughSeq > record.head || request.fromSeq > request.throughSeq + 1 || request.fromSeq < 0) {
    return undefined
  }
  const run = new RunLoader(store, sessionId, record)
  await run.ensure(request.fromSeq, request.throughSeq)
  const events = run.events(request.fromSeq, request.throughSeq)
  if (events === undefined) return undefined
  if (events.length === 0) return []
  const first = events[0]
  /* v8 ignore next -- the length check above means a first event exists */
  if (first === undefined) return undefined
  const scopeStart = await run.turnStartBelow(first.seq)
  if (scopeStart === undefined) return undefined
  await run.ensure(scopeStart, request.throughSeq)
  const scope = run.events(scopeStart, request.throughSeq)
  /* v8 ignore next -- the ensure above loaded the whole scope range */
  if (scope === undefined) return undefined
  const usage = historyTurnUsage(events, scope)
  return await finishRecords(new RecordReader(run, !request.full), pageRecords(events, usage.byEnd, run.linkLookup()))
}

/**
 * Read the events a collapsed page withheld from one turn.
 * @param store - the chunk store.
 * @param sessionId - the thread.
 * @param request - the turn, the window head, the cut and whether to keep heavy parts.
 * @returns the records, or `undefined` when the copy does not cover the turn.
 */
export async function localElided(
  store: PagesStore, sessionId: SessionId, request: ElidedRequest,
): Promise<readonly LocalHistoryRecord[] | undefined> {
  const record = await readable(store, sessionId)
  if (record === undefined) return undefined
  const run = new RunLoader(store, sessionId, record)
  // Turn numbers are unique per log, so the one start below the cut is this turn's.
  const start = await run.turnStartBelow(Math.min(request.throughSeq, record.head), request.turn)
  if (start === undefined) return undefined
  let through = Math.min(request.throughSeq, record.head)
  if (request.throughSeq > record.head) {
    // §2.8: a cut above the head is covered only when the expanded turn ended at or below it.
    const end = await run.turnEndAbove(start, request.turn, record.head)
    if (end === undefined) return undefined
    through = end
  }
  await run.ensure(start, through)
  const scope = run.events(start, through)
  /* v8 ignore next -- the ensure above loaded the whole scope range */
  if (scope === undefined) return undefined
  const reader = new RecordReader(run, !request.full)
  // The Host's expansion serves plain records without links or turn usage.
  return await finishRecords(reader, pageRecords(elidedEventsOfTurn(scope, request.turn, request.fromSeq)))
}

/** The thread a read can use; `unverifiable` bytes are not proven to match the Host. */
async function readable(store: PagesStore, sessionId: SessionId): Promise<ThreadRecord | undefined> {
  const record = await store.readThread(sessionId)
  return record !== undefined && record.state !== 'unverifiable' ? record : undefined
}

/** One local page at a cut over the stored prefix (§2.8). */
async function pageRead(store: PagesStore, record: ThreadRecord, request: PageCut): Promise<LocalHistoryPage | undefined> {
  const end = Math.min(request.beforeSeq ?? request.throughSeq + 1, request.throughSeq + 1)
  // The request must name a top the copy stores; the scope runs to the capped cut, never past the head.
  if (end - 1 > record.head) return undefined
  const through = Math.min(request.throughSeq, record.head)
  const run = new RunLoader(store, record.sessionId, record)
  let count = INITIAL_READ_EVENTS
  for (;;) {
    const low = Math.max(0, end - count)
    await run.ensure(low, end - 1)
    const events = run.events(low, end - 1)
    if (events === undefined) return undefined
    const before = request.beforeSeq === undefined ? undefined : SessionLogOffset(request.beforeSeq)
    const page = paginate(events, before, request.maxMessages ?? DEFAULT_MAX_MESSAGES, SessionSeq(through), request.turnWindow, low)
    if (page.truncated) {
      // The copy is a prefix of the whole log, so the only floor to grow to is seq 0.
      /* v8 ignore next -- paginate truncates only at a positive floor, and low 0 means the whole prefix is loaded */
      if (low === 0) return undefined
      count *= 2
      continue
    }
    let records: readonly SessionHistoryRecord[] = []
    let digests: readonly StepDigest[] | undefined
    // An empty range carries nothing the shared decisions could change.
    if (page.events.length > 0) {
      const first = page.events[0]
      const last = page.events.at(-1)
      /* v8 ignore next -- the length check above means a first and a last event exist */
      if (first === undefined || last === undefined) return undefined
      // §2.8: a cut above the head is covered only when the page's last turn closed at or below it.
      if (request.throughSeq > record.head && !await run.closedBy(last.seq, record.head)) return undefined
      const scopeStart = await run.turnStartBelow(first.seq)
      if (scopeStart === undefined) return undefined
      const scopeTop = through
      await run.ensure(scopeStart, scopeTop)
      const scope = run.events(scopeStart, scopeTop)
      /* v8 ignore next -- the ensure above loaded the whole scope range */
      if (scope === undefined) return undefined
      const usage = historyTurnUsage(page.events, scope)
      const detail = detailPage(page.events, scope, request.stepDetail, usage.byEnd, run.linkLookup())
      records = detail.records
      digests = detail.digests
    }
    return {
      cursor: record.head,
      records: await finishRecords(new RecordReader(run, !request.full), records),
      hasMore: page.hasMore,
      ...(digests === undefined ? {} : { digests }),
    }
  }
}

/** Apply one answer's heavy-part decisions to built records, sequentially (§2.9). */
async function finishRecords(reader: RecordReader, records: readonly SessionHistoryRecord[]): Promise<readonly LocalHistoryRecord[]> {
  const finished: LocalHistoryRecord[] = []
  for (const record of records) {
    finished.push(await reader.finish(record))
  }
  return finished
}

/**
 * Accrues one answer's stream stripping, header keys and byte accounting over decoded lines.
 *
 * Recorded streams shrink to the prefix through their first token, and identical request
 * headers carry one shared key, so a Session keeps each heavy part once.
 */
class RecordReader {
  private readonly seenHeaders = new Set<string>()

  /**
   * @param run - the decoded lines of this answer.
   * @param light - whether to strip streams and key headers; `full` reads keep every heavy part.
   */
  constructor(private readonly run: RunLoader, private readonly light: boolean) {}

  /**
   * Finish one built record over its own line.
   * @param record - the record the shared code built.
   * @returns the local record the Session receives.
   */
  async finish(record: SessionHistoryRecord): Promise<LocalHistoryRecord> {
    const line = this.run.lineAt(record.event.seq)
    /* v8 ignore next -- the shared code built this record from the run's own lines */
    let bytes = line === undefined ? 0 : line.byteLen
    if (!this.light || line === undefined) return { ...record, bytes }
    let event = line.event
    let stripped: true | undefined
    if ((event.type === 'assistant/message' || event.type === 'assistant/attempt') && Array.isArray(event.data.stream)) {
      const stream = event.data.stream
      const keep = stream.findIndex(part => assistantStreamFirstTokenTime([part]) !== undefined) + 1
      if (keep < stream.length) {
        const kept = stream.slice(0, keep)
        // The byte figure drops what the prefix no longer holds.
        bytes -= JSON.stringify(stream).length - JSON.stringify(kept).length
        const shared = { ...event.data, stream: kept } as AssistantMessageData
        event = { ...event, data: shared }
        stripped = true
      }
    }
    let headerKey: string | undefined
    if (event.type === 'request/header') {
      const key = await headerKeyOf(event.data.header)
      /* v8 ignore next -- a wire-validated header is JSON, so its key always hashes */
      if (key !== undefined) {
        headerKey = key
        // A duplicated header shares the Session's first copy, so only the event shell costs memory.
        if (this.seenHeaders.has(key)) bytes -= JSON.stringify(event.data.header).length
        else this.seenHeaders.add(key)
      }
    }
    return {
      ...record,
      event: wireOf(event),
      ...(headerKey === undefined ? {} : { headerKey }),
      ...(stripped === undefined ? {} : { stripped }),
      bytes: Math.max(0, bytes),
    }
  }
}

/** SHA-256 key of one request header's JSON text (§2.9). */
async function headerKeyOf(header: unknown): Promise<string | undefined> {
  const text = JSON.stringify(header)
  /* v8 ignore next -- a wire-validated header is JSON, so its text always stringifies */
  if (typeof text !== 'string') return undefined
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))))
}

/**
 * Retype one locally decoded event copy for the wire record it becomes.
 *
 * `decodeStoredLine` validated this exact value, and the store built it from a JSON
 * round-trip the chain proved byte-identical to the Host's, so it carries the wire
 * envelope at runtime like the record events the Host serves.
 * @param event - a locally decoded event copy.
 * @returns the event in the wire record type.
 */
function wireOf(event: SessionEvent): SessionWireEvent {
  return event as SessionWireEvent
}


/** One assistant message event's data. */
type AssistantMessageData = SessionEvent<'assistant/message'>['data']

/** Decoded line cache over the stored chunks of one read. */
class RunLoader {
  private readonly lines = new Map<number, RunLine>()
  private loadedFirst: number | undefined
  private loadedLast: number | undefined

  /**
   * @param store - the store to read chunks from.
   * @param sessionId - the thread.
   * @param record - the thread record the read covers.
   */
  constructor(private readonly store: PagesStore, private readonly sessionId: SessionId, private readonly record: ThreadRecord) {}

  /** Decode every stored line of [from..through]. */
  async ensure(from: number, through: number): Promise<void> {
    const low = Math.max(0, from)
    const high = Math.min(this.record.head, through)
    if (low > high) return
    const readFrom = this.loadedFirst === undefined ? low : Math.min(this.loadedFirst, low)
    const readThrough = this.loadedLast === undefined ? high : Math.max(this.loadedLast, high)
    for (const chunk of await this.store.readChunks(this.sessionId, readFrom, readThrough)) this.absorb(chunk)
  }

  /** Decode one chunk's lines into the cache. */
  private absorb(chunk: ChunkRecord): void {
    let start = 0
    for (const [index, end] of chunk.ends.entries()) {
      const seq = chunk.first + index
      if (!this.lines.has(seq)) {
        this.lines.set(seq, {
          seq,
          event: decodeStoredLine(decoder.decode(chunk.data.subarray(start, end)), seq) as SessionEvent,
          byteLen: end - start,
          link: chunk.links.subarray(index * 32, index * 32 + 32),
        })
        if (this.loadedFirst === undefined || this.loadedFirst > seq) this.loadedFirst = seq
        if (this.loadedLast === undefined || this.loadedLast < seq) this.loadedLast = seq
      }
      start = end + 1
    }
  }

  /** Contiguous ascending events of [from..through]; `undefined` on any gap. */
  events(from: number, through: number): readonly SessionEvent[] | undefined {
    if (from > through) return []
    const events: SessionEvent[] = []
    for (let seq = from; seq <= through; seq++) {
      const line = this.lines.get(seq)
      if (line === undefined) return undefined
      events.push(line.event)
    }
    return events
  }

  /** One loaded line. */
  lineAt(seq: number): RunLine | undefined {
    return this.lines.get(seq)
  }

  /** Position-to-link lookup the shared record builders take. */
  linkLookup(): (seq: number) => SessionChainLink | undefined {
    return (seq) => {
      const raw = this.lineAt(seq)?.link
      /* v8 ignore next -- the shared builders look up links only for seqs the run holds */
      return raw === undefined ? undefined : linkOf(raw)
    }
  }

  /**
   * Start of the latest turn at or below `from`, reading blocks on demand.
   * @param from - position to search below, inclusive.
   * @param turn - restrict to this turn's start; without it, the first turn start found wins.
   * @returns the start seq, or `undefined` when the wanted turn never starts at or below `from`.
   */
  async turnStartBelow(from: number, turn?: number): Promise<number | undefined> {
    let bound = Math.min(from, this.record.head)
    for (;;) {
      const low = Math.max(0, bound - SCAN_BLOCK_EVENTS + 1)
      await this.ensure(low, bound)
      for (let seq = bound; seq >= low; seq--) {
        const line = this.lines.get(seq)
        if (line === undefined) return undefined
        if (line.event.type !== 'turn/start') continue
        const at = (line.event.data as { readonly turn: number }).turn
        if (turn === undefined || at === turn) return seq
        if (at < turn) return undefined
      }
      if (low === 0) return turn === undefined ? 0 : undefined
      bound = low - 1
    }
  }

  /**
   * Whether the turn holding one position is closed by the bound: its `turn/end`, or a later turn's start, lies in `[seq, bound]`.
   * @param seq - the position.
   * @param bound - highest seq to search, inclusive.
   * @returns whether a closing event was found.
   */
  async closedBy(seq: number, bound: number): Promise<boolean> {
    for (let low = seq; low <= bound; low += SCAN_BLOCK_EVENTS) {
      const high = Math.min(bound, low + SCAN_BLOCK_EVENTS - 1)
      await this.ensure(low, high)
      for (let at = low; at <= high; at++) {
        const type = this.lines.get(at)?.event.type
        if (type === 'turn/end' || (type === 'turn/start' && at > seq)) return true
      }
    }
    return false
  }

  /**
   * End of one turn, searched above its start position.
   * @param start - the turn's start position.
   * @param turn - the turn number the start belongs to.
   * @param bound - highest seq to search, inclusive.
   * @returns the end seq, or `undefined` when the turn is still open at the bound.
   */
  async turnEndAbove(start: number, turn: number, bound: number): Promise<number | undefined> {
    for (let low = start; low <= bound; low += SCAN_BLOCK_EVENTS) {
      const high = Math.min(bound, low + SCAN_BLOCK_EVENTS - 1)
      await this.ensure(low, high)
      for (let seq = low; seq <= high; seq++) {
        const line = this.lines.get(seq)
        /* v8 ignore next -- the ensure above loaded the whole scan block */
        if (line === undefined) return undefined
        const event = line.event
        if (event.type === 'turn/end' && (event.data as { readonly turn: number }).turn === turn) return seq
        if (event.type === 'turn/start' && seq > start && (event.data as { readonly turn: number }).turn > turn) return undefined
      }
    }
    return undefined
  }
}

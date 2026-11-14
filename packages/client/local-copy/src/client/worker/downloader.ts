/** The origin-wide download loop: one thread at a time, one chunk at a time (§2.5). */

import type { SessionChainLink } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { type FetchLinesFailure, type VerifiedHead, buildHave, fetchLines } from './fetch-lines.ts'
import { equalBytes, linkOf, nextLink, parseLink } from './chain.ts'
import { buildChunkInputs, isQuotaError, LocalCopyStore, type Continuation, type StoredLine, type ThreadRecord } from './store.ts'
import type { LocalCopyInit, LocalCopyListedThread, LocalCopyThreadNotification } from '../protocol.ts'

/** Exclusive Web Lock guard of the download loop. */
export interface LockHost {
  /**
   * Run one callback under a named lock.
   * @param name - lock name.
   * @param options - lock request options.
   * @param callback - body holding the lock.
   * @returns the callback's result.
   */
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>
}

/** Network, lock and clock inputs of the loop. */
export interface DownloaderEnvironment {
  readonly fetch: typeof fetch
  readonly locks: LockHost | undefined
  readonly onLine: () => boolean
  readonly now: () => number
}

/** Message for the page when a thread's copy moves. */
export type NotifyThread = (notification: LocalCopyThreadNotification) => void

/** Delay before the first chunk so startup requests never compete (§2.5). */
const START_DELAY_MS = 3_000

/** Idle poll that lets paused and unverifiable threads come due. */
const IDLE_POLL_MS = 60_000

/** First backoff after one unreachable chunk request. */
const NETWORK_BACKOFF_START_MS = 1_000

/** Longest backoff between chunk requests after consecutive failures. */
const NETWORK_BACKOFF_MAX_MS = 5 * 60_000

/** Pause before retrying a thread the Host refused to serve lines for. */
const PAUSED_RETRY_MS = 10 * 60_000

/** Pause before retrying a chain-unverifiable thread. */
const UNVERIFIABLE_RETRY_MS = 60 * 60_000

/** Copies younger than this are never quota-evicted. */
const EVICTION_GRACE_MS = 10 * 60_000

/** Chain tag the stored copies carry; the literal matches the persistence chain. */
const CHAIN_TAG = 'dsh-session-chain/1'

/**
 * Keeps every thread of this origin's copy current.
 *
 * The loop downloads one thread's one chunk at a time under the origin-wide Web
 * Lock, recomputing the queue after every chunk, and stores only what the
 * chain verified; every step is idempotent, so a frozen or discarded worker
 * resumes from the stored head. A complete copy rejoins the queue when the
 * session list reports activity its last download was not made for.
 */
export class LocalCopyDownloader {
  private initialized: LocalCopyInit | undefined
  private disposed = false
  private offline = false
  private hidden = false
  private readonly listed = new Map<SessionId, LocalCopyListedThread>()
  private openedInTab: SessionId[] = []
  private resolvers: readonly (() => void)[] = []
  private backoffMs = 0
  /** Epoch ms of each thread's last unexpected failure, which holds it out of the queue even when parking cannot be stored. */
  private readonly failedAt = new Map<SessionId, number>()

  /**
   * @param store - the chunk store.
   * @param env - network, lock and clock inputs.
   * @param notify - thread notification sink.
   */
  constructor(private readonly store: LocalCopyStore, private readonly env: DownloaderEnvironment, private readonly notify: NotifyThread) {}

  /**
   * Accept device inputs and start the loop, no earlier than the startup delay.
   * @param init - device inputs.
   */
  init(init: LocalCopyInit): void {
    if (this.initialized !== undefined) throw new Error('local copy: downloader is already initialized')
    this.initialized = init
    void this.loop(init)
  }

  /** Stop the loop; a disposed downloader ignores every later input. */
  dispose(): void {
    this.disposed = true
    this.wake()
  }

  /**
   * Record that a Session opened, raising its priority and clearing its blocked state.
   * @param sessionId - the Session.
   */
  async opened(sessionId: SessionId): Promise<void> {
    const record = await this.store.ensureThread(sessionId, this.env.now())
    if (record.state === 'unverifiable' || record.state === 'paused') {
      await this.mark(sessionId, { state: 'downloading', problem: null, complete: false })
    }
    this.failedAt.delete(sessionId)
    this.openedInTab = [sessionId, ...this.openedInTab.filter(id => id !== sessionId)]
    this.wake()
  }

  /**
   * Queue a repair after a Host snapshot replaced a locally opened window (§2.6).
   * @param sessionId - the Session.
   */
  async diverged(sessionId: SessionId): Promise<void> {
    const record = await this.store.readThread(sessionId)
    if (record !== undefined && record.complete) {
      await this.mark(sessionId, { state: 'downloading', complete: false, problem: null })
    }
    this.wake()
  }

  /**
   * Page-reported offline replay state; the loop pauses while it is active.
   * @param offline - whether offline replay is answering.
   */
  setOffline(offline: boolean): void {
    this.offline = offline
    this.wake()
  }

  /**
   * Page-reported visibility; a phone releases the lock while hidden.
   * @param hidden - whether the page is hidden.
   */
  setHidden(hidden: boolean): void {
    this.hidden = hidden
    this.wake()
  }

  /**
   * Replace the listed sessions: the scope's candidates beyond opened ones, and the activity complete copies are compared with.
   * @param listed - sessions with their latest Host activity.
   */
  schedule(listed: readonly LocalCopyListedThread[]): void {
    this.listed.clear()
    for (const thread of listed) this.listed.set(thread.sessionId, thread)
    this.wake()
  }

  /**
   * Offer stored lines that arrived live or in a resumed opening (§2.6). Lines at or below the stored
   * head whose links equal the stored ones are already in the copy and are skipped; any other mismatch
   * queues a repair.
   * @param sessionId - the thread.
   * @param lines - consecutive stored lines with the Host's links.
   */
  async append(
    sessionId: SessionId,
    lines: readonly { readonly seq: number; readonly line: string; readonly link: string }[],
  ): Promise<void> {
    const init = this.initialized
    const record = await this.store.readThread(sessionId)
    if (init === undefined || record === undefined || record.head < 0 || record.headLink === null) {
      this.wake()
      return
    }
    // A refresh may have stored these lines first; a chain link commits to its whole prefix,
    // so an equal stored link means the line is already in the copy.
    const stale = lines.filter(offered => offered.seq <= record.head)
    if (stale.length > 0) {
      const stored = await this.store.readLinks(sessionId, stale.map(offered => offered.seq))
      if (stale.some((offered, index) => stored[index] !== offered.link)) {
        await this.queueRepair(sessionId, record)
        return
      }
    }
    const encoder = new TextEncoder()
    let previous = parseLink(record.headLink)
    let expected = record.head + 1
    const verified: StoredLine[] = []
    for (const offered of lines.filter(line => line.seq > record.head)) {
      const bytes = encoder.encode(offered.line)
      const link = parseLink(offered.link)
      const computed = previous !== undefined ? await nextLink(previous, bytes) : undefined
      if (previous === undefined || link === undefined || offered.seq !== expected || !equalBytes(computed, link)) {
        await this.queueRepair(sessionId, record)
        return
      }
      verified.push({ seq: offered.seq, bytes, link })
      previous = link
      expected += 1
    }
    if (verified.length === 0) return
    await this.store.appendChunks(
      sessionId, buildChunkInputs(sessionId, verified, init.chunkBytes), { head: record.head, headLink: record.headLink }, {},
    )
    await this.store.compactTrailing(sessionId, init.chunkBytes)
    this.wake()
  }

  /** Apply one patch and tell the page the record's resulting state. */
  private async mark(sessionId: SessionId, patch: Parameters<LocalCopyStore['markThread']>[1]): Promise<ThreadRecord | undefined> {
    const updated = await this.store.markThread(sessionId, patch)
    if (updated !== undefined) this.thread(updated)
    return updated
  }

  /** Post one thread notification with the record's current values. */
  private thread(record: ThreadRecord): void {
    this.notify({ type: 'thread', sessionId: record.sessionId, state: record.state, head: record.head, cursorSeen: record.cursorSeen })
  }

  /** An append that failed to verify leaves the copy to the checkpoint repair. */
  private async queueRepair(sessionId: SessionId, record: ThreadRecord): Promise<void> {
    if (record.complete || record.state === 'unverifiable') {
      await this.mark(sessionId, { state: 'downloading', complete: false, problem: null })
    }
    this.wake()
  }

  private wake(): void {
    const resolvers = this.resolvers
    this.resolvers = []
    for (const resolve of resolvers) resolve()
  }

  /**
   * Wait for a timeout or a wake call.
   * @param ms - timeout, or `undefined` to wait only for a wake.
   */
  private wait(ms: number | undefined): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = ms === undefined ? undefined : setTimeout(resolve, ms)
      const wakeResolver = () => {
        if (timer !== undefined) clearTimeout(timer)
        resolve()
      }
      this.resolvers = [...this.resolvers, wakeResolver]
    })
  }

  /** Run download rounds until the loop is stopped or paused. */
  private async loop(init: LocalCopyInit): Promise<void> {
    await new Promise<void>((resolve) => { setTimeout(resolve, START_DELAY_MS) })
    while (!this.disposed) {
      while (this.paused()) await this.wait(undefined)
      const round = async (): Promise<void> => {
        while (!this.disposed && !this.paused()) {
          const next = await this.nextThread(init)
          if (next === undefined) {
            await this.wait(IDLE_POLL_MS)
            return
          }
          await this.downloadOrPark(init, next)
        }
      }
      try {
        if (this.env.locks === undefined) await round()
        else await this.env.locks.request('dsh-local-copy/download', { mode: 'exclusive' }, round)
      } catch (error: unknown) {
        // A failure outside one thread's download (the queue read, the lock, or parking itself) never ends the loop.
        console.warn('local copy: a download round failed', error)
        await this.wait(this.bumpBackoff())
      }
    }
  }

  /** Offline and hidden pauses of §2.5; a phone releases the lock in between. */
  private paused(): boolean {
    if (!this.env.onLine()) return true
    return this.offline || (this.initialized?.phone === true && this.hidden)
  }

  /** Backoff delay after a network failure, doubling to the cap; a success resets it. */
  private bumpBackoff(): number {
    this.backoffMs = this.backoffMs === 0 ? NETWORK_BACKOFF_START_MS : Math.min(this.backoffMs * 2, NETWORK_BACKOFF_MAX_MS)
    return this.backoffMs
  }

  /** Queue order of §2.5: this tab's opened threads, then the device's, then the listed scope. */
  private async nextThread(init: LocalCopyInit): Promise<SessionId | undefined> {
    for (const sessionId of this.openedInTab) {
      if (await this.runnable(sessionId)) return sessionId
    }
    const stored = await this.store.listThreads()
    const device = stored.filter(record => record.openedAt > 0).sort((left, right) => right.openedAt - left.openedAt)
    for (const record of device) {
      if (this.openedInTab.includes(record.sessionId)) continue
      if (this.runnableRecord(record)) return record.sessionId
    }
    if (init.scope === 'all') {
      const listed = [...this.listed.values()].sort((left, right) => right.activityAt - left.activityAt).map(thread => thread.sessionId)
      for (const sessionId of listed) {
        if (this.openedInTab.includes(sessionId) || device.some(record => record.sessionId === sessionId)) continue
        if (await this.runnable(sessionId)) return sessionId
      }
    }
    return undefined
  }

  /** Whether the thread's current record belongs in the queue. */
  private async runnable(sessionId: SessionId): Promise<boolean> {
    if (this.recentlyFailed(sessionId)) return false
    const record = await this.store.readThread(sessionId)
    return record === undefined || this.runnableRecord(record)
  }

  /** Whether the thread failed unexpectedly within the paused retry interval. */
  private recentlyFailed(sessionId: SessionId): boolean {
    const at = this.failedAt.get(sessionId)
    return at !== undefined && this.env.now() - at < PAUSED_RETRY_MS
  }

  /** A stored record's queue candidacy by state, retry age, and, for a complete copy, list activity. */
  private runnableRecord(record: ThreadRecord): boolean {
    if (record.chainTag !== CHAIN_TAG || this.recentlyFailed(record.sessionId)) return false
    const blockedAt = record.problem === undefined ? undefined : record.problem.at
    if (record.state === 'unverifiable' && blockedAt !== undefined && this.env.now() - blockedAt < UNVERIFIABLE_RETRY_MS) return false
    if (record.state === 'paused') {
      if (record.problem?.code === 'quota') return false
      if (blockedAt !== undefined && this.env.now() - blockedAt < PAUSED_RETRY_MS) return false
    }
    return !record.complete || this.behind(record)
  }

  /**
   * Whether the session list reports Host activity a complete copy's last download was not made for:
   * a later prompt, a running state that changed, or a projection seq past both the stored head and
   * the seq last recorded, so a seq the Host log never reaches costs one refresh.
   */
  private behind(record: ThreadRecord): boolean {
    const listed = this.listed.get(record.sessionId)
    if (listed === undefined) return false
    return listed.activityAt > record.activityAt
      || listed.running !== record.activityRunning
      || (listed.activitySeq > record.head && listed.activitySeq > record.activitySeq)
  }

  /** Download one thread's next chunk; an unexpected failure parks the thread so the queue moves on. */
  private async downloadOrPark(init: LocalCopyInit, sessionId: SessionId): Promise<void> {
    try {
      await this.downloadThread(init, sessionId)
    } catch (error: unknown) {
      console.warn('local copy: a thread download failed', sessionId, error)
      this.failedAt.set(sessionId, this.env.now())
      await this.mark(sessionId, { state: 'paused', problem: { code: 'unexpected', at: this.env.now() } })
    }
  }

  /** Download one thread's next chunk, then pause by the busy arithmetic (§2.5). */
  private async downloadThread(init: LocalCopyInit, sessionId: SessionId): Promise<void> {
    const record = (await this.store.readThread(sessionId)) ?? await this.store.ensureThread(sessionId, 0)
    // Activity the list reported before this fetch, so a later report always looks newer.
    const activity = this.listed.get(sessionId)
    const seqs = haveSeqs(record.head)
    const links = await this.store.readLinks(sessionId, seqs)
    const rawLinks = new Map<number, Uint8Array<ArrayBuffer>>()
    const hexLinks = new Map<number, SessionChainLink>()
    for (const [index, seq] of seqs.entries()) {
      const link = links[index]
      if (link === undefined) continue
      hexLinks.set(seq, link)
      const parsed = parseLink(link)
      /* v8 ignore next -- stored links are 64-hex strings this store encoded, so parsing always succeeds */
      if (parsed !== undefined) rawLinks.set(seq, parsed)
    }
    const outcome = await fetchLines({
      sessionId,
      linesUrl: init.linesUrl,
      maxBytes: init.chunkBytes,
      have: buildHave(record.head, seq => hexLinks.get(seq)),
      storedLink: seq => rawLinks.get(seq),
      fetch: this.env.fetch,
    })
    const busyStart = this.env.now()
    if ('failure' in outcome) {
      await this.failed(sessionId, outcome.failure)
      return
    }
    // The stored link the fetched lines were verified from; a from-scratch response has none.
    const verifiedLink = hexLinks.get(outcome.head.start - 1) ?? null
    const lines: StoredLine[] = []
    for (const [index, bytes] of outcome.lines.entries()) {
      const link = outcome.links[index]
      /* v8 ignore next -- fetchLines pushes one link per line in the same loop */
      if (link === undefined) throw new Error('local copy: a fetched line carries no link')
      lines.push({ seq: outcome.head.start + index, bytes, link })
    }
    if (!await this.enforceBudget(
      init, sessionId, lines.reduce((total, line) => total + line.bytes.byteLength + 1, 0),
    )) {
      await this.mark(sessionId, { state: 'paused', problem: { code: 'quota', at: this.env.now() } })
      return
    }
    try {
      await this.storeVerified(init, sessionId, record, outcome.head, lines, verifiedLink, activity)
    } catch (error: unknown) {
      if (isQuotaError(error)) {
        await this.quota(init, sessionId, record, outcome.head, lines, verifiedLink, activity)
        return
      }
      throw error
    }
    const busyMs = Math.max(1, this.env.now() - busyStart)
    await this.wait(Math.max(init.minPauseMs, 4 * (outcome.busyMs + busyMs)))
  }

  /**
   * Store one verified chunk, truncating or replacing the copy as the head demands (§2.5).
   * @param init - device inputs.
   * @param sessionId - the thread.
   * @param record - the head the fetch verified against.
   * @param head - the response's validated head.
   * @param lines - verified lines, ascending.
   * @param verifiedLink - the stored link at `head.start − 1` the lines were verified from.
   * @param activity - the list activity read before the fetch, recorded with the chunk.
   */
  private async storeVerified(
    init: LocalCopyInit, sessionId: SessionId, record: ThreadRecord, head: VerifiedHead, lines: readonly StoredLine[],
    verifiedLink: SessionChainLink | null, activity: LocalCopyListedThread | undefined,
  ): Promise<void> {
    const progress = {
      problem: null,
      cursorSeen: head.cursor,
      complete: head.through === head.cursor,
      state: head.through === head.cursor ? 'complete' as const : 'downloading' as const,
      ...(activity === undefined
        ? {}
        : { activityAt: activity.activityAt, activitySeq: activity.activitySeq, activityRunning: activity.running }),
    }
    if (head.start === 0) {
      /* v8 ignore next 3 -- verifiedHead already rejects a from-scratch head without its header; this narrows the fields */
      if (head.header === null || head.headerLink === null) {
        throw new Error('local copy: a from-scratch response carries no header')
      }
      const updated = await this.store.replaceThread(
        sessionId, head.header, linkOf(head.headerLink), buildChunkInputs(sessionId, lines, init.chunkBytes), progress,
      )
      this.thread(updated)
      this.backoffMs = 0
      return
    }
    if (head.start <= record.head && await this.store.truncateThread(sessionId, head.start - 1) === undefined) return
    // The append succeeds only while the stored head is still the line the fetched lines were verified from.
    const previous: Continuation = { head: head.start - 1, headLink: verifiedLink }
    const written = await this.store.appendChunks(
      sessionId, buildChunkInputs(sessionId, lines, init.chunkBytes), previous, progress,
    )
    if (!written) this.wake()
    else {
      this.backoffMs = 0
      const updated = await this.store.readThread(sessionId)
      if (updated !== undefined) this.thread(updated)
    }
  }

  /** Handle one typed chunk failure (§2.5). */
  private async failed(sessionId: SessionId, failure: FetchLinesFailure): Promise<void> {
    if (failure.kind === 'chain-mismatch' || failure.kind === 'line-unverifiable') {
      await this.mark(sessionId, {
        state: 'unverifiable',
        problem: {
          code: failure.kind,
          at: this.env.now(),
          ...(failure.kind === 'line-unverifiable' ? { seq: failure.seq } : {}),
        },
      })
      return
    }
    if (failure.kind === 'lines-unavailable') {
      await this.mark(sessionId, { state: 'paused', problem: { code: 'lines-unavailable', at: this.env.now() } })
      return
    }
    const status = failure.kind === 'http' ? failure.status : 599
    // A restarting Host's Web app answers 404 before its routes register, and a
    // re-authenticating one 401 or 403; all of these are transient carriers that
    // rejoin the bounded backoff ladder instead of parking the thread.
    if (failure.kind === 'network' || status >= 500 || status === 404 || status === 401 || status === 403) {
      await this.wait(this.bumpBackoff())
      return
    }
    await this.mark(sessionId, { state: 'paused', problem: { code: 'http', at: this.env.now() } })
  }

  /** Quota handling (§2.5): run the budget's eviction, retry the write once, then park the thread. */
  private async quota(
    init: LocalCopyInit, sessionId: SessionId, record: ThreadRecord,
    head: VerifiedHead, lines: readonly StoredLine[], verifiedLink: SessionChainLink | null,
    activity: LocalCopyListedThread | undefined,
  ): Promise<void> {
    if (await this.enforceBudget(
      init, sessionId, lines.reduce((total, line) => total + line.bytes.byteLength + 1, 0),
    )) {
      try {
        // The retry writes the same response the Host already verified.
        await this.storeVerified(init, sessionId, record, head, lines, verifiedLink, activity)
        return
      } catch (error: unknown) {
        if (!isQuotaError(error)) throw error
      }
    }
    await this.mark(sessionId, { state: 'paused', problem: { code: 'quota', at: this.env.now() } })
  }

  /**
   * Make room for one pending chunk under the disk budget (§2.12): delete whole
   * copies opened outside the grace window, least recently opened first.
   * @param init - device inputs.
   * @param sessionId - the thread about to store the chunk.
   * @param pendingBytes - byte size of the chunk about to be stored.
   * @returns whether the chunk now fits; with no budget it always does.
   */
  private async enforceBudget(
    init: LocalCopyInit, sessionId: SessionId, pendingBytes: number,
  ): Promise<boolean> {
    if (init.diskBudgetBytes <= 0) return true
    const stored = await this.store.listThreads()
    const evictable = stored
      .filter(thread => thread.sessionId !== sessionId && !this.openedInTab.includes(thread.sessionId))
      .filter(thread => thread.openedAt > 0 && this.env.now() - thread.openedAt >= EVICTION_GRACE_MS)
      .sort((left, right) => left.openedAt - right.openedAt)
    let total = stored.filter(thread => thread.sessionId !== sessionId).reduce((sum, thread) => sum + thread.lineBytes, 0)
    while (total + pendingBytes > init.diskBudgetBytes && evictable.length > 0) {
      const victim = evictable.shift()
      /* v8 ignore next -- shift answers a value while the guarded length stays positive */
      if (victim === undefined) break
      total -= victim.lineBytes
      await this.store.deleteThread(victim.sessionId)
    }
    return total + pendingBytes <= init.diskBudgetBytes
  }
}

/**
 * Offsets of the checkpoint seqs: `head`, `head − 1`, `head − 2`, `head − 4`, … (§2.5).
 * @param head - stored head seq, −1 when nothing is stored.
 * @returns strictly descending checkpoint seqs.
 */
export function haveSeqs(head: number): number[] {
  const seqs: number[] = []
  for (let offset = 0; head - offset >= 0 && seqs.length < 32; offset = offset === 0 ? 1 : offset * 2) {
    seqs.push(head - offset)
  }
  return seqs
}

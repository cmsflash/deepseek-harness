/** IndexedDB chunk store of one origin's local Session log copies (§2.4). */

import type { SessionChainLink } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LocalCopyUsage } from '../protocol.ts'
import { linkOf } from './chain.ts'

/** Database name of the local copy, one per origin (§2.4). */
export const DATABASE_NAME = 'dsh-local-copy'

/** Schema version of the local copy's IndexedDB database. */
export const DATABASE_VERSION = 1

/** Chain tag every stored copy must carry (§2.4). */
export const CHAIN_TAG = 'dsh-session-chain/1'

/** Trailing chunks below this size merge once they pile past the byte budget (§2.4). */
const SMALL_CHUNK_BYTES = 64 * 1024

/** Object stores of the local-copy database. */
const STORES = {
  threads: 'threads',
  chunks: 'chunks',
  meta: 'meta',
} as const

/** Copy state of one thread. */
export type ThreadState = 'downloading' | 'complete' | 'unverifiable' | 'paused'

/** Record of why a copy stopped progressing. */
export interface ThreadProblem {
  readonly code: string
  readonly seq?: number
  readonly at: number
}

/** One row of the `threads` store. */
export interface ThreadRecord {
  readonly sessionId: SessionId
  readonly chainTag: string
  /** Header line text, once a whole download or replacement arrived. */
  readonly header: string | null
  readonly headerLink: SessionChainLink | null
  /** Last stored seq; −1 before the first stored line. */
  readonly head: number
  readonly headLink: SessionChainLink | null
  readonly lineBytes: number
  readonly chunkCount: number
  /** Host cursor the last fetch observed. */
  readonly cursorSeen: number
  readonly complete: boolean
  readonly state: ThreadState
  readonly problem?: ThreadProblem
  /** Last open on this device, epoch ms; 0 when never opened here. */
  readonly openedAt: number
  readonly syncedAt: number
  /** Latest prompt time the session list reported when the last stored download started (0 before one). */
  readonly activityAt: number
  /** Projection watermark seq the session list reported then; −1 when none. */
  readonly activitySeq: number
  /** Whether the session list reported the thread running then. */
  readonly activityRunning: boolean
}

/** One chunk record: `data` joins the lines with `\n` (no trailing newline) and `ends[i]` is line i's exclusive end. */
export interface ChunkRecord {
  readonly sessionId: SessionId
  readonly first: number
  readonly last: number
  readonly data: Uint8Array
  readonly ends: Uint32Array
  readonly links: Uint8Array<ArrayBuffer>
}

/** One chunk prepared for writing. */
export type ChunkInput = ChunkRecord

/** One stored line with the 32 link bytes that verified it. */
export interface StoredLine {
  readonly seq: number
  readonly bytes: Uint8Array
  readonly link: Uint8Array<ArrayBuffer>
}

/** Bookkeeping fields a state change may replace. */
export interface ThreadPatch {
  readonly state?: ThreadState
  /** `null` clears the problem field. */
  readonly problem?: ThreadProblem | null
  readonly openedAt?: number
  readonly activityAt?: number
  readonly activitySeq?: number
  readonly activityRunning?: boolean
  readonly cursorSeen?: number
  readonly complete?: boolean
}

/** Completion fields a successful download applies, with the session-list activity it was made for. */
export type ThreadProgress = Pick<
  ThreadPatch, 'cursorSeen' | 'complete' | 'state' | 'problem' | 'activityAt' | 'activitySeq' | 'activityRunning'
>

/** A stored head and its link, which a continuation chunk must carry on from. */
export interface Continuation {
  readonly head: number
  readonly headLink: SessionChainLink | null
}

/** IndexedDB providers the store runs against. */
export interface StoreEnvironment {
  readonly indexedDB: IDBFactory
  readonly keyRange: typeof IDBKeyRange
}

/**
 * Split verified lines into chunk inputs around the byte budget.
 * @param sessionId - the thread the lines belong to.
 * @param lines - consecutive stored lines.
 * @param chunkBytes - byte budget per chunk.
 * @returns chunks; each oversized line stands alone in its own chunk.
 */
export function buildChunkInputs(sessionId: SessionId, lines: readonly StoredLine[], chunkBytes: number): ChunkInput[] {
  const chunks: ChunkInput[] = []
  let pending: StoredLine[] = []
  let pendingBytes = 0
  for (const line of lines) {
    const separator = pending.length === 0 ? 0 : 1
    if (pending.length > 0 && pendingBytes + separator + line.bytes.byteLength > chunkBytes) {
      chunks.push(inlineChunk(sessionId, pending))
      pending = []
      pendingBytes = 0
    }
    pending.push(line)
    pendingBytes += line.bytes.byteLength + (pending.length === 1 ? 0 : 1)
  }
  if (pending.length > 0) chunks.push(inlineChunk(sessionId, pending))
  return chunks
}

/** Encode one consecutive run of lines as a chunk record. */
function inlineChunk(sessionId: SessionId, lines: readonly StoredLine[]): ChunkInput {
  const first = lines[0]
  const last = lines.at(-1)
  /* v8 ignore next -- buildChunkInputs never hands an empty run to its own builder */
  if (first === undefined || last === undefined) throw new Error('local copy: a chunk requires at least one line')
  const data = new Uint8Array(lines.reduce((total, line) => total + line.bytes.byteLength + 1, 0) - 1)
  const ends = new Uint32Array(lines.length)
  const links = new Uint8Array(lines.length * 32)
  let offset = 0
  for (const [index, line] of lines.entries()) {
    data.set(line.bytes, offset)
    if (index < lines.length - 1) data[offset + line.bytes.byteLength] = 0x0a
    offset += line.bytes.byteLength + 1
    ends[index] = offset - 1
    links.set(line.link, index * 32)
  }
  return { sessionId, first: first.seq, last: last.seq, data, ends, links }
}

/**
 * The local-copy database: one origin's thread chunks and bookkeeping.
 *
 * Every write puts its chunk(s) and the `threads` record in one transaction,
 * comparing the record's stored head against the continuation the caller
 * verified, so a tab that lost a race leaves the other tab's copy untouched.
 */
export class LocalCopyStore {
  private database: Promise<IDBDatabase> | undefined
  private readonly corrupted = new Set<SessionId>()

  /**
   * @param env - the IndexedDB factory and key-range provider of this worker or test.
   */
  constructor(private readonly env: StoreEnvironment) {}

  /** Open (or create) the database; a future schema is deleted and recreated, since the Host holds the master copy (§2.14). */
  async open(): Promise<void> {
    await this.connection()
  }

  /**
   * The current connection, opened on first use and again after the browser
   * closed it (`close`, `versionchange`) or a previous open failed.
   * @returns the connection promise every operation shares until it is dropped.
   */
  private connection(): Promise<IDBDatabase> {
    if (this.database !== undefined) return this.database
    const database: Promise<IDBDatabase> = this.connect().then((db) => {
      db.onclose = () => { this.forget(database) }
      db.onversionchange = () => {
        db.close()
        this.forget(database)
      }
      return db
    }, (error: unknown) => {
      this.forget(database)
      throw error
    })
    this.database = database
    return database
  }

  /** Drop a connection promise unless a newer one already replaced it. */
  private forget(database: Promise<IDBDatabase>): void {
    if (this.database === database) this.database = undefined
  }

  private async connect(): Promise<IDBDatabase> {
    try {
      return await this.openOnce()
    } catch (error) {
      if (error instanceof Error && error.name !== 'VersionError') throw error
      await deleteDatabase(this.env.indexedDB, DATABASE_NAME)
      return await this.openOnce()
    }
  }

  private openOnce(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.env.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        for (const store of Object.values(STORES)) {
          /* v8 ignore next -- a same-version open never upgrades; a fresh database has no stores yet */
          if (db.objectStoreNames.contains(store)) db.deleteObjectStore(store)
          db.createObjectStore(store)
        }
      }
      request.onsuccess = () => { resolve(request.result) }
      /* v8 ignore next -- the open error text always carries the request's own error */
      request.onerror = () => { reject(request.error ?? new Error('local copy: IndexedDB open failed')) }
      /* v8 ignore next -- the open keeps the schema's own version, so an open block never happens without a newer schema */
      request.onblocked = () => { reject(new Error('local copy: IndexedDB open is blocked')) }
    })
  }

  /**
   * Run one transaction to completion, surfacing body failures and request aborts.
   * @param stores - object stores the transaction covers.
   * @param mode - transaction mode.
   * @param body - request scheduling; its rejection aborts the transaction.
   * @param reconnect - whether a closed connection may be replaced once before the transaction starts.
   * @returns the body's value once the transaction commits.
   */
  private async run<T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T>, reconnect = true): Promise<T> {
    const database = this.connection()
    const db = await database
    let tx: IDBTransaction
    try {
      tx = db.transaction(stores, mode)
    } catch (error) {
      // The browser closed the connection without a `close` event (iOS after
      // suspension); no request ran, so one retry on a new connection is safe.
      if (!reconnect || !(error instanceof Error && error.name === 'InvalidStateError')) throw error
      this.forget(database)
      return await this.run(stores, mode, body, false)
    }
    return await new Promise<T>((resolve, reject) => {
      let failure: { readonly error: unknown } | undefined
      let result: { readonly value: T } | undefined
      tx.oncomplete = () => {
        /* v8 ignore next 3 -- a failed body aborts before completion fires, and a settled body binds its result in a microtask first */
        if (failure !== undefined) reject(new Error('local copy: the transaction body failed', { cause: failure.error }))
        else if (result !== undefined) resolve(result.value)
        else reject(new Error('local copy: transaction settled without a result'))
      }
      tx.onabort = () => { reject(new Error('local copy: transaction aborted', { cause: failure?.error ?? tx.error })) }
      void (body(tx).then((value: T) => { result = { value } }, (error: unknown) => {
        failure = { error }
        abortTransaction(tx)
      }))
    })
  }

  /**
   * Wrap one IndexedDB request in a promise.
   * @param request - the request to await.
   * @returns the request result.
   */
  static request<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(new Error('local copy: IndexedDB request failed', { cause: request.error })) }
    })
  }

  /**
   * Drain one cursor's steps until it ends or the step stops it.
   * @param request - the dispatched cursor request.
   * @param step - one step: continue the cursor inside, or return `false` to stop.
   * @returns when the cursor ends or the step stops it; rejects when the cursor fails.
   */
  static drainCursor(request: IDBRequest<IDBCursorWithValue | null>, step: (current: IDBCursorWithValue) => boolean | void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const current = request.result
        if (current === null) { resolve(); return }
        if (step(current) === false) { resolve(); return }
      }
      request.onerror = () => { reject(new Error('local copy: IndexedDB cursor failed', { cause: request.error })) }
    })
  }

  /**
   * Read one thread record.
   * @param sessionId - the thread.
   * @returns the record, or `undefined` when no copy exists.
   */
  async readThread(sessionId: SessionId): Promise<ThreadRecord | undefined> {
    await this.open()
    return await this.run([STORES.threads], 'readonly', async tx =>
      validThread(await LocalCopyStore.request(tx.objectStore(STORES.threads).get(sessionId))))
  }

  /**
   * Read every thread record.
   * @returns all stored records.
   */
  async listThreads(): Promise<ThreadRecord[]> {
    await this.open()
    const rows = await this.run([STORES.threads], 'readonly', async tx =>
      LocalCopyStore.request(tx.objectStore(STORES.threads).getAll()))
    return rows.flatMap((row) => {
      const record = validThread(row)
      return record === undefined ? [] : [record]
    })
  }

  /**
   * Fetch or create the downloading skeleton of one thread, refreshing the open time.
   * @param sessionId - the thread.
   * @param openedAt - epoch ms of this device's open, or 0 to leave any stored value.
   * @returns the stored record.
   */
  async ensureThread(sessionId: SessionId, openedAt: number): Promise<ThreadRecord> {
    await this.open()
    return await this.run([STORES.threads], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORES.threads)
      const existing = validThread(await LocalCopyStore.request(store.get(sessionId)))
      if (existing !== undefined) {
        if (openedAt !== 0 && existing.openedAt !== openedAt) {
          const updated = { ...existing, openedAt }
          await LocalCopyStore.request(store.put(updated, sessionId))
          return updated
        }
        return existing
      }
      const record: ThreadRecord = {
        sessionId,
        chainTag: CHAIN_TAG,
        header: null,
        headerLink: null,
        head: -1,
        headLink: null,
        lineBytes: 0,
        chunkCount: 0,
        cursorSeen: -1,
        complete: false,
        state: 'downloading',
        openedAt,
        syncedAt: Date.now(),
        activityAt: 0,
        activitySeq: -1,
        activityRunning: false,
      }
      await LocalCopyStore.request(store.put(record, sessionId))
      return record
    })
  }

  /**
   * Patch one thread's mutable bookkeeping.
   * @param sessionId - the thread.
   * @param patch - fields to replace; `problem: null` clears it.
   * @returns the stored record, or `undefined` when the thread is absent.
   */
  async markThread(sessionId: SessionId, patch: ThreadPatch): Promise<ThreadRecord | undefined> {
    await this.open()
    return await this.run([STORES.threads], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORES.threads)
      const existing = validThread(await LocalCopyStore.request(store.get(sessionId)))
      if (existing === undefined) return undefined
      const updated = applyPatch(existing, patch)
      await LocalCopyStore.request(store.put(updated, sessionId))
      return updated
    })
  }

  /**
   * Replace a whole copy in one transaction: every stored chunk goes, a fresh header and chunks come.
   * @param sessionId - the thread.
   * @param header - header line text.
   * @param headerLink - verified link of the header line.
   * @param chunks - consecutive chunks starting at seq 0.
   * @param progress - completion fields applied in the same transaction.
   * @returns the stored record.
   */
  async replaceThread(
    sessionId: SessionId, header: string, headerLink: SessionChainLink,
    chunks: readonly ChunkInput[], progress: ThreadProgress,
  ): Promise<ThreadRecord> {
    await this.open()
    return await this.run([STORES.threads, STORES.chunks], 'readwrite', async (tx) => {
      const threads = tx.objectStore(STORES.threads)
      const previous = validThread(await LocalCopyStore.request(threads.get(sessionId)))
      await this.deleteChunkRange(tx, sessionId)
      const chunkStore = tx.objectStore(STORES.chunks)
      let lineBytes = 0
      for (const chunk of chunks) {
        lineBytes += chunk.data.byteLength
        chunkStore.put(chunk, [chunk.sessionId, chunk.first])
      }
      const tail = chunks.at(-1)
      const record: ThreadRecord = applyPatch({
        sessionId,
        chainTag: CHAIN_TAG,
        header,
        headerLink,
        head: tail?.last ?? -1,
        headLink: tail === undefined ? null : tailLink(tail),
        lineBytes,
        chunkCount: chunks.length,
        cursorSeen: -1,
        complete: false,
        state: 'downloading',
        openedAt: previous?.openedAt ?? 0,
        activityAt: previous?.activityAt ?? 0,
        activitySeq: previous?.activitySeq ?? -1,
        activityRunning: previous?.activityRunning ?? false,
        syncedAt: Date.now(),
      }, progress)
      threads.put(record, sessionId)
      return record
    })
  }

  /**
   * Append verified chunks after the stored head, or apply a chunk-free completion update at the expected head.
   * @param sessionId - the thread.
   * @param chunks - consecutive chunks whose first line continues `previous`.
   * @param previous - head and link the caller verified the continuation against.
   * @param progress - completion fields applied in the same transaction.
   * @returns whether the append won the race; `false` leaves the stored copy untouched for a reread.
   */
  async appendChunks(
    sessionId: SessionId, chunks: readonly ChunkInput[], previous: Continuation, progress: ThreadProgress,
  ): Promise<boolean> {
    await this.open()
    return await this.run([STORES.threads, STORES.chunks], 'readwrite', async (tx) => {
      const threads = tx.objectStore(STORES.threads)
      const existing = validThread(await LocalCopyStore.request(threads.get(sessionId)))
      if (existing === undefined || existing.head !== previous.head || existing.headLink !== previous.headLink) return false
      const first = chunks[0]
      if (first === undefined) {
        threads.put(applyPatch(existing, progress), sessionId)
        return true
      }
      if (existing.chainTag !== CHAIN_TAG || existing.head + 1 !== first.first) return false
      const chunkStore = tx.objectStore(STORES.chunks)
      let addedBytes = 0
      for (const chunk of chunks) {
        addedBytes += chunk.data.byteLength
        chunkStore.put(chunk, [chunk.sessionId, chunk.first])
      }
      const tail = chunks.at(-1)
      /* v8 ignore next -- the empty-chunks shortcut above means a tail always exists */
      if (tail !== undefined) {
        threads.put(applyPatch({
          ...existing,
          head: tail.last,
          headLink: tailLink(tail),
          lineBytes: existing.lineBytes + addedBytes,
          chunkCount: existing.chunkCount + chunks.length,
          syncedAt: Date.now(),
        }, progress), sessionId)
      }
      return true
    })
  }

  /**
   * Drop every line above `newHead`, rewriting the chunk that contains it (§2.4).
   * @param sessionId - the thread.
   * @param newHead - inclusive head to truncate to; below the first chunk's start the copy empties.
   * @returns the stored record, or `undefined` when the thread was absent.
   */
  async truncateThread(sessionId: SessionId, newHead: number): Promise<ThreadRecord | undefined> {
    await this.open()
    return await this.run([STORES.threads, STORES.chunks], 'readwrite', async (tx) => {
      const threads = tx.objectStore(STORES.threads)
      const existing = validThread(await LocalCopyStore.request(threads.get(sessionId)))
      if (existing === undefined || existing.head <= newHead) return existing
      const chunkStore = tx.objectStore(STORES.chunks)
      const tail = await this.readChunkAt(tx, sessionId, existing, newHead)
      let removedBytes = 0
      let removedChunks = 0
      const above = chunkStore.openCursor(this.env.keyRange.bound([sessionId, newHead + 1], [sessionId, Number.MAX_SAFE_INTEGER]))
      await LocalCopyStore.drainCursor(above, (current) => {
        removedBytes += (current.value as ChunkRecord).data.byteLength
        removedChunks += 1
        current.delete()
        current.continue()
      })
      let record: ThreadRecord
      // A covering chunk that ends below the new head leaves a gap, so the copy restarts empty.
      if (tail === undefined || tail.last < newHead) {
        await this.deleteChunkRange(tx, sessionId)
        record = { ...existing, head: -1, headLink: null, lineBytes: 0, chunkCount: 0, complete: false, state: 'downloading', syncedAt: Date.now() }
      } else {
        const keep = newHead - tail.first
        /* v8 ignore next -- the chunk found spans the new head, so keep stays inside its ends */
        const keptBytes = keep < 0 ? 0 : tail.ends.at(keep) ?? 0
        const trimmed: ChunkRecord = {
          sessionId,
          first: tail.first,
          last: newHead,
          // Copies, because a stored view keeps its whole source buffer.
          data: tail.data.slice(0, keptBytes),
          ends: tail.ends.slice(0, keep + 1),
          links: tail.links.slice(0, (keep + 1) * 32),
        }
        removedBytes += tail.data.byteLength - keptBytes
        chunkStore.put(trimmed, [sessionId, trimmed.first])
        record = {
          ...existing,
          head: newHead,
          headLink: tailLink(trimmed),
          lineBytes: Math.max(0, existing.lineBytes - removedBytes),
          chunkCount: existing.chunkCount - removedChunks,
          complete: false,
          state: 'downloading',
          syncedAt: Date.now(),
        }
      }
      threads.put(record, sessionId)
      return record
    })
  }

  /**
   * Delete one thread's record and chunks.
   * @param sessionId - the thread to forget.
   */
  async deleteThread(sessionId: SessionId): Promise<void> {
    await this.open()
    await this.run([STORES.threads, STORES.chunks], 'readwrite', async (tx) => {
      await this.deleteChunkRange(tx, sessionId)
      void tx.objectStore(STORES.threads).delete(sessionId)
    })
  }

  /**
   * Read the chunks one seq interval touches, validating every record against the thread it must continue.
   *
   * The walk starts at the chunk covering `fromSeq`, so a read costs the chunks it
   * returns, not the stored prefix below them; the copy must still begin at seq 0.
   * @param sessionId - the thread.
   * @param fromSeq - lowest seq of interest.
   * @param throughSeq - highest seq of interest.
   * @returns ascending gap-free chunks covering `[fromSeq, min(throughSeq, head)]`; empty when the
   * copy does not reach `fromSeq` or is corrupt (corrupt data is deleted for a fresh download).
   */
  async readChunks(sessionId: SessionId, fromSeq: number, throughSeq: number): Promise<readonly ChunkRecord[]> {
    await this.open()
    const from = Math.max(0, fromSeq)
    const chunks: ChunkRecord[] = []
    const outcome = { corrupt: false }
    await this.run([STORES.threads, STORES.chunks], 'readonly', async (tx) => {
      const row: unknown = await LocalCopyStore.request(tx.objectStore(STORES.threads).get(sessionId))
      const record = validThread(row)
      if (record === undefined || record.chainTag !== CHAIN_TAG || record.head < from || from > throughSeq) return
      const chunkStore = tx.objectStore(STORES.chunks)
      const lowest = await LocalCopyStore.request(chunkStore.openKeyCursor(this.chunkRange(sessionId)))
      const covering = await LocalCopyStore.request(
        chunkStore.openKeyCursor(this.env.keyRange.bound([sessionId, 0], [sessionId, from]), 'prev'),
      )
      const startFirst = chunkKeyFirst(covering?.key)
      if (chunkKeyFirst(lowest?.key) !== 0 || startFirst === undefined) {
        outcome.corrupt = true
        return
      }
      const top = Math.min(throughSeq, record.head)
      let expected = startFirst
      const cursor = chunkStore.openCursor(this.env.keyRange.bound([sessionId, startFirst], [sessionId, Number.MAX_SAFE_INTEGER]))
      await LocalCopyStore.drainCursor(cursor, (current) => {
        const value: unknown = current.value
        if (!validChunk(value, record) || value.first !== expected) {
          outcome.corrupt = true
          return false
        }
        expected = value.last + 1
        chunks.push(value)
        if (value.last >= top) return false
        current.continue()
      })
      // A covering chunk that ends below `from`, or a walk that stops below the head, leaves a gap.
      if (expected <= top) outcome.corrupt = true
    })
    if (outcome.corrupt) {
      await this.dropCorrupted(sessionId)
      return []
    }
    return chunks
  }

  /**
   * Read the verified lines of one seq interval.
   * @param sessionId - the thread.
   * @param fromSeq - first seq of interest.
   * @param throughSeq - last seq of interest.
   * @returns the stored lines of `[fromSeq, min(throughSeq, head)]`, ascending; empty when the copy does not reach `fromSeq`.
   */
  async readLines(sessionId: SessionId, fromSeq: number, throughSeq: number): Promise<readonly StoredLine[]> {
    const lines: StoredLine[] = []
    for (const chunk of await this.readChunks(sessionId, fromSeq, throughSeq)) {
      for (let seq = Math.max(fromSeq, chunk.first); seq <= Math.min(throughSeq, chunk.last); seq++) {
        lines.push(chunkLine(chunk, seq))
      }
    }
    return lines
  }

  /**
   * Read the links of several seqs, for download checkpoints.
   *
   * Each distinct chunk a checkpoint falls in is read once, so the cost follows the
   * number of checkpoint chunks rather than the span between the lowest checkpoint and the head.
   * @param sessionId - the thread.
   * @param seqs - positions to read.
   * @returns one link per requested seq, `undefined` where the copy does not reach.
   */
  async readLinks(sessionId: SessionId, seqs: readonly number[]): Promise<readonly (SessionChainLink | undefined)[]> {
    const bySeq = new Map<number, SessionChainLink>()
    const read: ChunkRecord[] = []
    for (const seq of [...seqs].sort((left, right) => right - left)) {
      let chunk = read.find(candidate => candidate.first <= seq && seq <= candidate.last)
      if (chunk === undefined) {
        chunk = (await this.readChunks(sessionId, seq, seq))[0]
        if (chunk === undefined) continue
        read.push(chunk)
      }
      bySeq.set(seq, chunkLineLink(chunk, seq))
    }
    return seqs.map(seq => bySeq.get(seq))
  }

  /**
   * Read one meta value.
   * @param key - meta key.
   * @returns the stored value, or `undefined` when absent.
   */
  async readMeta(key: string): Promise<unknown> {
    await this.open()
    return await this.run([STORES.meta], 'readonly', async tx =>
      LocalCopyStore.request<unknown>(tx.objectStore(STORES.meta).get(key)))
  }

  /**
   * Store one meta value.
   * @param key - meta key.
   * @param value - value to store.
   */
  async writeMeta(key: string, value: unknown): Promise<void> {
    await this.open()
    await this.run([STORES.meta], 'readwrite', (tx) => {
      tx.objectStore(STORES.meta).put(value, key)
      return Promise.resolve()
    })
  }

  /**
   * Summarize the stored copies.
   * @returns thread counts per state and total stored line bytes.
   */
  async usage(): Promise<LocalCopyUsage> {
    const threads = await this.listThreads()
    const counts: Record<'downloading' | 'complete' | 'unverifiable' | 'paused', number> = {
      downloading: 0, complete: 0, unverifiable: 0, paused: 0,
    }
    let lineBytes = 0
    for (const thread of threads) {
      counts[thread.state] += 1
      lineBytes += thread.lineBytes
    }
    return { threads: threads.length, ...counts, lineBytes }
  }

  /** Delete every record and chunk of this database. */
  async clear(): Promise<void> {
    await this.open()
    await this.run(Object.values(STORES), 'readwrite', (tx) => {
      for (const store of Object.values(STORES)) tx.objectStore(store).clear()
      return Promise.resolve()
    })
  }

  /**
   * Merge a run of trailing small chunks once they pile past the byte budget (§2.4).
   * @param sessionId - the thread to compact.
   * @param chunkBytes - byte budget of one chunk.
   */
  async compactTrailing(sessionId: SessionId, chunkBytes: number): Promise<void> {
    await this.open()
    await this.run([STORES.threads, STORES.chunks], 'readwrite', async (tx) => {
      const threads = tx.objectStore(STORES.threads)
      const record = validThread(await LocalCopyStore.request(threads.get(sessionId)))
      if (record === undefined || record.head < 0) return
      const chunkStore = tx.objectStore(STORES.chunks)
      const descending = chunkStore.openCursor(this.chunkRange(sessionId), 'prev')
      const trailing: ChunkRecord[] = []
      let trailingBytes = 0
      await LocalCopyStore.drainCursor(descending, (current) => {
        if (!validChunk(current.value, record)) return false
        const chunk: ChunkRecord = current.value
        if (chunk.data.byteLength >= SMALL_CHUNK_BYTES) return false
        trailing.push(chunk)
        trailingBytes += chunk.data.byteLength
        current.continue()
      })
      const newest = trailing[0]
      if (trailing.length < 2 || trailingBytes < chunkBytes || newest === undefined || newest.last !== record.head) return
      const lines: StoredLine[] = []
      let expected = record.head + 1
      for (const chunk of trailing) {
        if (chunk.last + 1 !== expected) return
        expected = chunk.first
        // The walk is newest-first, so each chunk contributes its lines in descending order too.
        for (let seq = chunk.last; seq >= chunk.first; seq--) lines.push(chunkLine(chunk, seq))
      }
      lines.reverse()
      // The merged chunk also carries the separators between the merged runs.
      const merged = buildChunkInputs(sessionId, lines, Math.max(chunkBytes, trailingBytes + lines.length))
      /* v8 ignore next -- the merge budget covers the trailing bytes, so exactly one chunk comes back */
      if (merged.length !== 1) return
      for (const chunk of trailing) {
        await LocalCopyStore.request(chunkStore.delete([sessionId, chunk.first]))
      }
      const mergedChunk = merged[0]
      /* v8 ignore next -- the single-chunk check above means a merged chunk exists */
      if (mergedChunk === undefined) return
      chunkStore.put(mergedChunk, [sessionId, mergedChunk.first])
      threads.put({ ...record, chunkCount: record.chunkCount - trailing.length + 1 }, sessionId)
    })
  }

  /**
   * Collect and delete one foreign store's recorded `session/follow` stream keys (offline replay migration, §2.13).
   * @param name - foreign database name.
   * @param store - object store that recorded streams.
   * @returns the recorded session ids, in ascending key order.
   */
  async migrateForeignFollowKeys(name: string, store: string): Promise<readonly SessionId[]> {
    return await new Promise<readonly SessionId[]>((resolve) => {
      const request = this.env.indexedDB.open(name)
      request.onsuccess = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(store)) {
          db.close()
          resolve([])
          return
        }
        const tx = db.transaction(store, 'readwrite')
        const found: SessionId[] = []
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          db.close()
          resolve(found)
        }
        tx.oncomplete = finish
        tx.onabort = finish
        const cursor = tx.objectStore(store).openCursor()
        void LocalCopyStore.drainCursor(cursor, (current) => {
          if (typeof current.key === 'string' && current.key.startsWith('stream session/follow ')) {
            const id = recordedFollowSession(current.key)
            if (id !== undefined) found.push(id)
            current.delete()
          }
          current.continue()
        }).then(finish, finish)
      }
      /* v8 ignore next -- an unversioned open of an existing foreign database does not fail */
      request.onerror = () => { resolve([]) }
    })
  }

  /** Key range covering every chunk of one thread. */
  private chunkRange(sessionId: SessionId): IDBKeyRange {
    return this.env.keyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER])
  }

  /** Delete every chunk of one thread inside a live transaction. */
  private deleteChunkRange(tx: IDBTransaction, sessionId: SessionId): Promise<void> {
    return LocalCopyStore.drainCursor(tx.objectStore(STORES.chunks).openCursor(this.chunkRange(sessionId)), (current) => {
      current.delete()
      current.continue()
    })
  }

  /** Read the chunk covering one seq inside a live transaction. */
  private readChunkAt(tx: IDBTransaction, sessionId: SessionId, record: ThreadRecord, seq: number): Promise<ChunkRecord | undefined> {
    return new Promise<ChunkRecord | undefined>((resolve, reject) => {
      const cursor = tx.objectStore(STORES.chunks).openCursor(this.env.keyRange.upperBound([sessionId, seq]), 'prev')
      cursor.onsuccess = () => {
        const current = cursor.result
        if (current === null) { resolve(undefined); return }
        resolve(validChunk(current.value, record) ? current.value : undefined)
      }
      cursor.onerror = () => { reject(new Error('local copy: IndexedDB cursor failed', { cause: cursor.error })) }
    })
  }

  /** Corrupt data is dropped once and warned once per database session. */
  private async dropCorrupted(sessionId: SessionId): Promise<void> {
    await this.deleteThread(sessionId)
    if (this.corrupted.has(sessionId)) return
    this.corrupted.add(sessionId)
    console.warn('local copy: dropped a malformed copy of', sessionId)
  }
}

/**
 * Whether a failed store operation ran out of storage: the quota error is the
 * failure itself or anywhere in its `cause` chain, where the store's transaction
 * and request failures carry it.
 * @param error - a store operation's rejection.
 * @returns whether the browser refused the write for quota.
 */
export function isQuotaError(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current.name === 'QuotaExceededError') return true
  }
  return false
}

/** Abort a transaction whose body failed. */
function abortTransaction(tx: IDBTransaction): void {
  try {
    tx.abort()
  } catch (_alreadyAborted) {
    // InvalidStateError: a failed request already aborted the transaction, and `onabort` reports that request's error.
  }
}

/** Apply a patch to one thread record, clearing the problem field on `null`. */
function applyPatch(record: ThreadRecord, patch: ThreadPatch): ThreadRecord {
  const cleared = patch.problem === null
    ? (({ problem: _cleared, ...rest }) => rest)(record)
    : record
  return {
    ...cleared,
    ...(patch.state === undefined ? {} : { state: patch.state }),
    ...(patch.problem === undefined || patch.problem === null ? {} : { problem: patch.problem }),
    ...(patch.openedAt === undefined ? {} : { openedAt: patch.openedAt }),
    ...(patch.activityAt === undefined ? {} : { activityAt: patch.activityAt }),
    ...(patch.activitySeq === undefined ? {} : { activitySeq: patch.activitySeq }),
    ...(patch.activityRunning === undefined ? {} : { activityRunning: patch.activityRunning }),
    ...(patch.cursorSeen === undefined ? {} : { cursorSeen: patch.cursorSeen }),
    ...(patch.complete === undefined ? {} : { complete: patch.complete }),
  }
}

/** Link of a chunk's last line. */
function tailLink(chunk: ChunkInput): SessionChainLink {
  return linkOf(chunk.links.subarray(chunk.links.byteLength - 32))
}

/** One chunk record's link at a seq it covers. */
function chunkLineLink(chunk: ChunkRecord, seq: number): SessionChainLink {
  return linkOf(chunk.links.subarray((seq - chunk.first) * 32, (seq - chunk.first) * 32 + 32))
}

/** One line of one chunk, viewed without copying. */
function chunkLine(chunk: ChunkRecord, seq: number): StoredLine {
  const index = seq - chunk.first
  /* v8 ignore next 2 -- ends are dense and cover the seq, so both lookups stay in range */
  const start = index === 0 ? 0 : (chunk.ends.at(index - 1) ?? 0) + 1
  /* v8 ignore next -- ends cover the seq, so the end lookup stays in range */
  const end = chunk.ends.at(index) ?? 0
  return { seq, bytes: chunk.data.subarray(start, end), link: chunk.links.subarray(index * 32, index * 32 + 32) }
}

/** Extract the session id one recorded follow stream key addressed, or `undefined`. */
function recordedFollowSession(key: string): SessionId | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(key.slice('stream session/follow '.length))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const payload = parsed as Record<string, unknown>
  const args = payload['args']
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const request = (args as Record<string, unknown>)['request']
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return undefined
  const address = (request as Record<string, unknown>)['address']
  if (typeof address !== 'object' || address === null || Array.isArray(address)) return undefined
  if ((address as Record<string, unknown>)['kind'] !== 'session') return undefined
  const sessionId = (address as Record<string, unknown>)['sessionId']
  return typeof sessionId === 'string' ? brandString<SessionId>(sessionId) : undefined
}

/** Delete a database, ignoring failures (§2.14 recreation). */
function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const request = factory.deleteDatabase(name)
    request.onsuccess = () => { resolve() }
    /* v8 ignore next 2 -- the schema's own database answers either way; the caller waits only for the return */
    request.onerror = () => { resolve() }
    request.onblocked = () => { resolve() }
  })
}

/** Whether a read value is one stored thread record. */
function validThread(value: unknown): ThreadRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record['sessionId'] !== 'string' || typeof record['chainTag'] !== 'string') return undefined
  if (typeof record['header'] !== 'string' && record['header'] !== null) return undefined
  const head = record['head']
  const lineBytes = record['lineBytes']
  const chunkCount = record['chunkCount']
  const cursorSeen = record['cursorSeen']
  if (typeof head !== 'number' || typeof lineBytes !== 'number' || typeof chunkCount !== 'number' || typeof cursorSeen !== 'number') return undefined
  if (!Number.isSafeInteger(head) || head < -1) return undefined
  if (!Number.isSafeInteger(lineBytes) || lineBytes < 0 || !Number.isSafeInteger(chunkCount) || chunkCount < 0) return undefined
  if (!Number.isSafeInteger(cursorSeen)) return undefined
  if (typeof record['complete'] !== 'boolean') return undefined
  const state = record['state']
  if (state !== 'downloading' && state !== 'complete' && state !== 'unverifiable' && state !== 'paused') return undefined
  const headerLink = record['headerLink']
  const headLink = record['headLink']
  if (headerLink !== null && typeof headerLink !== 'string') return undefined
  if (headLink !== null && typeof headLink !== 'string') return undefined
  const openedAt = record['openedAt']
  const syncedAt = record['syncedAt']
  const activityAt = record['activityAt']
  if (typeof openedAt !== 'number' || typeof syncedAt !== 'number' || typeof activityAt !== 'number') return undefined
  const activitySeq = record['activitySeq']
  const activityRunning = record['activityRunning']
  if (typeof activitySeq !== 'number' || !Number.isSafeInteger(activitySeq) || typeof activityRunning !== 'boolean') return undefined
  const problem = record['problem'] === undefined ? undefined : problemOf(record['problem'])
  if (problem === null) return undefined
  const thread: ThreadRecord = {
    sessionId: record['sessionId'] as SessionId,
    chainTag: record['chainTag'],
    header: typeof record['header'] === 'string' ? record['header'] : null,
    headerLink: headerLink as ThreadRecord['headerLink'],
    head,
    headLink: headLink as ThreadRecord['headLink'],
    lineBytes,
    chunkCount,
    cursorSeen,
    complete: record['complete'],
    state,
    ...(problem === undefined ? {} : { problem }),
    openedAt,
    syncedAt,
    activityAt,
    activitySeq,
    activityRunning,
  }
  return thread
}

/** Whether a read value is one thread problem record. */
function problemOf(value: unknown): ThreadProblem | undefined | null {
  if (typeof value !== 'object' || value === null) return null
  const problem = value as Record<string, unknown>
  if (typeof problem['code'] !== 'string') return null
  const at = problem['at']
  if (typeof at !== 'number' || !Number.isSafeInteger(at)) return null
  const seq = problem['seq']
  return { code: problem['code'], ...(typeof seq === 'number' && Number.isSafeInteger(seq) ? { seq } : {}), at }
}

/** The `first` seq of one chunk key, or `undefined` when there is no key. */
function chunkKeyFirst(key: IDBValidKey | undefined): number | undefined {
  return Array.isArray(key) && typeof key[1] === 'number' ? key[1] : undefined
}

/** Whether a read value satisfies the chunk invariants a gap-free prefix guarantees. */
function validChunk(value: unknown, record: ThreadRecord): value is ChunkRecord {
  if (typeof value !== 'object' || value === null) return false
  const chunk = value as Record<string, unknown>
  if (chunk['sessionId'] !== record.sessionId) return false
  const first = chunk['first']
  const last = chunk['last']
  if (typeof first !== 'number' || typeof last !== 'number' || !Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return false
  if (first < 0 || last < first || last > record.head) return false
  const data = chunk['data']
  const ends = chunk['ends']
  const links = chunk['links']
  if (!(data instanceof Uint8Array) || !(ends instanceof Uint32Array) || !(links instanceof Uint8Array)) return false
  if (ends.length !== last - first + 1 || links.byteLength !== ends.length * 32) return false
  // Line i spans [ends[i − 1] + 1, ends[i]); the last line ends the data.
  let previous = -1
  for (const end of ends) {
    if (end <= previous) return false
    previous = end
  }
  return previous === data.byteLength
}

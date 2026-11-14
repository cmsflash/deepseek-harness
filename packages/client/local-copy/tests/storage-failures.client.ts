/** Real IndexedDB storage failures injected into fake-indexeddb for store and downloader specs. */

import { forceCloseDatabase, IDBCursor, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { vi } from 'vitest'

/** One chunk row the store writes. */
export interface WrittenChunk {
  readonly sessionId: string
  readonly first: number
}

/** Decides whether one chunk write fails, and with which error. */
export type ChunkWriteFailure = (chunk: WrittenChunk) => Error | undefined

/** One queued record write: its object store and the value it stores. */
export interface QueuedWrite {
  readonly store: string
  readonly value: unknown
}

/** A quota error the way a browser raises it. */
export function quotaError(): DOMException {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError')
}

/**
 * Read the chunk fields one written value carries.
 * @param value - a written row.
 * @returns the chunk fields, or `undefined` for other rows.
 */
export function chunkOf(value: unknown): WrittenChunk | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const sessionId: unknown = Reflect.get(value, 'sessionId')
  const first: unknown = Reflect.get(value, 'first')
  if (typeof sessionId !== 'string' || typeof first !== 'number' || !('data' in value)) return undefined
  return { sessionId, first }
}

/** A browser storage failure that is not a quota failure, as a lost connection raises it. */
export function storageError(): DOMException {
  return new DOMException('Connection to Indexed Database server lost.', 'UnknownError')
}

/**
 * Close a connection the way the browser does on its own, firing its `close` event.
 * @param db - the connection to close.
 */
export function closeByBrowser(db: IDBDatabase): void {
  // fake-indexeddb declares the parameter as the database class, though the function takes a connection.
  Reflect.apply(forceCloseDatabase, undefined, [db])
}

/** The fake's internal object store prototype, which runs every queued record write and read. */
async function rawObjectStorePrototype(): Promise<RawObjectStore> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = new IDBFactory().open('storage-failures')
    request.onupgradeneeded = () => { request.result.createObjectStore('probe') }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('fixture: probe open failed')) }
  })
  const raw: unknown = Reflect.get(db.transaction('probe').objectStore('probe'), '_rawObjectStore')
  db.close()
  if (typeof raw !== 'object' || raw === null) throw new Error('fixture: fake-indexeddb has no raw object store')
  const prototype: unknown = Object.getPrototypeOf(raw)
  if (!writesRecords(prototype)) throw new Error('fixture: fake-indexeddb object stores write no records')
  return prototype
}

/** The fake's internal object store methods these helpers fail. */
interface RawObjectStore {
  storeRecord: (...args: unknown[]) => unknown
  getValue: (...args: unknown[]) => unknown
}

/** Whether a value carries the fake's record write and read methods. */
function writesRecords(value: unknown): value is RawObjectStore {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'storeRecord') === 'function'
    && typeof Reflect.get(value, 'getValue') === 'function'
}

/** Whether a value carries the fake's queued cursor step. */
function stepsCursor(value: unknown): value is { _iterate: (...args: unknown[]) => unknown } {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, '_iterate') === 'function'
}

/**
 * Fail queued single-record reads (`get`) inside the database, so the request
 * errors and the transaction aborts, as a lost connection does.
 * @param fail - decides each read's failure.
 * @returns the restore function.
 */
export async function failRecordReads(fail: () => Error | undefined): Promise<() => void> {
  const prototype = await rawObjectStorePrototype()
  const original = prototype.getValue
  const spy = vi.spyOn(prototype, 'getValue').mockImplementation(function (this: unknown, ...args: unknown[]) {
    const error = fail()
    if (error !== undefined) throw error
    return original.apply(this, args)
  })
  return () => { spy.mockRestore() }
}

/**
 * Fail cursor steps inside the database, so the cursor request errors and the
 * transaction aborts. Cursors opened before the call are not affected.
 * @param fail - decides each step's failure.
 * @returns the restore function.
 */
export function failCursorSteps(fail: () => Error | undefined): () => void {
  const prototype: unknown = IDBCursor.prototype
  if (!stepsCursor(prototype)) throw new Error('fixture: fake-indexeddb cursors have no queued step')
  const original = prototype._iterate
  const spy = vi.spyOn(prototype, '_iterate').mockImplementation(function (this: unknown, ...args: unknown[]) {
    const error = fail()
    if (error !== undefined) throw error
    return original.apply(this, args)
  })
  return () => { spy.mockRestore() }
}

/**
 * Fail queued record writes inside the database, so the request errors and the
 * transaction aborts on its own with `tx.error` set, as a full disk does.
 * @param fail - decides each write's failure.
 * @returns the restore function.
 */
export async function failQueuedWrites(fail: (write: QueuedWrite) => Error | undefined): Promise<() => void> {
  const prototype = await rawObjectStorePrototype()
  const original = prototype.storeRecord
  const spy = vi.spyOn(prototype, 'storeRecord').mockImplementation(function (this: unknown, ...args: unknown[]) {
    const record: unknown = args[0]
    const store: unknown = typeof this === 'object' && this !== null ? Reflect.get(this, 'name') : undefined
    const value: unknown = typeof record === 'object' && record !== null ? Reflect.get(record, 'value') : undefined
    // An abort's rollback restores records without a rollback log; those writes never fail.
    const error = typeof store === 'string' && args[2] !== undefined ? fail({ store, value }) : undefined
    if (error !== undefined) throw error
    return original.apply(this, args)
  })
  return () => { spy.mockRestore() }
}

/**
 * Fail queued chunk writes inside the database (see {@link failQueuedWrites}).
 * @param fail - decides each chunk write's failure.
 * @returns the restore function.
 */
export async function failQueuedChunkWrites(fail: ChunkWriteFailure): Promise<() => void> {
  return await failQueuedWrites(({ value }) => {
    const chunk = chunkOf(value)
    return chunk === undefined ? undefined : fail(chunk)
  })
}

/**
 * Fail chunk `put` calls synchronously, as a browser does for a value it refuses at once.
 * @param fail - decides each chunk put's failure.
 * @returns the restore function.
 */
export function failChunkPuts(fail: ChunkWriteFailure): () => void {
  // oxlint-disable-next-line typescript/unbound-method -- the spy calls it with the spied store as `this`
  const original = IDBObjectStore.prototype.put
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const chunk = chunkOf(value)
    const error = chunk === undefined ? undefined : fail(chunk)
    if (error !== undefined) throw error
    return original.call(this, value, key)
  })
  return () => { spy.mockRestore() }
}

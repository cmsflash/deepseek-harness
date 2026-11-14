/** IndexedDB chunk store of the local copy: writes, races, truncation, compaction, corruption and migration. */

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionChainLink } from '@deepseek-ai/dsh-api-session-controller/types'
import { headerLinkOf, nextLink, toHex } from '../src/client/worker/chain.ts'
import { buildChunkInputs, isQuotaError, LocalCopyStore, type StoredLine } from '../src/client/worker/store.ts'
import {
  closeByBrowser,
  failChunkPuts,
  failCursorSteps,
  failQueuedChunkWrites,
  failQueuedWrites,
  failRecordReads,
  quotaError,
  storageError,
} from './storage-failures.client.ts'

const encoder = new TextEncoder()

/** One fixture session id. */
const sessionId = (n: number): SessionId => brandString<SessionId>(`session-${String(n)}`)

/** Build lines with real chain links over the given header and event texts. */
async function chainedLines(header: string, events: readonly string[], from = 0): Promise<readonly StoredLine[]> {
  const headerLink = await headerLinkOf(encoder.encode(header))
  const lines: StoredLine[] = []
  let previous = headerLink
  for (const [index, text] of events.entries()) {
    const bytes = encoder.encode(text)
    const link = await nextLink(previous, bytes)
    if (index >= from) lines.push({ seq: index, bytes, link })
    previous = link
  }
  return lines
}

let counter = 0

/** One distinguishable header text per use. */
const headerText = (): string => {
  counter += 1
  return `{"version":4,"id":"dsh-${String(counter)}"}`
}

const chunkBytes = 100

/** A fresh store with its backing factory, so tests can act as a second tab. */
function store(): { store: LocalCopyStore; factory: IDBFactory } {
  const factory = new IDBFactory()
  return { store: new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange }), factory }
}

/** Open the local-copy database directly on a factory the store already created. */
function rawDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('dsh-local-copy')
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('fixture: database open failed')) }
  })
}

describe('local copy store', () => {
  it('replaces a whole copy and reads its lines back', async () => {
    const { store: db } = store()
    const header = headerText()
    const headerLink = toHex(await headerLinkOf(encoder.encode(header)))
    const events = ['{"seq":0}', '{"seq":1}', '{"seq":2}']
    const lines = await chainedLines(header, events)
    const record = await db.replaceThread(sessionId(1), header, brandString<SessionChainLink>(headerLink), buildChunkInputs(sessionId(1), lines, chunkBytes), { state: 'complete', complete: true, cursorSeen: 2 })
    expect(record).toMatchObject({ head: 2, complete: true, state: 'complete', chunkCount: 1 })
    expect(record.lineBytes).toBe(lines.reduce((total, line) => total + line.bytes.byteLength + 1, 0) - 1)
    expect(record.headLink).toBe(toHex(lines[2]?.link ?? new Uint8Array(0)))
    const readBack = await db.readLines(sessionId(1), 0, 2)
    expect(readBack.map(line => new TextDecoder().decode(line.bytes))).toEqual(events)
    expect(readBack.map(line => toHex(line.link))).toEqual(lines.map(line => toHex(line.link)))
  })

  it('appends after the verified head and refuses a stale or gapped continuation', async () => {
    const { store: db } = store()
    const header = headerText()
    const headerLink = toHex(await headerLinkOf(encoder.encode(header)))
    await db.replaceThread(sessionId(2), header, brandString<SessionChainLink>(headerLink), buildChunkInputs(sessionId(2), await chainedLines(header, ['{"seq":0}', '{"seq":1}']), chunkBytes), {})
    const record = await (db.readThread(sessionId(2)))
    if (record === undefined) throw new Error('fixture: missing record')
    const seq2 = await chainedLines(header, ['{"seq":0}', '{"seq":1}', '{"seq":2}'], 2)
    // A gapped continuation (first seq 3 against head 1) loses and stores nothing.
    const gapped = await chainedLines(header, ['{"seq":0}', '{"seq":1}', '{"seq":2}', '{"seq":3}'], 2)
    const gappedChunks = buildChunkInputs(sessionId(2), gapped.slice(1), chunkBytes)
    expect(await db.appendChunks(sessionId(2), gappedChunks, { head: record.head, headLink: record.headLink }, {})).toBe(false)
    const baseline = await chainedLines(header, ['{"seq":0}'])
    const seq0Link = baseline[0]?.link
    if (seq0Link === undefined) throw new Error('fixture: missing link')
    // A stale previous (the pre-base head) loses as well.
    const seq2Chunks = buildChunkInputs(sessionId(2), seq2, chunkBytes)
    const staleHead = { head: 0, headLink: brandString<SessionChainLink>(toHex(seq0Link)) }
    expect(await db.appendChunks(sessionId(2), seq2Chunks, staleHead, {})).toBe(false)
    expect(await db.appendChunks(sessionId(2), buildChunkInputs(sessionId(2), seq2, chunkBytes), { head: record.head, headLink: record.headLink }, { cursorSeen: 2, complete: true, state: 'complete' })).toBe(true)
    expect(await db.readThread(sessionId(2))).toMatchObject({ head: 2, complete: true, cursorSeen: 2 })
  })

  it('lets only one of two tabs extend the same copy', async () => {
    const { store: left, factory } = store()
    const right = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    const header = headerText()
    const headerLink = toHex(await headerLinkOf(encoder.encode(header)))
    const base = await chainedLines(header, ['{"seq":0}'])
    const baseLink = brandString<SessionChainLink>(headerLink)
    await left.replaceThread(sessionId(3), header, baseLink, buildChunkInputs(sessionId(3), base, chunkBytes), {})
    const record = await left.readThread(sessionId(3))
    if (record === undefined) throw new Error('fixture: missing record')
    const extension = await chainedLines(header, ['{"seq":0}', '{"seq":1}'], 1)
    // Both tabs verified against the base head; only the first write wins.
    const extensionChunks = buildChunkInputs(sessionId(3), extension, chunkBytes)
    expect(await left.appendChunks(sessionId(3), extensionChunks, { head: record.head, headLink: record.headLink }, {})).toBe(true)
    expect(await right.appendChunks(sessionId(3), extensionChunks, { head: record.head, headLink: record.headLink }, {})).toBe(false)
    const readBack = (await right.readLines(sessionId(3), 0, 5)).map(line => new TextDecoder().decode(line.bytes))
    expect(readBack).toEqual(['{"seq":0}', '{"seq":1}'])
  })

  it('truncates into the boundary chunk and drops everything above', async () => {
    const { store: db } = store()
    const header = headerText()
    const headerLink = toHex(await headerLinkOf(encoder.encode(header)))
    const events = ['{"seq":0}', '{"seq":1}', '{"seq":2}', '{"seq":3}', '{"seq":4}']
    const lines = await chainedLines(header, events)
    await db.replaceThread(sessionId(4), header, brandString<SessionChainLink>(headerLink), buildChunkInputs(sessionId(4), lines, 8), {})
    const truncated = await db.truncateThread(sessionId(4), 2)
    expect(truncated).toMatchObject({ head: 2, headLink: toHex(lines[2]?.link ?? new Uint8Array(0)), state: 'downloading', complete: false })
    expect((await db.readLines(sessionId(4), 0, 4)).map(line => new TextDecoder().decode(line.bytes))).toEqual(events.slice(0, 3))
    expect((await db.readThread(sessionId(4)))?.chunkCount).toBe(3)
    await db.truncateThread(sessionId(4), -1)
    expect(await db.readThread(sessionId(4))).toMatchObject({ head: -1, headLink: null, lineBytes: 0, chunkCount: 0 })
    expect(await db.readLines(sessionId(4), 0, 0)).toEqual([])
  })

  it('stores a chunk truncated in the middle without the bytes it dropped', async () => {
    const { store: db } = store()
    const header = headerText()
    const headerLink = brandString<SessionChainLink>(toHex(await headerLinkOf(encoder.encode(header))))
    const lines = await chainedLines(header, ['{"seq":0}', '{"seq":1}', '{"seq":2}', '{"seq":3}', '{"seq":4}'])
    await db.replaceThread(sessionId(5), header, headerLink, buildChunkInputs(sessionId(5), lines, chunkBytes), {})
    expect(await db.truncateThread(sessionId(5), 1)).toMatchObject({ head: 1, chunkCount: 1, lineBytes: 19 })
    const [boundary] = await db.readChunks(sessionId(5), 0, 1)
    expect(boundary).toMatchObject({ first: 0, last: 1 })
    for (const view of [boundary?.data, boundary?.ends, boundary?.links]) expect(view?.buffer.byteLength).toBe(view?.byteLength)
  })

  it('merges trailing small chunks once they pile past the budget', async () => {
    const { store: db } = store()
    const header = headerText()
    const headerLink = toHex(await headerLinkOf(encoder.encode(header)))
    const events = Array.from({ length: 16 }, (_value, index) => `{"seq":${String(index)}}`)
    const lines = await chainedLines(header, events)
    const firstFour = buildChunkInputs(sessionId(5), lines.slice(0, 4), chunkBytes)
    await db.replaceThread(sessionId(5), header, brandString<SessionChainLink>(headerLink), firstFour, {})
    for (const line of lines.slice(4)) {
      const record = await db.readThread(sessionId(5))
      if (record === undefined) throw new Error('fixture: missing record')
      const lineChunks = buildChunkInputs(sessionId(5), [line], chunkBytes)
      expect(await db.appendChunks(sessionId(5), lineChunks, { head: record.head, headLink: record.headLink }, {})).toBe(true)
    }
    expect((await db.readThread(sessionId(5)))?.chunkCount).toBe(13)
    await db.compactTrailing(sessionId(5), chunkBytes)
    expect((await db.readThread(sessionId(5)))?.chunkCount).toBe(1)
    expect((await db.readLines(sessionId(5), 0, 15)).map(line => new TextDecoder().decode(line.bytes))).toEqual(events)
  })

  it('drops a corrupt copy and reports it for a fresh download', async () => {
    const { store: db, factory } = store()
    const header = headerText()
    const headerLink = toHex(await headerLinkOf(encoder.encode(header)))
    await db.replaceThread(sessionId(6), header, brandString<SessionChainLink>(headerLink), buildChunkInputs(sessionId(6), await chainedLines(header, ['{"seq":0}', '{"seq":1}']), chunkBytes), {})
    const connection = await rawDatabase(factory)
    await new Promise<void>((resolve) => {
      const tx = connection.transaction('chunks', 'readwrite')
      const cursor = tx.objectStore('chunks').openCursor()
      cursor.onsuccess = () => {
        const current = cursor.result
        if (current === null) return
        const value = current.value as { data: Uint8Array; ends: Uint32Array }
        current.update({ ...value, ends: new Uint32Array(9) })
        current.continue()
      }
      tx.oncomplete = () => { resolve() }
    })
    connection.close()
    expect(await db.readLines(sessionId(6), 0, 1)).toEqual([])
    expect(await db.readThread(sessionId(6))).toBeUndefined()
  })

  it('recreates the database when a future version already exists', async () => {
    const factory = new IDBFactory()
    await new Promise<void>((resolve) => {
      const request = factory.open('dsh-local-copy', 7)
      request.onupgradeneeded = () => { request.result.createObjectStore('threads') }
      request.onsuccess = () => { request.result.close(); resolve() }
    })
    const db = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    const header = headerText()
    const headerLink = toHex(await headerLinkOf(encoder.encode(header)))
    const lines = await chainedLines(header, ['{"seq":0}'])
    const sevenChunks = buildChunkInputs(sessionId(7), lines, chunkBytes)
    await db.replaceThread(sessionId(7), header, brandString<SessionChainLink>(headerLink), sevenChunks, {})
    expect(await db.readThread(sessionId(7))).toMatchObject({ head: 0 })
  })

  it('migrates recorded follow keys of the offline replay database', async () => {
    const factory = new IDBFactory()
    const writeIn = (name: string, key: string, value: unknown): Promise<void> =>
      new Promise((resolve) => {
        const request = factory.open(name, 1)
        request.onupgradeneeded = () => { request.result.createObjectStore('records') }
        request.onsuccess = () => {
          const connection = request.result
          const tx = connection.transaction('records', 'readwrite')
          tx.objectStore('records').put(value, key)
          tx.oncomplete = () => { connection.close(); resolve() }
        }
      })
    const follow = (id: string): string =>
      `stream session/follow {"args":{"request":{"address":{"kind":"session","sessionId":"${id}"}}}}`
    await writeIn('dsh-offline-replay', follow('session-8'), {})
    await writeIn('dsh-offline-replay', 'call session/list {}', {})
    const db = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    expect(await db.migrateForeignFollowKeys('dsh-offline-replay', 'records')).toEqual(['session-8'])
    expect(await db.migrateForeignFollowKeys('dsh-offline-replay', 'records')).toEqual([])
    const connection = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('dsh-offline-replay')
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(request.error ?? new Error('fixture')) }
    })
    const remaining = await new Promise<string[]>((resolve, reject) => {
      const tx = connection.transaction('records', 'readonly')
      const keys = tx.objectStore('records').getAllKeys()
      keys.onsuccess = () => { resolve(keys.result as string[]) }
      keys.onerror = () => { reject(new Error('fixture: keys read failed', { cause: keys.error })) }
    })
    connection.close()
    expect(remaining).toEqual(['call session/list {}'])
  })

  it('reports usage and clears everything', async () => {
    const { store: db } = store()
    const header = headerText()
    const headerLink = toHex(await headerLinkOf(encoder.encode(header)))
    for (const index of [1, 2]) {
      const lines = await chainedLines(headerText(), ['{"seq":0}'])
      await db.replaceThread(sessionId(index), header, brandString<SessionChainLink>(headerLink), buildChunkInputs(sessionId(index), lines, chunkBytes), { state: 'complete', complete: true })
    }
    expect(await db.usage()).toMatchObject({ threads: 2, complete: 2, downloading: 0 })
    await db.clear()
    expect(await db.usage()).toMatchObject({ threads: 0, lineBytes: 0 })
  })

  it('reads links of checkpoint seqs from the stored chunks', async () => {
    const { store: db } = store()
    const header = headerText()
    const headerLink = toHex(await headerLinkOf(encoder.encode(header)))
    const events = ['{"seq":0}', '{"seq":1}', '{"seq":2}', '{"seq":3}', '{"seq":4}']
    const lines = await chainedLines(header, events)
    await db.replaceThread(sessionId(9), header, brandString<SessionChainLink>(headerLink), buildChunkInputs(sessionId(9), lines, 3), {})
    const links = await db.readLinks(sessionId(9), [4, 3, 1, 0, 7])
    expect(links).toEqual([lines[4], lines[3], lines[1], lines[0]]
      .map(line => (line === undefined ? undefined : toHex(line.link)))
      .concat([undefined]))
  })
})

describe('local copy store, malformed and foreign data', () => {
  /** One chunk a raw write seeds, with the exact key it goes under. */
  interface RawChunk {
    readonly key: [string, number]
    readonly value: unknown
  }

  /** Write one chunk row and one thread row directly, bypassing the store's own checks. */
  async function seedRaw(
    factory: IDBFactory, thread: Record<string, unknown> | undefined, chunk: RawChunk | undefined, extraChunk?: RawChunk,
  ): Promise<void> {
    const connection = await rawDatabase(factory)
    await new Promise<void>((resolve, reject) => {
      const tx = connection.transaction(['threads', 'chunks'], 'readwrite')
      if (thread !== undefined) tx.objectStore('threads').put(thread, thread['sessionId'] as string)
      if (chunk !== undefined) tx.objectStore('chunks').put(chunk.value, chunk.key)
      if (extraChunk !== undefined) tx.objectStore('chunks').put(extraChunk.value, extraChunk.key)
      tx.oncomplete = () => { resolve() }
      tx.onerror = () => { reject(tx.error ?? new Error('fixture: raw seed failed')) }
    })
    connection.close()
  }

  /** The chunk row `seedRaw` puts under one session's key, open to overrides and a whole-value swap. */
  function chunkSeed(id: string, overrides: Record<string, unknown> = {}, value?: unknown): RawChunk {
    const row = chunkRow({ sessionId: id, ...overrides })
    return { key: [id, row['first'] as number], value: value ?? row }
  }

  /** One minimal but well-formed thread row for raw writes. */
  function threadRow(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      sessionId: 'session-raw',
      chainTag: 'dsh-session-chain/1',
      header: '{"version":4,"id":"raw"}',
      headerLink: 'a'.repeat(64),
      head: 0,
      headLink: 'b'.repeat(64),
      lineBytes: 9,
      chunkCount: 1,
      cursorSeen: 0,
      complete: true,
      state: 'complete',
      openedAt: 0,
      syncedAt: 1,
      activityAt: 0, activitySeq: -1, activityRunning: false,
      ...overrides,
    }
  }

  /** One minimal well-formed chunk row for raw writes. */
  function chunkRow(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      sessionId: 'session-raw',
      first: 0,
      last: 0,
      data: encoder.encode('{"seq":0}'),
      ends: new Uint32Array([9]),
      links: new Uint8Array(32),
      ...overrides,
    }
  }

  it('answers nothing for a thread it does not know', async () => {
    const { store: db } = store()
    const header = headerText()
    const headerLink = toHex(await headerLinkOf(encoder.encode(header)))
    const lines = await chainedLines(header, ['{"seq":0}'])
    await db.replaceThread(sessionId(10), header, brandString<SessionChainLink>(headerLink), buildChunkInputs(sessionId(10), lines, chunkBytes), { state: 'complete', complete: true })
    const untouched = await db.readThread(sessionId(10))
    if (untouched === undefined) throw new Error('fixture: missing record')
    expect(await db.markThread(brandString<SessionId>('session-absent'), { state: 'paused' })).toBeUndefined()
    expect(await db.truncateThread(brandString<SessionId>('session-absent'), 0)).toBeUndefined()
    expect(await db.truncateThread(sessionId(10), untouched.head + 5)).toMatchObject({ head: untouched.head })
    expect((await db.truncateThread(sessionId(10), untouched.head))?.head).toBe(untouched.head)
  })

  it('stores an empty replacement chunk list as an empty copy', async () => {
    const { store: db } = store()
    const header = headerText()
    const headerLink = toHex(await headerLinkOf(encoder.encode(header)))
    const record = await db.replaceThread(sessionId(11), header, brandString<SessionChainLink>(headerLink), [], { cursorSeen: -1 })
    expect(record).toMatchObject({ head: -1, headLink: null, chunkCount: 0, lineBytes: 0, state: 'downloading' })
    expect(await db.appendChunks(sessionId(11), [], { head: -1, headLink: null }, { complete: true, cursorSeen: -1, state: 'complete' })).toBe(true)
    expect(await db.readThread(sessionId(11))).toMatchObject({ head: -1, complete: true })
  })

  it('skips stored thread rows that fail any field check and warns once per drop', async () => {
    const broken: readonly Record<string, unknown>[] = [
      { ...threadRow({}), sessionId: 5 },
      { ...threadRow({}), sessionId: 'session-raw-b2', chainTag: 5 },
      { ...threadRow({}), sessionId: 'session-raw-b3', header: 42 },
      { ...threadRow({}), sessionId: 'session-raw-b4', head: 'zero' },
      { ...threadRow({}), sessionId: 'session-raw-b5', head: -2 },
      { ...threadRow({}), sessionId: 'session-raw-b6', lineBytes: -1 },
      { ...threadRow({}), sessionId: 'session-raw-b7', cursorSeen: 1.5 },
      { ...threadRow({}), sessionId: 'session-raw-b8', complete: 'yes' },
      { ...threadRow({}), sessionId: 'session-raw-b9', state: 'weird' },
      { ...threadRow({}), sessionId: 'session-raw-b10', headerLink: 42 },
      { ...threadRow({}), sessionId: 'session-raw-b11', headLink: 42 },
      { ...threadRow({}), sessionId: 'session-raw-b12', openedAt: 'zero' },
      { ...threadRow({}), sessionId: 'session-raw-b13', problem: 'oops' },
      { ...threadRow({}), sessionId: 'session-raw-b14', problem: { code: 5, at: 1 } },
      { ...threadRow({}), sessionId: 'session-raw-b15', problem: { code: 'quota', at: 1.5 } },
      { ...threadRow({}), sessionId: 'session-raw-b16', activitySeq: undefined },
      { ...threadRow({}), sessionId: 'session-raw-b17', activitySeq: 1.5 },
      { ...threadRow({}), sessionId: 'session-raw-b18', activityRunning: 'no' },
    ]
    const { store: db, factory } = store()
    await db.usage()
    for (const row of broken) await seedRaw(factory, row, undefined)
    const counted = await db.usage()
    expect(counted.threads).toBe(0)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let warnings = -1
    try {
      const gappy = () => ({
        thread: { ...threadRow({}), sessionId: 'session-raw-gap', head: 2, chunkCount: 2 },
        first: chunkSeed('session-raw-gap'),
        second: chunkSeed('session-raw-gap', { first: 2, last: 2 }),
      })
      const round1 = gappy()
      await seedRaw(factory, round1.thread, round1.first, round1.second)
      expect((await db.readLines(brandString<SessionId>('session-raw-gap'), 0, 2)).length).toBe(0)
      const round2 = gappy()
      await seedRaw(factory, round2.thread, round2.first, round2.second)
      expect((await db.readLines(brandString<SessionId>('session-raw-gap'), 0, 2)).length).toBe(0)
      const round3 = gappy()
      await seedRaw(factory, round3.thread, round3.first, round3.second)
      expect((await db.readLines(brandString<SessionId>('session-raw-gap'), 0, 2)).length).toBe(0)
      warnings = warn.mock.calls.length
    } finally {
      warn.mockRestore()
    }
    expect(warnings).toBe(1)
    expect(await db.readThread(brandString<SessionId>('session-raw-gap'))).toBeUndefined()
  })

  it('counts a row whose problem record omits its seq', async () => {
    const { store: db, factory } = store()
    await db.usage()
    await seedRaw(factory, { ...threadRow({}), sessionId: 'session-raw-w-problem', problem: { code: 'quota', at: 7 }, state: 'paused' }, undefined)
    const record = await db.readThread(brandString<SessionId>('session-raw-w-problem'))
    expect(record).toMatchObject({ state: 'paused', problem: { code: 'quota', at: 7 } })
    expect(record?.problem?.seq).toBeUndefined()
    expect(await db.usage()).toMatchObject({ threads: 1, paused: 1 })
  })

  it('drops a copy whose stored chunks fail their invariants', async () => {
    const owner = (overrides: Record<string, unknown>): Record<string, unknown> => chunkRow({ sessionId: 'session-chunkcase', ...overrides })
    const cases: readonly (readonly [number, unknown])[] = [
      [0, 5],
      [0, owner({ sessionId: 'session-other' })],
      [0, owner({ first: 'zero' })],
      [4, owner({ first: 4, last: 2 })],
      [9, owner({ first: 9, last: 9 })],
      [0, owner({ data: 'text' })],
      [0, owner({ ends: new Uint32Array([8]) })],
      [0, owner({ data: encoder.encode('{"seq":0}\n') })],
      [0, owner({ last: 1, ends: new Uint32Array([9, 9]), links: new Uint8Array(64) })],
    ]
    for (const [position, value] of cases) {
      const { store: db, factory } = store()
      const id = brandString<SessionId>('session-chunkcase')
      await db.ensureThread(id, 1)
      await seedRaw(factory, threadRow({ sessionId: 'session-chunkcase', head: 0 }), { key: [id, position], value })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let warned = -1
      try {
        expect(await db.readLines(id, 0, 0)).toEqual([])
        warned = warn.mock.calls.length
      } finally {
        warn.mockRestore()
      }
      expect(warned).toBe(1)
      expect(await db.readThread(id)).toBeUndefined()
    }
  })

  it('drops a copy whose chunks leave a gap, stop below the head, or do not start at seq 0', async () => {
    const second = (id: string, first: number): RawChunk => chunkSeed(id, { first, last: first, data: encoder.encode('{"seq":1}') })
    const cases: readonly (readonly [string, number, RawChunk | undefined, RawChunk | undefined])[] = [
      ['session-gap', 2, chunkSeed('session-gap'), second('session-gap', 2)],
      ['session-short', 1, chunkSeed('session-short'), undefined],
      ['session-late', 1, second('session-late', 1), undefined],
      ['session-order', 1, chunkSeed('session-order', { last: 1, ends: new Uint32Array([9, 9]), links: new Uint8Array(64) }), undefined],
    ]
    for (const [name, head, chunk, extra] of cases) {
      const { store: db, factory } = store()
      const id = brandString<SessionId>(name)
      await db.open()
      await seedRaw(factory, threadRow({ sessionId: name, head }), chunk, extra)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        expect(await db.readLines(id, 1, head), name).toEqual([])
      } finally {
        warn.mockRestore()
      }
      expect(await db.readThread(id), name).toBeUndefined()
    }
  })

  it('reads a late interval from the chunk that covers it, without reading the chunks below', async () => {
    const { store: db, factory } = store()
    const header = headerText()
    const events = Array.from({ length: 30 }, (_value, index) => `{"seq":${String(index)}}`)
    const lines = await chainedLines(header, events)
    const headerLink = brandString<SessionChainLink>(toHex(await headerLinkOf(encoder.encode(header))))
    await db.replaceThread(sessionId(80), header, headerLink, buildChunkInputs(sessionId(80), lines, 25), {})
    const chunks = await db.readChunks(sessionId(80), 21, 24)
    expect(chunks[0]?.first).toBeLessThanOrEqual(21)
    expect(chunks.at(-1)?.last).toBeGreaterThanOrEqual(24)
    expect(chunks.length).toBeLessThanOrEqual(3)
    expect((await db.readLines(sessionId(80), 21, 40)).map(line => line.seq)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29])
    expect(await db.readLines(sessionId(80), 30, 31)).toEqual([])
    expect(await db.readLines(sessionId(80), 5, 4)).toEqual([])
    // Damage the first chunk's value but keep its key: a late read never deserializes it.
    await seedRaw(factory, undefined, chunkSeed('session-80', { data: 'text' }))
    expect((await db.readLines(sessionId(80), 21, 22)).map(line => line.seq)).toEqual([21, 22])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await db.readLines(sessionId(80), 0, 0)).toEqual([])
    } finally {
      warn.mockRestore()
    }
    expect(await db.readThread(sessionId(80))).toBeUndefined()
  })

  it('empties a copy whose chunk below the new head stops short of it', async () => {
    const { store: db, factory } = store()
    const id = brandString<SessionId>('session-truncgap')
    await db.open()
    await seedRaw(factory, threadRow({ sessionId: 'session-truncgap', head: 2 }), chunkSeed('session-truncgap'))
    expect(await db.truncateThread(id, 1)).toMatchObject({ head: -1, headLink: null, chunkCount: 0, lineBytes: 0 })
  })

  it('emptying and stopping are what a truncate against garbage does', async () => {
    const { store: db, factory } = store()
    const id = brandString<SessionId>('session-truncase')
    await db.ensureThread(id, 1)
    await seedRaw(factory, threadRow({ sessionId: 'session-truncase', head: 1 }), chunkSeed('session-truncase', { ends: new Uint32Array(9) }))
    const truncated = await db.truncateThread(id, 0)
    expect(truncated).toMatchObject({ head: -1, headLink: null })
    expect(await db.readLines(id, 0, 1)).toEqual([])
  })

  it('refuses a continuation whose value cannot be cloned, leaving the copy untouched', async () => {
    const { store: db } = store()
    const header = headerText()
    const headerLink = toHex(await headerLinkOf(encoder.encode(header)))
    await db.replaceThread(sessionId(12), header, brandString<SessionChainLink>(headerLink), buildChunkInputs(sessionId(12), await chainedLines(header, ['{"seq":0}']), chunkBytes), {})
    const record = await db.readThread(sessionId(12))
    if (record === undefined) throw new Error('fixture: missing record')
    const more = await chainedLines(header, ['{"seq":0}', '{"seq":1}'], 1)
    const chunks = buildChunkInputs(sessionId(12), more, chunkBytes)
    const sneaky = chunks[0] as { note?: () => void }
    sneaky.note = () => {}
    await expect(db.appendChunks(sessionId(12), chunks, { head: record.head, headLink: record.headLink }, {})).rejects.toThrow('local copy: transaction aborted')
    expect(await db.readThread(sessionId(12))).toMatchObject({ head: 0 })
    expect((await db.readLines(sessionId(12), 0, 1)).map(line => new TextDecoder().decode(line.bytes))).toEqual(['{"seq":0}'])
  })

  it('recreates behind a future version once the blocking connection leaves', async () => {
    const factory = new IDBFactory()
    await new Promise<void>((resolve) => {
      const request = factory.open('dsh-local-copy', 7)
      request.onupgradeneeded = () => { request.result.createObjectStore('threads') }
      request.onsuccess = () => { request.result.close(); resolve() }
    })
    const held = await new Promise<IDBDatabase>((resolve) => {
      const request = factory.open('dsh-local-copy')
      request.onsuccess = () => { resolve(request.result) }
    })
    const db = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    const pending = db.readThread(brandString<SessionId>('session-held'))
    for (let round = 0; round < 20; round++) await new Promise<void>((resolve) => { setImmediate(resolve) })
    held.close()
    expect(await pending).toBeUndefined()
    expect(await db.usage()).toMatchObject({ threads: 0 })
  })

  it('compaction leaves an empty copy alone, stops at a big or gapped tail, and keeps the record', async () => {
    const { store: db, factory } = store()
    const empty = brandString<SessionId>('session-compact-empty')
    await db.ensureThread(empty, 1)
    await db.compactTrailing(empty, chunkBytes)
    expect(await db.readThread(empty)).toMatchObject({ head: -1 })
    await db.compactTrailing(brandString<SessionId>('session-absent'), chunkBytes)

    const big = brandString<SessionId>('session-compact-big')
    const bigLine = `{"big":"${'x'.repeat(70_000)}"}`
    await db.replaceThread(big, '{"version":4,"id":"big"}', brandString<SessionChainLink>(toHex(await headerLinkOf(encoder.encode('{"version":4,"id":"big"}')))), buildChunkInputs(big, [{ seq: 0, bytes: encoder.encode(bigLine), link: new Uint8Array(32) }], 1_048_576), {})
    await db.compactTrailing(big, chunkBytes)
    expect((await db.readThread(big))?.chunkCount).toBe(1)

    const gapped = brandString<SessionId>('session-compact-gap')
    await db.ensureThread(gapped, 1)
    const first = chunkSeed('session-compact-gap', { data: new Uint8Array(60), ends: new Uint32Array([60]) })
    const second = chunkSeed('session-compact-gap', { first: 2, last: 2, data: new Uint8Array(60), ends: new Uint32Array([60]) })
    await seedRaw(factory, threadRow({ sessionId: 'session-compact-gap', head: 2, chunkCount: 2 }), first, second)
    await db.compactTrailing(gapped, 100)
    expect(await db.readThread(gapped)).toMatchObject({ head: 2, chunkCount: 2 })

    const corrupted = brandString<SessionId>('session-compact-corrupt')
    await db.ensureThread(corrupted, 1)
    const broken = chunkSeed('session-compact-corrupt', { ends: new Uint32Array(9) })
    await seedRaw(factory, threadRow({ sessionId: 'session-compact-corrupt', head: 0 }), broken)
    await db.compactTrailing(corrupted, chunkBytes)
    expect(await db.readThread(corrupted)).toMatchObject({ head: 0, chunkCount: 1 })
  })

  it('refreshes the open time on every open', async () => {
    const { store: db } = store()
    const id = brandString<SessionId>('session-reopen')
    await db.ensureThread(id, 100)
    expect(await db.readThread(id)).toMatchObject({ openedAt: 100 })
    await db.ensureThread(id, 250)
    expect((await db.readThread(id))?.openedAt).toBe(250)
    await db.ensureThread(id, 0)
    expect((await db.readThread(id))?.openedAt).toBe(250)
  })

  it('keeps the recorded list activity across a replacement that reports none', async () => {
    const { store: db } = store()
    const id = brandString<SessionId>('session-activity')
    const header = headerText()
    const headerLink = brandString<SessionChainLink>(toHex(await headerLinkOf(encoder.encode(header))))
    expect(await db.ensureThread(id, 0)).toMatchObject({ activityAt: 0, activitySeq: -1, activityRunning: false })
    await db.replaceThread(id, header, headerLink, [], { activityAt: 5, activitySeq: 7, activityRunning: true })
    expect(await db.replaceThread(id, header, headerLink, [], {})).toMatchObject({ activityAt: 5, activitySeq: 7, activityRunning: true })
  })

  it('patches the fields only a session-list sync would carry', async () => {
    const { store: db } = store()
    const id = brandString<SessionId>('session-patched')
    await db.ensureThread(id, 1)
    expect(await db.markThread(id, { state: 'paused', problem: { code: 'lines-unavailable', at: 3 }, openedAt: 77, activityAt: 88, cursorSeen: 9, complete: false })).toMatchObject({
      state: 'paused', problem: { code: 'lines-unavailable', at: 3 }, openedAt: 77, activityAt: 88, cursorSeen: 9,
    })
    expect(await db.markThread(id, { problem: null, openedAt: 99, activityAt: 111, cursorSeen: 12 })).toMatchObject({
      state: 'paused', openedAt: 99, activityAt: 111, cursorSeen: 12,
    })
    expect(await db.markThread(id, { activitySeq: 40, activityRunning: true }))
      .toMatchObject({ activityAt: 111, activitySeq: 40, activityRunning: true })
  })

  it('ignores recorded follow keys the migration cannot read an address from', async () => {
    const factory = new IDBFactory()
    const writeFollow = (key: string): Promise<void> => new Promise((resolve) => {
      const request = factory.open('dsh-offline-replay', 1)
      request.onupgradeneeded = () => { request.result.createObjectStore('records') }
      request.onsuccess = () => {
        const connection = request.result
        const tx = connection.transaction('records', 'readwrite')
        tx.objectStore('records').put({}, key)
        tx.oncomplete = () => { connection.close(); resolve() }
      }
    })
    for (const key of [
      'stream session/follow not json',
      'stream session/follow 42',
      'stream session/follow {}',
      'stream session/follow {"args":{"request":5}}',
      'stream session/follow {"args":{"request":{"address":7}}}',
      'stream session/follow {"args":{"request":{"address":{"kind":"other"}}}}',
      'stream session/follow {"args":{"request":{"address":{"kind":"session"}}}}',
      'stream session/follow {"args":{"request":{"address":{"kind":"session","sessionId":9}}}}',
      'call session/list {}',
    ]) {
      await writeFollow(key)
    }
    const db = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    expect(await db.migrateForeignFollowKeys('dsh-offline-replay', 'records')).toEqual([])
    const connection = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('dsh-offline-replay')
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(request.error ?? new Error('fixture')) }
    })
    const remaining = await new Promise<number>((resolve, reject) => {
      const tx = connection.transaction('records', 'readonly')
      const count = tx.objectStore('records').count()
      count.onsuccess = () => { resolve(count.result) }
      count.onerror = () => { reject(new Error('fixture: count failed', { cause: count.error })) }
    })
    connection.close()
    expect(remaining).toBe(1)
  })
})

describe('local copy store, storage failures', () => {
  /** A stored two-line copy plus the lines that would extend it. */
  type Seeded = { db: LocalCopyStore; header: string; headerLink: SessionChainLink; more: readonly StoredLine[] }
  async function seeded(id: SessionId): Promise<Seeded> {
    const { store: db } = store()
    const header = headerText()
    const headerLink = brandString<SessionChainLink>(toHex(await headerLinkOf(encoder.encode(header))))
    const events = ['{"seq":0}', '{"seq":1}', '{"seq":2}']
    await db.replaceThread(id, header, headerLink, buildChunkInputs(id, await chainedLines(header, events.slice(0, 2)), chunkBytes), {})
    return { db, header, headerLink, more: await chainedLines(header, events, 2) }
  }

  /** Read back what one copy stores. */
  async function stored(db: LocalCopyStore, id: SessionId): Promise<unknown> {
    const record = await db.readThread(id)
    const lines = (await db.readLines(id, 0, 9)).map(line => new TextDecoder().decode(line.bytes))
    return { head: record?.head, chunkCount: record?.chunkCount, lineBytes: record?.lineBytes, lines }
  }

  it('reports a quota abort raised inside the database as a quota failure and keeps the copy', async () => {
    const id = sessionId(70)
    const { db, header, headerLink, more } = await seeded(id)
    const before = await stored(db, id)
    const restore = await failQueuedChunkWrites(() => quotaError())
    let failure: unknown
    try {
      const all = await chainedLines(header, ['{"seq":0}', '{"seq":1}', '{"seq":2}'])
      failure = await db.replaceThread(id, header, headerLink, buildChunkInputs(id, all, chunkBytes), {}).catch((error: unknown) => error)
    } finally {
      restore()
    }
    expect(isQuotaError(failure)).toBe(true)
    expect((failure as Error).cause).toMatchObject({ name: 'QuotaExceededError' })
    expect(await stored(db, id)).toEqual(before)
    expect(more).toHaveLength(1)
  })

  it('reports a put the browser refuses for quota as a quota failure and keeps the copy', async () => {
    const id = sessionId(71)
    const { db, more } = await seeded(id)
    const before = await stored(db, id)
    const record = await db.readThread(id)
    if (record === undefined) throw new Error('fixture: missing record')
    const restore = failChunkPuts(() => quotaError())
    let failure: unknown
    try {
      failure = await db.appendChunks(id, buildChunkInputs(id, more, chunkBytes), record, {}).catch((error: unknown) => error)
    } finally {
      restore()
    }
    expect(isQuotaError(failure)).toBe(true)
    expect(await stored(db, id)).toEqual(before)
  })

  it('reports a failed awaited record write once, through the request that failed', async () => {
    const id = sessionId(72)
    const { db } = await seeded(id)
    const restore = await failQueuedWrites(({ store: name }) => name === 'threads' ? quotaError() : undefined)
    let failure: unknown
    try {
      failure = await db.markThread(id, { state: 'paused' }).catch((error: unknown) => error)
    } finally {
      restore()
    }
    expect(isQuotaError(failure)).toBe(true)
    expect(await db.readThread(id)).toMatchObject({ state: 'downloading' })
  })

  it('rejects reads and writes whose cursor or record read fails, with the failing request as the cause', async () => {
    const id = sessionId(73)
    const { db } = await seeded(id)
    const before = await stored(db, id)
    const failures: unknown[] = []
    const restoreCursors = failCursorSteps(() => storageError())
    try {
      failures.push(
        await db.readLines(id, 0, 9).catch((error: unknown) => error),
        await db.deleteThread(id).catch((error: unknown) => error),
        await db.truncateThread(id, 0).catch((error: unknown) => error),
      )
    } finally {
      restoreCursors()
    }
    const restoreReads = await failRecordReads(() => storageError())
    try {
      failures.push(await db.readMeta('migratedOfflineReplay').catch((error: unknown) => error))
    } finally {
      restoreReads()
    }
    expect(failures.map(causes)).toEqual([
      ['Error: local copy: transaction aborted', 'Error: local copy: IndexedDB request failed', 'UnknownError: Connection to Indexed Database server lost.'],
      ['Error: local copy: transaction aborted', 'Error: local copy: IndexedDB cursor failed', 'UnknownError: Connection to Indexed Database server lost.'],
      ['Error: local copy: transaction aborted', 'Error: local copy: IndexedDB cursor failed', 'UnknownError: Connection to Indexed Database server lost.'],
      ['Error: local copy: transaction aborted', 'Error: local copy: IndexedDB request failed', 'UnknownError: Connection to Indexed Database server lost.'],
    ])
    expect(await stored(db, id)).toEqual(before)
  })

  it('tells a quota failure from any other failure', () => {
    expect(isQuotaError(quotaError())).toBe(true)
    expect(isQuotaError(new Error('local copy: transaction aborted', { cause: quotaError() }))).toBe(true)
    expect(isQuotaError(new Error('local copy: transaction aborted', { cause: new DOMException('no', 'AbortError') }))).toBe(false)
    expect(isQuotaError(new Error('local copy: transaction aborted', { cause: 'QuotaExceededError' }))).toBe(false)
    expect(isQuotaError('QuotaExceededError')).toBe(false)
  })
})

describe('local copy store, lost connections', () => {
  /** Record every connection the store opens on its factory; `close` also closes each on arrival. */
  function connections(factory: IDBFactory, close = false): IDBDatabase[] {
    const opened: IDBDatabase[] = []
    const open = factory.open.bind(factory)
    factory.open = (name: string, version?: number): IDBOpenDBRequest => {
      const request = open(name, version)
      request.addEventListener('success', () => {
        opened.push(request.result)
        if (close) request.result.close()
      })
      return request
    }
    return opened
  }

  it('reopens the database after the browser closes the connection', async () => {
    const { store: db, factory } = store()
    const opened = connections(factory)
    const id = sessionId(80)
    await db.ensureThread(id, 5)
    closeByBrowser(opened[0]!)
    expect(await db.readThread(id)).toMatchObject({ openedAt: 5 })
    expect(opened).toHaveLength(2)
  })

  it('closes its connection for a newer schema and opens again afterwards', async () => {
    const { store: db, factory } = store()
    const id = sessionId(81)
    await db.ensureThread(id, 5)
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('dsh-local-copy', 2)
      request.onsuccess = () => { resolve(request.result) }
      request.onblocked = () => { reject(new Error('fixture: the store kept its connection open')) }
    })
    upgraded.close()
    expect(await db.readThread(id)).toBeUndefined()
    await db.ensureThread(id, 6)
    expect(await db.readThread(id)).toMatchObject({ openedAt: 6 })
  })

  it('replaces a connection the browser closed without an event, once', async () => {
    const { store: db, factory } = store()
    const opened = connections(factory)
    const id = sessionId(82)
    await db.ensureThread(id, 5)
    opened[0]!.close()
    expect(await db.readThread(id)).toMatchObject({ openedAt: 5 })
    expect(opened).toHaveLength(2)
    closeByBrowser(opened[0]!)
    expect(await db.readThread(id)).toMatchObject({ openedAt: 5 })
    expect(opened).toHaveLength(2)

    const closing = store()
    const refused = connections(closing.factory, true)
    await expect(closing.store.readThread(id)).rejects.toMatchObject({ name: 'InvalidStateError' })
    expect(refused).toHaveLength(2)
  })

  it('reports a transaction failure other than a closed connection without reopening', async () => {
    const { store: db, factory } = store()
    const opened = connections(factory)
    await db.open()
    opened[0]!.transaction = () => { throw new TypeError('fixture: no such store') }
    await expect(db.readThread(sessionId(83))).rejects.toThrow('fixture: no such store')
    expect(opened).toHaveLength(1)
  })

  it('opens again after a failed open instead of keeping the failure', async () => {
    const factory = new IDBFactory()
    const open = factory.open.bind(factory)
    let refuse = true
    factory.open = (name: string, version?: number): IDBOpenDBRequest => {
      if (!refuse) return open(name, version)
      refuse = false
      throw storageError()
    }
    const db = new LocalCopyStore({ indexedDB: factory, keyRange: IDBKeyRange })
    await expect(db.readThread(sessionId(84))).rejects.toMatchObject({ name: 'UnknownError' })
    expect(await db.readThread(sessionId(84))).toBeUndefined()
  })
})

/** `name: message` of an error and each error in its `cause` chain. */
function causes(error: unknown): string[] {
  const chain: string[] = []
  for (let current = error; current instanceof Error; current = current.cause) chain.push(`${current.name}: ${current.message}`)
  return chain
}

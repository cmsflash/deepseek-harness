import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { SpeechCacheStore } from '@deepseek-ai/dsh-speech-cache'

const DAY_MS = 86_400_000
const created: string[] = []

async function makeStore(ttlMs = 7 * DAY_MS): Promise<{ store: SpeechCacheStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-speech-'))
  created.push(dir)
  return { store: new SpeechCacheStore(join(dir, 'speech'), ttlMs), dir }
}

/** Backdate a file so age-based expiry can be exercised without waiting. */
async function backdate(path: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs)
  await utimes(path, when, when)
}

afterEach(() => { created.length = 0 })

describe('SpeechCacheStore', () => {
  it('round-trips audio bytes', async () => {
    const { store } = await makeStore()
    const data = new Uint8Array([1, 2, 3, 4])
    await store.write(MessageId('m1'), data)
    const read = await store.read(MessageId('m1'))
    expect(read?.data).toEqual(data)
    expect(read?.mediaType).toBe('audio/mpeg')
  })

  it('misses on an unknown message', async () => {
    const { store } = await makeStore()
    await expect(store.read(MessageId('absent'))).resolves.toBeUndefined()
  })

  it('encodes ids that are not filesystem-safe', async () => {
    const { store } = await makeStore()
    const id = MessageId('a/b c:d')
    await store.write(id, new Uint8Array([9]))
    expect((await store.read(id))?.data).toEqual(new Uint8Array([9]))
  })

  it('treats an entry past the retention window as a miss', async () => {
    const { store, dir } = await makeStore(DAY_MS)
    await store.write(MessageId('old'), new Uint8Array([1]))
    await backdate(join(dir, 'speech', 'old.mp3'), 2 * DAY_MS)
    await expect(store.read(MessageId('old'))).resolves.toBeUndefined()
  })

  it('replaces an existing artifact on rewrite', async () => {
    const { store } = await makeStore()
    await store.write(MessageId('m1'), new Uint8Array([1]))
    await store.write(MessageId('m1'), new Uint8Array([2, 2]))
    expect((await store.read(MessageId('m1')))?.data).toEqual(new Uint8Array([2, 2]))
  })

  it('leaves no staging files behind', async () => {
    const { store, dir } = await makeStore()
    await store.write(MessageId('m1'), new Uint8Array([1]))
    const entries = await readdir(join(dir, 'speech'))
    expect(entries).toEqual(['m1.mp3'])
  })

  it('sweeps only expired artifacts', async () => {
    const { store, dir } = await makeStore(DAY_MS)
    await store.write(MessageId('fresh'), new Uint8Array([1]))
    await store.write(MessageId('stale'), new Uint8Array([1]))
    await backdate(join(dir, 'speech', 'stale.mp3'), 3 * DAY_MS)
    await expect(store.sweep()).resolves.toBe(1)
    expect(await readdir(join(dir, 'speech'))).toEqual(['fresh.mp3'])
  })

  it('ignores unrelated files while sweeping', async () => {
    const { store, dir } = await makeStore(DAY_MS)
    await store.write(MessageId('stale'), new Uint8Array([1]))
    const other = join(dir, 'speech', 'notes.txt')
    await writeFile(other, 'keep me')
    await backdate(join(dir, 'speech', 'stale.mp3'), 3 * DAY_MS)
    await backdate(other, 3 * DAY_MS)
    await expect(store.sweep()).resolves.toBe(1)
    expect(await readdir(join(dir, 'speech'))).toEqual(['notes.txt'])
  })

  it('sweeps a directory that does not exist yet without failing', async () => {
    const { store } = await makeStore()
    await expect(store.sweep()).resolves.toBe(0)
  })
})

describe('SpeechCacheStore failure paths', () => {
  it('treats an unreadable artifact as a miss', async () => {
    const { store, dir } = await makeStore()
    await store.write(MessageId('m1'), new Uint8Array([1]))
    // A file replaced by a directory cannot be read, standing in for any
    // read failure between the stat and the read.
    await rm(join(dir, 'speech', 'm1.mp3'))
    await mkdir(join(dir, 'speech', 'm1.mp3'))
    await expect(store.read(MessageId('m1'))).resolves.toBeUndefined()
  })

  it('removes the staging file when publication fails', async () => {
    const { store, dir } = await makeStore()
    // A directory at the target path makes rename fail after staging is written.
    await mkdir(join(dir, 'speech'), { recursive: true })
    await mkdir(join(dir, 'speech', 'm1.mp3'), { recursive: true })
    await mkdir(join(dir, 'speech', 'm1.mp3', 'child'), { recursive: true })
    await expect(store.write(MessageId('m1'), new Uint8Array([1]))).rejects.toThrow()
    const remaining = await readdir(join(dir, 'speech'))
    expect(remaining.filter(entry => entry.endsWith('.tmp'))).toEqual([])
  })

  it('skips a listed entry whose target no longer exists', async () => {
    const { store, dir } = await makeStore(DAY_MS)
    await store.write(MessageId('gone'), new Uint8Array([1]))
    await backdate(join(dir, 'speech', 'gone.mp3'), 3 * DAY_MS)
    // A dangling symlink is listed but cannot be stat'ed, exactly like an
    // artifact removed between the listing and the stat.
    await symlink(join(dir, 'speech', 'missing-target'), join(dir, 'speech', 'vanished.mp3'))
    await expect(store.sweep()).resolves.toBe(1)
  })

  it('counts only the artifacts it actually removed', async () => {
    const { store, dir } = await makeStore(DAY_MS)
    await store.write(MessageId('stale'), new Uint8Array([1]))
    await backdate(join(dir, 'speech', 'stale.mp3'), 3 * DAY_MS)
    // A directory named like an artifact cannot be unlinked, so the sweep
    // reports it as not removed rather than failing the whole pass.
    await mkdir(join(dir, 'speech', 'blocked.mp3'), { recursive: true })
    await mkdir(join(dir, 'speech', 'blocked.mp3', 'child'), { recursive: true })
    await backdate(join(dir, 'speech', 'blocked.mp3'), 3 * DAY_MS)
    await expect(store.sweep()).resolves.toBe(1)
  })
})

/**
 * Filesystem store for synthesized audio: a regenerable cache keyed by message
 * identity, swept by age. Nothing here is durable Session state — a miss is an
 * ordinary outcome that the caller resolves by synthesizing again.
 * @module @deepseek-ai/dsh-read-aloud/store
 */

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'

/** File extension for every stored artifact; the seam requests mp3 throughout. */
const EXTENSION = '.mp3'

/** Audio bytes retrieved from the cache. */
export interface CachedAudio {
  /** Encoded audio bytes. */
  readonly data: Uint8Array
  /** Container format of {@link CachedAudio.data}. */
  readonly mediaType: 'audio/mpeg'
}

/**
 * Age-swept audio cache over one directory.
 *
 * A message id is opaque and may not be filesystem-safe, so every key is
 * percent-encoded before it becomes a file name.
 */
export class ReadAloudStore {
  constructor(private readonly directory: string, private readonly ttlMs: number) {}

  /** Resolve one message id to its artifact path. */
  private pathFor(messageId: MessageId): string {
    return join(this.directory, `${encodeURIComponent(messageId)}${EXTENSION}`)
  }

  /**
   * Read one cached artifact.
   * @param messageId - the message whose audio is wanted.
   * @returns the audio, or `undefined` on a miss or an expired entry.
   */
  async read(messageId: MessageId): Promise<CachedAudio | undefined> {
    const path = this.pathFor(messageId)
    const stats = await stat(path).catch(() => undefined)
    if (stats === undefined) return undefined
    if (Date.now() - stats.mtimeMs > this.ttlMs) return undefined
    const data = await readFile(path).catch(() => undefined)
    return data === undefined ? undefined : { data: new Uint8Array(data), mediaType: 'audio/mpeg' }
  }

  /**
   * Publish one artifact atomically, so a concurrent read never observes a
   * partially written file.
   * @param messageId - the message the audio belongs to.
   * @param data - encoded audio bytes.
   */
  async write(messageId: MessageId, data: Uint8Array): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const staging = join(this.directory, `.${randomUUID()}.tmp`)
    await writeFile(staging, data, { mode: 0o600 })
    await rename(staging, this.pathFor(messageId)).catch(async (cause: unknown) => {
      /* v8 ignore next -- the staging file exists whenever rename fails, so the
         cleanup rejection arm needs the file to vanish mid-operation. */
      await unlink(staging).catch(() => {})
      throw cause
    })
  }

  /**
   * Delete every artifact older than the retention window.
   * @returns the number of files removed.
   */
  async sweep(): Promise<number> {
    const entries = await readdir(this.directory).catch(() => undefined)
    if (entries === undefined) return 0
    const cutoff = Date.now() - this.ttlMs
    let removed = 0
    for (const entry of entries) {
      if (!entry.endsWith(EXTENSION)) continue
      const path = join(this.directory, entry)
      const stats = await stat(path).catch(() => undefined)
      if (stats === undefined || stats.mtimeMs >= cutoff) continue
      // A file removed by another sweep or by the user is already the wanted
      // state, so a failed unlink is not an error worth propagating.
      const gone = await unlink(path).then(() => true).catch(() => false)
      if (gone) removed += 1
    }
    return removed
  }
}

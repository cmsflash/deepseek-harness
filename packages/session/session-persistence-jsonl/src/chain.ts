/**
 * The JSONL backend's builder of the Session log chain: SHA-256 links over the
 * exact stored bytes of one log generation's lines, indexed by event seq. The
 * write path links each accepted event's encoded line here, and the scanner
 * links each committed row's raw bytes here, so both agree with the file.
 * @module
 */

import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  materializeAppendBatch,
  SESSION_LOG_CHAIN_TAG,
  SessionLogLink,
  type SessionLogChain,
} from '@deepseek-ai/dsh-session-persistence'
import { encodeEventLine } from './format.ts'

/** One link's digest size in bytes. */
const LINK_BYTES = 32
/** Initial and minimum link capacity, in links. */
const INITIAL_CAPACITY = 64

/**
 * Validate one append batch and encode it to the exact lines the write path
 * stores, so the write handle's `append` and {@link SessionLogChainBuilder.extend}
 * cannot diverge.
 * @param events - the caller's batch.
 * @returns the detached, validated batch's encoded lines.
 * @throws {TypeError} when any event data is not losslessly JSON-serializable.
 */
export function encodeAppendLines(events: readonly SessionEvent[]): Buffer[] {
  return materializeAppendBatch(events).map(encodeEventLine)
}

/**
 * One log generation's links under construction: the fixed header link plus a
 * packed buffer of event links. A write handle extends a private copy; the
 * memo, read handles, and session-query share one compacted builder.
 */
export class SessionLogChainBuilder implements SessionLogChain {
  private head: Buffer
  private links: Buffer
  private count: number

  private constructor(head: Buffer) {
    this.head = head
    this.links = Buffer.alloc(INITIAL_CAPACITY * LINK_BYTES)
    this.count = 0
  }

  /**
   * Start a chain from the stored bytes of the log's header line.
   * @param headerLine - the header record without its newline.
   * @returns a chain with no linked events.
   */
  static start(headerLine: Uint8Array): SessionLogChainBuilder {
    return new SessionLogChainBuilder(
      createHash('sha256').update(SESSION_LOG_CHAIN_TAG, 'utf8').update(headerLine).digest(),
    )
  }

  /** Number of linked events. */
  get length(): number {
    return this.count
  }

  /**
   * Read one event's link.
   * @param seq - event position in the log.
   * @returns the link, or `undefined` when the chain does not cover `seq`.
   */
  linkAt(seq: number): SessionLogLink | undefined {
    if (seq < 0 || seq >= this.count) return undefined
    return SessionLogLink(this.links.toString('hex', seq * LINK_BYTES, (seq + 1) * LINK_BYTES))
  }

  /**
   * Link one stored line onto the chain.
   * @param seq - the event's position; must equal the current length.
   * @param line - the event's stored line without its newline.
   * @returns whether the event was linked; `false` when `seq` does not
   *   continue the chain, which leaves the chain stopped at its current length.
   */
  append(seq: number, line: Uint8Array): boolean {
    if (seq !== this.count) return false
    const previous = this.count === 0
      ? this.head
      : this.links.subarray((this.count - 1) * LINK_BYTES, this.count * LINK_BYTES)
    const digest = createHash('sha256').update(previous).update(line).digest()
    if (this.count * LINK_BYTES === this.links.length) {
      const grown = Buffer.alloc(Math.max(this.links.length * 2, INITIAL_CAPACITY * LINK_BYTES))
      this.links.copy(grown, 0)
      this.links = grown
    }
    digest.copy(this.links, this.count * LINK_BYTES)
    this.count += 1
    return true
  }

  /**
   * Withdraw links from `length` on; earlier links are kept.
   * @param length - the length the chain is reduced to at most.
   */
  truncate(length: number): void {
    this.count = Math.min(this.count, Math.max(0, length))
  }

  /** Release spare capacity so the packed links occupy exactly 32 bytes per linked event. */
  compact(): void {
    this.links = Buffer.from(this.links.subarray(0, this.count * LINK_BYTES))
  }

  /**
   * Clone this chain for a writer to extend independently.
   * @returns a builder holding the same links with room to grow.
   */
  copy(): SessionLogChainBuilder {
    const clone = new SessionLogChainBuilder(this.head)
    clone.links = Buffer.alloc((this.count + INITIAL_CAPACITY) * LINK_BYTES)
    this.links.copy(clone.links, 0, 0, this.count * LINK_BYTES)
    clone.count = this.count
    return clone
  }

  /**
   * Link events that would continue this chain, encoded exactly as the write
   * path encodes appended events, without changing this chain.
   * @param events - events whose seqs continue at `length`, in order.
   * @returns a chain that also covers `events`, or `undefined` when an event
   *   does not continue the chain or cannot be encoded.
   */
  extend(events: readonly SessionEvent[]): SessionLogChain | undefined {
    if (events.length === 0) return this
    const base = this.count
    for (const [index, event] of events.entries()) {
      if (event.seq !== base + index) return undefined
    }
    let lines: Buffer[]
    try {
      lines = encodeAppendLines(events)
    } catch (_error: unknown) {
      // A batch the backend could not encode cannot become stored lines, so it
      // has no links to extend the chain with.
      return undefined
    }
    const appended = Buffer.alloc(events.length * LINK_BYTES)
    let previous: Uint8Array = base === 0
      ? this.head
      : this.links.subarray((base - 1) * LINK_BYTES, base * LINK_BYTES)
    for (const [index, line] of lines.entries()) {
      const digest = createHash('sha256').update(previous).update(line).digest()
      digest.copy(appended, index * LINK_BYTES)
      previous = digest
    }
    return {
      length: base + lines.length,
      linkAt: (seq: number): SessionLogLink | undefined => {
        if (seq < base) return this.linkAt(seq)
        if (seq >= base + lines.length) return undefined
        return SessionLogLink(appended.toString('hex', (seq - base) * LINK_BYTES, (seq - base + 1) * LINK_BYTES))
      },
    }
  }
}

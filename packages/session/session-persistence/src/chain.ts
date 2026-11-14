/**
 * The Session log chain: SHA-256 links over the exact stored bytes of one log
 * generation's lines. A link covers the header line and every event line
 * through its event, so equal links identify byte-identical log prefixes.
 * @module @deepseek-ai/dsh-session-persistence/chain
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Tag hashed before the header line. The header link is
 * `SHA-256(tag ‖ headerLine)`; the link of the event at seq `n` is
 * `SHA-256(link(n - 1) ‖ line(n))`, where `link(-1)` is the header link, a
 * previous link enters as its 32 raw bytes, and a line is the stored UTF-8
 * bytes of one JSONL record without its newline.
 */
export const SESSION_LOG_CHAIN_TAG = 'dsh-session-chain/1'

/** One event's chain link: 64 lowercase hexadecimal characters. */
export type SessionLogLink = Branded<'SessionLogLink'>

/**
 * Brand a backend-computed chain link for the provider-neutral persistence contract.
 * @param value - 64 lowercase hexadecimal characters.
 * @returns the same runtime string with chain-link identity.
 */
export function SessionLogLink(value: string): SessionLogLink {
  return value as SessionLogLink
}

/** Links over the stored lines of one log generation, indexed by event seq. */
export interface SessionLogChain {
  /** Number of linked events: `linkAt` answers for seqs `0` through `length - 1`. */
  readonly length: number
  /**
   * Read one event's link.
   * @param seq - event position in the log.
   * @returns the link, or `undefined` when the chain does not cover `seq`.
   */
  linkAt(seq: number): SessionLogLink | undefined
  /**
   * Link events that would continue this chain, encoded exactly as this
   * backend's write path encodes appended events, without changing this chain.
   * @param events - events whose seqs continue at `length`, in order.
   * @returns a chain that also covers `events`, or `undefined` when an event
   *   does not continue the chain or cannot be encoded.
   */
  extend?(events: readonly SessionEvent[]): SessionLogChain | undefined
  /** Stored header line, without its newline, that the chain starts from; absent when the backend does not keep it. */
  readonly headerLine?: Uint8Array
  /**
   * Return one covered event's stored line: this backend's encoding of `event`,
   * only when its bytes hash to the chain's link at `event.seq`.
   * @param event - an event whose seq this chain covers.
   * @returns the line bytes without the newline, or `undefined` when the seq is not covered or the encoding differs from the stored bytes.
   */
  storedLine?(event: SessionEvent): Uint8Array | undefined
}

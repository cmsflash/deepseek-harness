/** Session log chain arithmetic over WebCrypto (see `@deepseek-ai/dsh-session-persistence/chain`). */

import type { SessionChainLink } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'

/** Tag hashed before the header line; the literal matches `SESSION_LOG_CHAIN_TAG`. */
export const SESSION_LOG_CHAIN_TAG = 'dsh-session-chain/1'

const TAG_BYTES = Uint8Array.from(SESSION_LOG_CHAIN_TAG, character => character.charCodeAt(0))

/**
 * SHA-256 over the chain tag and the stored header line.
 * @param headerBytes - stored header line without its newline.
 * @returns the header link's 32 raw bytes.
 */
export function headerLinkOf(headerBytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return digest(concat(TAG_BYTES, headerBytes))
}

/**
 * SHA-256 over the previous link's raw bytes and one stored line.
 * @param previous - 32 raw bytes of the link before the line.
 * @param line - stored line bytes without the newline.
 * @returns the next link's 32 raw bytes.
 */
export function nextLink(previous: Uint8Array, line: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return digest(concat(previous, line))
}

/**
 * Hex-encode link bytes for the wire and stored links.
 * @param bytes - 32 raw link bytes.
 * @returns 64 lowercase hexadecimal characters.
 */
export function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/**
 * Brand one raw link for the wire.
 * @param bytes - 32 raw link bytes.
 * @returns the link's hexadecimal characters, branded as a chain link.
 */
export function linkOf(bytes: Uint8Array): SessionChainLink {
  return brandString<SessionChainLink>(toHex(bytes))
}

/**
 * Compare two byte runs of any array-buffer backing.
 * @param left - first run; `undefined` never equals anything.
 * @param right - second run; `undefined` never equals anything.
 * @returns whether both runs hold the same bytes.
 */
export function equalBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  /* v8 ignore next -- both sides are 32-byte link digests the caller computed or parsed */
  if (left === undefined || right === undefined || left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Parse one wire link back into raw bytes.
 * @param hex - 64 lowercase hexadecimal characters.
 * @returns the 32 raw bytes, or `undefined` for any other shape.
 */
export function parseLink(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (hex.length !== 64 || !/^[0-9a-f]{64}$/u.test(hex)) return undefined
  const bytes = new Uint8Array(32)
  for (let index = 0; index < 32; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/** Join two byte runs into one digest input. */
function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.byteLength + right.byteLength)
  joined.set(left)
  joined.set(right, left.byteLength)
  return joined
}

/** Hash one prepared run with the environment's sequential WebCrypto digest. */
async function digest(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  // Every digest input here is allocated or cloned from an ArrayBuffer-backed run.
  const hashed = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return new Uint8Array(hashed)
}

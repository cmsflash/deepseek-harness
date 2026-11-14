/** Event-local acceptance and current-format line decoding for raw Session journal events; payloads remain owner-defined JSON. */

import { decodeSeqRanges } from '@deepseek-ai/dsh-session/seq-ranges'
import { validateSessionEventData, validateSurfaceMetadata } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionWireEvent } from '../types.ts'

/**
 * Reject non-current event envelopes without stripping or normalizing wire fields.
 * Range membership and source existence require the durable log and remain Host-owned.
 * @param value - one event received in a follow frame or history page.
 * @returns nothing after narrowing the accepted event envelope.
 * @throws when the envelope or current event-local metadata is invalid.
 */
export function assertSessionWireEvent(value: unknown): asserts value is SessionWireEvent {
  const subject = 'session wire event'
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${subject} must be an object`)
  }
  const event = value as Record<string, unknown>
  for (const key of Object.keys(event)) {
    switch (key) {
      case 'type':
      case 'seq':
      case 'time':
      case 'data':
      case 'ignorable':
      case 'surfaceOp':
      case 'sourceEventSeqs':
        break
      default:
        throw new Error(`${subject} has unexpected field ${key}`)
    }
  }
  const seq = event['seq']
  if (typeof event['type'] !== 'string'
    || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0)
    || typeof event['time'] !== 'number' || !Number.isSafeInteger(event['time'])
    || !Object.hasOwn(event, 'data') || event['data'] === undefined
    || (Object.hasOwn(event, 'ignorable') && event['ignorable'] !== true)) {
    throw new Error(`${subject} has an invalid envelope`)
  }
  // Event names and payloads are merge-extensible; only event-local owner rules run here.
  const current = event as SessionEvent
  validateSurfaceMetadata(current)
  validateSessionEventData(current, subject)
}

/**
 * Decode one stored current-format line into the event the Host serves for it.
 * @param line - the stored JSONL line without its newline.
 * @param seq - the seq the line was sent for.
 * @returns the validated wire event.
 * @throws when the line is not a JSON object, names another seq, or fails {@link assertSessionWireEvent}.
 */
export function decodeStoredLine(line: string, seq: number): SessionWireEvent {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`stored line for seq ${String(seq)} is not a JSON object`)
  }
  const record = parsed as Record<string, unknown>
  if (record['seq'] !== seq) {
    throw new Error(`stored line names seq ${String(record['seq'])} where ${String(seq)} was sent`)
  }
  // The spread keeps sourceEventSeqs at its stored key position while the
  // range encoding returns to the dense array the wire serves.
  const decoded = 'sourceEventSeqs' in record
    ? { ...record, sourceEventSeqs: decodeSeqRanges(record['sourceEventSeqs'], seq) }
    : record
  assertSessionWireEvent(decoded)
  return decoded
}

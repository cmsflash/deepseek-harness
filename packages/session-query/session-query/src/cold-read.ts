/** One-shot cold session read through the handle-based persistence seam. */

import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset, SessionSeedEventState } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandleReadResult, SessionLogChain } from '@deepseek-ai/dsh-session-persistence'

/** A stored session log balanced for read-only viewing. */
export interface ColdSessionLog {
  /** Aliasing state of the persisted events; synthetic closers are locally owned. */
  readonly eventState: SessionSeedEventState
  /** The stored header, fixed when the read handle opened. */
  readonly header: SessionHeader
  /** Exact fork-inherited event count paired with {@link header}. */
  readonly inheritedEventCount: SessionLogOffset
  /** Stored events plus deterministic in-memory closers for an interrupted final turn; nothing is written back. */
  readonly events: SessionEvent[]
  /**
   * Links over the stored lines of the log generation this read opened, indexed by absolute seq;
   * it also covers the appended closers when the backend can link them; absent without a backend chain.
   */
  readonly chain?: SessionLogChain
}

/**
 * Read one complete stored session log without taking ownership or mutating
 * storage: open a read handle, read the validated contiguous log, close the
 * handle, and append `interruptedTurnClosers` so a log whose writer crashed
 * mid-turn folds as a balanced transcript. Backend failures propagate
 * unmapped — each caller owns its error taxonomy.
 * @param persistence - the mounted persistence service.
 * @param sessionId - the stored session to read.
 * @param signal - optional cancellation for the open and read work.
 * @returns an adoptable seed in a caller-owned outer array, ready for in-place Session restoration.
 */
export async function readColdSessionLog(
  persistence: SessionPersistence,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<ColdSessionLog> {
  const options = signal === undefined ? undefined : { signal }
  const handle = await persistence.open(sessionId, 'read', options)
  let read: SessionHandleReadResult
  try {
    read = await handle.read(0, undefined, options)
  } catch (error: unknown) {
    try {
      await handle.close()
    } catch {
      // The read failure is the actionable cause; a close failure on the same broken handle adds nothing.
    }
    throw error
  }
  await handle.close()
  const { events } = read
  const closers = interruptedTurnClosers(events)
  // For an unchanged stored log these closers equal the ones Agent resume
  // appends, so extend, which encodes them as the backend's write path does,
  // gives them the links the log will have; if the stored log changes first,
  // the links stop matching and a resume gets a snapshot.
  const chain = read.chain === undefined
    ? undefined
    : (closers.length === 0 ? read.chain : read.chain.extend?.(closers) ?? read.chain)
  return {
    eventState: read.eventState,
    header: handle.header,
    inheritedEventCount: handle.inheritedEventCount,
    events: [...events, ...closers],
    ...(chain === undefined ? {} : { chain }),
  }
}

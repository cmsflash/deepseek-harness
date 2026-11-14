/** Live Session projection state with reconnect baselines. */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Deque } from '@deepseek-ai/dsh-deque'
import type {
  Session, SessionId,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  SessionChainLink,
  SessionControlBaseline,
  SessionControlFrame,
  SessionControlKnown,
  SessionControlRequest,
  SessionProjectionBaseline,
  SessionProjectionValues,
} from './types.ts'

/** Owns the Host-wide Session control stream. */
export class SessionControlController {
  private readonly streams = new Set<ControlQueue>()

  /** @param ctx - Host context carrying live Agent and projection services. */
  constructor(private readonly ctx: Context) {
    ctx.sessionProjections.onChanged((session, key, value, seq) => {
      this.broadcast({
        type: 'projection',
        sessionId: session.id,
        key,
        value: value as JsonValue,
        seq,
      })
    })
    ctx.on('session/created', (session: Session) => { this.announceValues(session) })
    ctx.effect(() => () => {
      for (const stream of this.streams) stream.end()
      this.streams.clear()
    }, 'session-controller.control')
  }

  /**
   * Open one generation of Host-wide live control state.
   * @param request - Sessions the Client already holds.
   * @param signal - Remote stream cancellation.
   * @returns one complete baseline, holding only the Sessions whose projections
   *   the caller's checkpoints do not already cover, followed by live
   *   replacement frames, including every value of a Session that becomes live later.
   */
  async *control(request: SessionControlRequest, signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    signal.throwIfAborted()
    const queue = new ControlQueue()
    this.streams.add(queue)
    try {
      yield { type: 'baseline', value: this.baseline(request.known ?? []) }
      yield* queue.iterate(signal)
    } finally {
      this.streams.delete(queue)
      queue.end()
    }
  }

  private baseline(known: readonly SessionControlKnown[]): SessionControlBaseline {
    return this.projectionBaseline(this.ctx.sessions.list(), known)
  }

  /**
   * One baseline over the live Sessions, skipping those a caller checkpoint
   * already covers.
   * @param sessions - live Sessions with readable projections.
   * @param known - checkpoints the caller holds, one per Session.
   * @returns full blocks by Session, and the omitted Sessions whose values the caller keeps.
   */
  private projectionBaseline(
    sessions: readonly Session[],
    known: readonly SessionControlKnown[],
  ): Pick<SessionControlBaseline, 'projections' | 'retained'> {
    const held = new Map(known.map(entry => [entry.sessionId, entry]))
    const blocks = Object.create(null) as Record<SessionId, SessionProjectionBaseline>
    const retained: SessionId[] = []
    for (const session of sessions) {
      const snapshot = this.ctx.sessionProjections.snapshot(session)
      const stored = this.ctx.get('sessionPersistence')?.liveChain?.(session.id)?.linkAt(snapshot.asOfSeq)
      const block: SessionProjectionBaseline = {
        asOfSeq: snapshot.asOfSeq,
        // Every projection definition validates its value before snapshot publication.
        values: snapshot.values as SessionProjectionValues,
        ...(stored === undefined ? {} : { link: brandString<SessionChainLink>(stored) }),
      }
      const checkpoint = held.get(session.id)
      // Only a link the caller also holds proves the values behind it are the
      // same ones, so an unlinked block always travels in full.
      if (checkpoint !== undefined && block.link !== undefined
        && checkpoint.asOfSeq === block.asOfSeq && checkpoint.link === block.link) {
        retained.push(session.id)
        continue
      }
      blocks[session.id] = block
    }
    return { projections: blocks, ...(retained.length === 0 ? {} : { retained }) }
  }

  /**
   * Send every value of a Session that became live after the open streams'
   * baselines, one frame per key at its cut; change frames carry only the keys
   * an event changed, so a stream would otherwise never hold the rest.
   * A Session without events has nothing durable to state yet.
   * @param session - the Session just announced.
   */
  private announceValues(session: Session): void {
    if (this.streams.size === 0) return
    let snapshot: ReturnType<Context['sessionProjections']['snapshot']>
    try {
      snapshot = this.ctx.sessionProjections.snapshot(session)
    } catch (error: unknown) {
      // A throw here would veto the Session's creation; its later change frames still travel.
      this.ctx.logger.warn(`session control: values of "${session.id}" were not sent: ${String(error)}`)
      return
    }
    if (snapshot.asOfSeq < 0) return
    for (const [key, value] of Object.entries(snapshot.values)) {
      this.broadcast({ type: 'projection', sessionId: session.id, key, value: value as JsonValue, seq: snapshot.asOfSeq })
    }
  }

  private broadcast(frame: SessionControlFrame): void {
    for (const stream of this.streams) stream.push(frame)
  }
}

class ControlQueue {
  private readonly buffer = new Deque<SessionControlFrame>()
  private wake: (() => void) | undefined
  private done = false

  push(frame: SessionControlFrame): void {
    if (this.done) return
    this.buffer.pushBack(frame)
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  end(): void {
    if (this.done) return
    this.done = true
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  async *iterate(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!this.done && !signal.aborted) {
        const frame = this.buffer.popFront()
        if (frame !== undefined) {
          yield frame
          continue
        }
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
      while (this.buffer.size > 0 && !signal.aborted) yield this.buffer.popFront() as SessionControlFrame
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.end()
    }
  }
}

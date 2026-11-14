/** Web opening aggregation over one observation and a shared transforming buffer. */

import type { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import type { HistoryController } from '../history/controller.ts'
import { addressId, chainLink, lineEntry, rejectNotFound } from '../history.ts'
import { entryFor } from '../history-shared/paging.ts'
import { EventListener, ListenerBuffer } from '../history/listener.ts'
import { history, projections, resolveHistoryRequest, validateObservationAddress } from '../history/controller.ts'
import type { HistoryTurnUsage } from '../history-shared/turn-usage.ts'
import type { SessionFollowFrame, SessionFollowRequest } from '../types.ts'

/** The snapshot or resumed opening a follow yields before its queued frames. */
type Opening = Extract<SessionFollowFrame, { readonly type: 'snapshot' | 'resumed' }>
import { continuesLog, validateFollowResume } from './resume.ts'

/** The live log no longer carries the opening's link at the opening cursor. */
class FollowLogChanged extends Error {}

/** Combines opening data and consumes transformed listener output from one queue. */
export class WebController {

  /**
   * @param ctx - Host context carrying Session queries and identity projections.
   * @param historyController - passive reading and listener construction.
   * @param promote - background activation requested before an opening snapshot is delivered.
   * @param resumeEventLimit - most events a resumed opening may carry; a larger gap opens with a snapshot, and 0 disables resume.
   */
  constructor(
    private readonly ctx: Context,
    private readonly historyController: HistoryController,
    private readonly promote: (observation: SessionObservation) => void,
    private readonly resumeEventLimit: number,
  ) {}

  /**
   * Open a history snapshot, or continue the caller's held window, and follow
   * uncovered history and assistant notifications. A resume point answers with
   * a `resumed` opening only when it continues the observed log within the
   * resume limit; otherwise the opening is a snapshot, as without one.
   * Opening records and live event frames carry the Session log chain link of
   * their event, or of the last event a covering record stands for, when the
   * Host keeps a chain for the log; the links resume the window on reconnect.
   * With `request.lines`, records of a `resumed` opening and live event frames
   * are stored lines wherever the Host checks the event's stored line against
   * its Session log chain; a record it cannot check stays a decoded event, and
   * snapshot openings stay decoded events.
   * A follow that stays open across a promotion ends its generation when the
   * live log no longer has the opening's link at the opening cursor, so the
   * Client reconnects with its stale link and gets a snapshot.
   * Each `turn/end`, in the opening and after it, carries its complete turn's accounting.
   * @param request - Session identity, page budget, step detail, assistant output, optional stored
   *   lines, optional resume point and activation (default false).
   * @param signal - cancellation for opening and streaming.
   * @returns an opening followed by uncovered queued increments.
   */
  async *follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    const sessionId = addressId(request.address)
    const spec = resolveHistoryRequest(request)
    if (request.resume !== undefined) validateFollowResume(request.resume)
    const lines = request.lines === true
    using queue = new ListenerBuffer<SessionFollowFrame>(this.ctx, signal)
    using listener = new EventListener(this.ctx, sessionId, signal, queue)
    const streams = this.historyController.streamsListener
    using assistantListener = request.assistantStream === true
      ? streams.bind(sessionId, signal, queue)
      : undefined
    using observation = await this.historyController.usingObservation({ sessionId, projection: true }, signal)
      .catch((error: unknown) => {
        if (remoteErrorOf(error)?.code === 'session/not-found') rejectNotFound(request.address)
        throw error
      })
    validateObservationAddress(request.address, observation)
    const resume = request.resume !== undefined && this.resumeEventLimit > 0
      && continuesLog(observation, request.resume, this.resumeEventLimit)
      ? request.resume
      : undefined
    let perCut: { readonly cursor: number; readonly turnUsage: HistoryTurnUsage }
    let opening: Opening
    if (resume === undefined) {
      const computed = history(observation, spec)
      perCut = { cursor: computed.page.cursor, turnUsage: computed.turnUsage }
      opening = {
        type: 'snapshot',
        header: { ...observation.header },
        projections: projections(observation),
        ...computed.page,
      }
    } else {
      const computed = history(
        observation, { fromSeq: resume.afterSeq + 1, maxMessages: spec.maxMessages }, { lines },
      )
      perCut = { cursor: computed.page.cursor, turnUsage: computed.turnUsage }
      opening = {
        type: 'resumed',
        header: { ...observation.header },
        after: resume.afterSeq,
        cursor: computed.page.cursor,
        records: computed.page.records,
        projections: projections(observation),
      }
    }
    const turnUsage = perCut.turnUsage
    // The opening's link at its cursor is the strongest fact the window claims;
    // one failed comparison at the first live event retires the whole generation.
    const openedLink = observation.chain?.linkAt(perCut.cursor)
    let verified = false
    listener.setCursor(perCut.cursor, (event) => {
      const chain = this.ctx.get('sessionPersistence')?.liveChain?.(sessionId)
      if (!verified) {
        verified = true
        if (chain?.linkAt(perCut.cursor) !== openedLink) throw new FollowLogChanged()
      }
      const usage = turnUsage.append(event)
      const link = chainLink(chain, event.seq)
      const bytes = lines ? chain?.storedLine?.(event) : undefined
      if (bytes === undefined || link === undefined) return entryFor(event, usage, link)
      return lineEntry(event, bytes, link, usage)
    })
    if (assistantListener !== undefined) {
      const { baseline: assistantStream, ordinal } = assistantListener.snapshot()
      opening = { ...opening, assistantStream }
      assistantListener.setOrdinalCut(ordinal)
    }
    // Increments come from the queue, so the opening ends this lease in every branch;
    // activation continues on its own retained lease. Promotion starts before the opening is
    // delivered, so a consumer that stops after the opening still gets the activation it asked for.
    if (request.activate === true && !signal.aborted
      && observation.header.origin !== 'subagent' && observation.source === 'prepared') {
      const promotion = observation.retain()
      observation[Symbol.dispose]()
      try {
        this.promote(promotion)
      } catch (error: unknown) {
        promotion[Symbol.dispose]()
        throw error
      }
    } else {
      observation[Symbol.dispose]()
    }
    yield opening
    try {
      yield* queue.items()
    } catch (error: unknown) {
      if (error instanceof FollowLogChanged) return
      throw error
    }
  }
}

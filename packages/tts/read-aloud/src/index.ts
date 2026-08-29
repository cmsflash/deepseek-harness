/**
 * Read-aloud audio for completed turns: a `turn/end` listener that synthesizes
 * each turn's closing prose, a filesystem cache under the Harness home, and the
 * Remote a browser reads it through.
 *
 * Audio is regenerable presentation, never durable Session state — nothing here
 * appends to the Session log, and a cache miss is an ordinary outcome resolved
 * by synthesizing again.
 * @module @deepseek-ai/dsh-read-aloud
 */

import { Buffer } from 'node:buffer'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-tts'
import { ReadAloudStore } from './store.ts'
import { closingMessageOf } from './text.ts'
import type { SpeechAudioRequest, SpeechAudioResult, SpeechAudioValue } from './types.ts'

export type {
  SpeechAudioFailure,
  SpeechAudioFailureCode,
  SpeechAudioRequest,
  SpeechAudioResult,
  SpeechAudioSuccess,
  SpeechAudioValue,
} from './types.ts'
export { ReadAloudStore } from './store.ts'
export { closingMessageOf, spokenText } from './text.ts'
export type { SpokenMessage } from './text.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    readAloud: ReadAloudService
  }
}

/** Required deployment policy for cached read-aloud audio. */
export interface Config {
  /** Days a synthesized artifact is served before it is swept. */
  readonly ttlDays: number
  /**
   * Synthesize every completed turn as it ends. False leaves synthesis to the
   * first playback request, trading latency for spend on turns nobody plays.
   */
  readonly synthesizeOnTurnEnd: boolean
}

/** Milliseconds in one day, for the TTL conversion. */
const DAY_MS = 86_400_000

/**
 * Cached read-aloud audio for finalized assistant messages.
 *
 * The Host resolves spoken text from the Session log by `messageId`, so a
 * browser sends identity rather than prose and no conversation surface has to
 * carry the text.
 */
export class ReadAloudService extends TypertRemoteService {
  static inject = ['sessions', 'tts']

  static Config: s<Config> = s.object({
    ttlDays: s.number().step(1).min(1).required(),
    synthesizeOnTurnEnd: s.boolean().required(),
  })

  private readonly store: ReadAloudStore
  private readonly synthesizeOnTurnEnd: boolean
  /** In-flight synthesis per message, so a turn-end job and a play request share one call. */
  private readonly inFlight = new Map<MessageId, Promise<Uint8Array>>()

  /**
   * @param ctx - Host context carrying the Session store and the speech seam.
   * @param config - Required retention and trigger policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'readAloud')
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    this.store = new ReadAloudStore(join(home, 'cache', 'read-aloud'), config.ttlDays * DAY_MS)
    this.synthesizeOnTurnEnd = config.synthesizeOnTurnEnd
  }

  /** Sweep expired artifacts once at startup, then follow completed turns. */
  protected [Service.init](): void {
    void this.store.sweep()
    if (!this.synthesizeOnTurnEnd) return
    this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type !== 'turn/end') return
      // An interrupted turn has no settled closing prose to read.
      if (event.data.reason.kind !== 'completed') return
      // A subagent transcript has no playback surface; synthesizing it would
      // bill for audio nothing can play.
      if (session.header.origin === 'subagent') return
      const closing = closingMessageOf(session.events, event.data.turn)
      if (closing === undefined) return
      void this.ensureAudio(closing.messageId, closing.text)
    })
  }

  /**
   * Read one message's audio, synthesizing it when the cache does not hold it.
   * @param request - the Session and message to read aloud.
   * @returns base64 audio, or an explicit failure.
   */
  @Remote('audio')
  async audio(request: SpeechAudioRequest): Promise<SpeechAudioResult> {
    const cached = await this.store.read(request.messageId)
    if (cached !== undefined) return success(cached.data, false)
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) return { ok: false, code: 'session-not-found' }
    const text = spokenTextOf(session.events, request.messageId)
    if (text === undefined) return { ok: false, code: 'message-not-found' }
    try {
      return success(await this.ensureAudio(request.messageId, text), true)
    } catch (error: unknown) {
      return { ok: false, code: 'synthesis-failed', detail: String(error) }
    }
  }

  /**
   * Synthesize and cache one message's audio, joining any in-flight call for
   * the same message so a turn-end job and a playback request never bill twice.
   * @param messageId - the message the audio belongs to.
   * @param text - the prose to speak.
   * @returns the synthesized audio bytes.
   */
  private ensureAudio(messageId: MessageId, text: string): Promise<Uint8Array> {
    const existing = this.inFlight.get(messageId)
    if (existing !== undefined) return existing
    const pending = this.synthesizeAndStore(messageId, text)
      .finally(() => this.inFlight.delete(messageId))
    this.inFlight.set(messageId, pending)
    return pending
  }

  private async synthesizeAndStore(messageId: MessageId, text: string): Promise<Uint8Array> {
    const audio = await this.ctx.tts.synthesize({ text })
    await this.store.write(messageId, audio.data)
    return audio.data
  }
}

/** Wrap audio bytes as the Remote's success value. */
function success(data: Uint8Array, regenerated: boolean): { ok: true; value: SpeechAudioValue } {
  return {
    ok: true,
    value: { data: Buffer.from(data).toString('base64'), mediaType: 'audio/mpeg', regenerated },
  }
}

/** Recover one finalized assistant message's spoken prose from the log. */
function spokenTextOf(events: readonly SessionEvent[], messageId: MessageId): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    if (event.data.message.id !== messageId) continue
    const closing = closingMessageOf(events, event.data.turn)
    return closing?.messageId === messageId ? closing.text : undefined
  }
  return undefined
}

export default ReadAloudService

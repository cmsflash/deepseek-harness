/**
 * Browser-side audio playback for one Session's assistant messages. One player
 * per Session enforces the single-stream rule: starting a message stops
 * whatever was playing, so two replies never overlap.
 * @module @deepseek-ai/dsh-client-ui-message-speech/client/player
 */

import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'

/** Decode base64 audio into a blob URL the audio element can play. */
function toObjectUrl(base64: string, mediaType: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return URL.createObjectURL(new Blob([bytes], { type: mediaType }))
}

/** What a caller observes about one message's playback. */
export type SpeechPlaybackStatus = 'idle' | 'loading' | 'playing' | 'error'

/** One Session's playback state, shared by every message control in it. */
export interface SpeechPlaybackView {
  /** The message currently loading or playing, when any. */
  readonly activeMessageId: MessageId | undefined
  /** Status of {@link SpeechPlaybackView.activeMessageId}. */
  readonly status: SpeechPlaybackStatus
}

/** Fetches one message's audio; resolves `undefined` when it cannot be produced. */
export type SpeechAudioLoader = (messageId: MessageId) => Promise<{ data: string; mediaType: string } | undefined>

const IDLE: SpeechPlaybackView = Object.freeze({ activeMessageId: undefined, status: 'idle' })

/**
 * Per-Session playback controller.
 *
 * The snapshot identity is stable between changes, so a subscribing renderer
 * re-renders only when playback actually moves.
 */
export class SpeechPlayer {
  private view: SpeechPlaybackView = IDLE
  private readonly listeners = new Set<() => void>()
  private audio: HTMLAudioElement | undefined
  private objectUrl: string | undefined
  /** Distinguishes a settled load from one superseded by a later request. */
  private generation = 0

  constructor(private readonly load: SpeechAudioLoader) {}

  /**
   * Subscribe to playback changes.
   * @param listener - called after every state change.
   * @returns the unsubscribe function.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Read the current playback state.
   * @returns the snapshot, stable by reference until playback moves.
   */
  getSnapshot = (): SpeechPlaybackView => this.view

  /**
   * Start reading one message aloud, or stop it when it is already active.
   * @param messageId - the message to read.
   */
  async toggle(messageId: MessageId): Promise<void> {
    if (this.view.activeMessageId === messageId && this.view.status !== 'error') {
      this.stop()
      return
    }
    this.stop()
    const generation = ++this.generation
    this.publish({ activeMessageId: messageId, status: 'loading' })
    const audio = await this.load(messageId).catch(() => undefined)
    if (generation !== this.generation) return
    if (audio === undefined) {
      this.publish({ activeMessageId: messageId, status: 'error' })
      return
    }
    this.objectUrl = toObjectUrl(audio.data, audio.mediaType)
    const element = new Audio(this.objectUrl)
    this.audio = element
    element.addEventListener('ended', () => {
      if (generation === this.generation) this.stop()
    })
    element.addEventListener('error', () => {
      if (generation === this.generation) this.publish({ activeMessageId: messageId, status: 'error' })
    })
    // HTMLMediaElement.play() predates promises; a host that returns nothing
    // has already started playback synchronously.
    /* v8 ignore next 4 -- the stale-generation arms need a play() promise still
       pending when a later toggle supersedes it; the element-event guards above
       cover the same supersession rule with a deterministic trigger. */
    await Promise.resolve(element.play()).then(
      () => { if (generation === this.generation) this.publish({ activeMessageId: messageId, status: 'playing' }) },
      () => { if (generation === this.generation) this.publish({ activeMessageId: messageId, status: 'error' }) },
    )
  }

  /** Stop any active playback and release its resources. */
  stop(): void {
    this.generation += 1
    this.audio?.pause()
    this.audio = undefined
    if (this.objectUrl !== undefined) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = undefined
    }
    this.publish(IDLE)
  }

  /** Release every resource; the player is unusable afterwards. */
  dispose(): void {
    this.stop()
    this.listeners.clear()
  }

  private publish(view: SpeechPlaybackView): void {
    if (view.activeMessageId === this.view.activeMessageId && view.status === this.view.status) return
    this.view = Object.freeze(view)
    for (const listener of this.listeners) listener()
  }
}

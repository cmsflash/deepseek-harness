/** Speech synthesis vocabulary. @module @deepseek-ai/dsh-tts/types */

/** Audio container formats one provider may return. */
export type SpeechMediaType = 'audio/mpeg' | 'audio/wav' | 'audio/flac'

/**
 * One synthesis request as a caller states it. A provider never reads this
 * directly: {@link TtsRuntime.resolve} turns it into a {@link SpeechSpec}
 * so every defaulting decision happens at one explicit step.
 */
export interface SpeechRequest {
  /** Plain text to speak. Markdown is the caller's to strip. */
  readonly text: string
  /** Provider-specific voice identifier; the deployment's configured voice applies when absent. */
  readonly voice?: string
}

/** One synthesis request after the seam has applied deployment policy. */
export interface SpeechSpec {
  /** Plain text to speak, already truncated to the configured bound. */
  readonly text: string
  /** Provider-routed model identifier. */
  readonly model: string
  /**
   * Requested mp3 bitrate in bits per second. Advisory: MiniMax honors it,
   * OpenAI's own models ignore it and return 128 kbps regardless.
   */
  readonly bitrate: number
  /**
   * Provider-specific voice identifier. Always present: an OpenAI-shaped
   * `/audio/speech` route rejects a request without one.
   */
  readonly voice: string
  /** True when {@link SpeechRequest.text} exceeded the bound and was cut. */
  readonly truncated: boolean
}

/** Synthesized audio plus what the provider reported about it. */
export interface SpeechAudio {
  /** Encoded audio bytes. */
  readonly data: Uint8Array
  /** Container format of {@link SpeechAudio.data}. */
  readonly mediaType: SpeechMediaType
  /**
   * Characters the provider billed, when it reports them. MiniMax counts a CJK
   * character as two, so this is not `text.length` and is recorded rather than
   * derived.
   */
  readonly billedCharacters?: number
  /** Audio duration in milliseconds, when the provider reports it. */
  readonly durationMs?: number
}

/** A synthesis backend registered into {@link TtsRuntime}. */
export interface SpeechProvider {
  /** Registry key; also the id a deployment configures to pin this provider. */
  readonly id: string
  /** Whether this provider can run now (credentials present, route reachable). */
  available(): boolean
  /**
   * Synthesize one resolved spec.
   * @param spec - the seam-resolved request.
   * @param signal - optional cancellation forwarded from the caller.
   * @returns the encoded audio and any usage the backend reported.
   */
  synthesize(spec: SpeechSpec, signal?: AbortSignal): Promise<SpeechAudio>
}

/** Failure codes callers may branch on. */
export type SpeechErrorCode =
  | 'SPEECH_DUPLICATE_PROVIDER'
  | 'SPEECH_PROVIDER_CONFIGURED_MISSING'
  | 'SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE'
  | 'SPEECH_PROVIDER_UNAVAILABLE'
  | 'SPEECH_PROVIDER_AMBIGUOUS'
  | 'SPEECH_EMPTY_TEXT'
  | 'SPEECH_REQUEST_FAILED'

/** Error carrying a {@link SpeechErrorCode} for capability and provider failures. */
export class SpeechError extends Error {
  /**
   * @param message - human-readable description.
   * @param code - the stable failure code.
   */
  constructor(message: string, readonly code: SpeechErrorCode) {
    super(message)
    this.name = 'SpeechError'
  }
}

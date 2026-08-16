/**
 * `LitellmSpeechProvider`: a {@link SpeechProvider} backed by an OpenAI-shaped
 * `POST /audio/speech` gateway. LiteLLM owns the vendor call, so a MiniMax
 * route reaches its native `/v1/t2a_v2` endpoint through the gateway's
 * adapter rather than through an OpenAI base-URL override.
 * @module @deepseek-ai/dsh-speech-litellm/provider
 */

import { SpeechError } from '@deepseek-ai/dsh-speech'
import type { SpeechAudio, SpeechProvider, SpeechSpec } from '@deepseek-ai/dsh-speech'

/** Stable id this provider registers under. */
export const LITELLM_SPEECH_PROVIDER_ID = 'litellm'

/** Default gateway base; `/audio/speech` is the operation. */
export const LITELLM_DEFAULT_BASE_URL = 'http://127.0.0.1:4000'

/** Attribution header sent on every request. */
const USER_AGENT = 'deepseek-harness'

/** Resolved provider options; the plugin's `apply` supplies every default. */
export interface LitellmSpeechProviderOptions {
  /** Gateway API key. Empty makes the provider unavailable. */
  readonly apiKey: string
  /** Gateway base URL; `/audio/speech` is appended. */
  readonly baseURL: string
  /** Request deadline in milliseconds. */
  readonly timeoutMs: number
}

/**
 * Synthesis over an OpenAI-compatible speech gateway.
 *
 * `bitrate` rides `extra_body`, which LiteLLM forwards to the vendor verbatim:
 * the OpenAI speech schema has no bitrate field, and MiniMax reads it from
 * `audio_setting`.
 */
export class LitellmSpeechProvider implements SpeechProvider {
  readonly id = LITELLM_SPEECH_PROVIDER_ID

  constructor(private readonly options: LitellmSpeechProviderOptions) {}

  /**
   * Whether a gateway credential is present.
   * @returns true when the provider holds a non-empty API key.
   */
  available(): boolean {
    return this.options.apiKey.length > 0
  }

  /**
   * Synthesize one resolved spec through the gateway.
   * @param spec - the seam-resolved request.
   * @param signal - optional cancellation forwarded to the gateway.
   * @returns the encoded audio; usage fields stay absent because the
   *   OpenAI-shaped response body carries audio bytes and no usage envelope.
   * @throws {@link SpeechError} `SPEECH_REQUEST_FAILED` on a non-2xx reply,
   *   an empty body, or a transport failure.
   */
  async synthesize(spec: SpeechSpec, signal?: AbortSignal): Promise<SpeechAudio> {
    const url = `${this.options.baseURL.replace(/\/+$/, '')}/audio/speech`
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({
        model: spec.model,
        input: spec.text,
        response_format: 'mp3',
        ...spec.voice !== undefined ? { voice: spec.voice } : {},
        extra_body: { bitrate: spec.bitrate },
      }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    }).catch((cause: unknown) => {
      throw new SpeechError(`speech gateway request failed: ${String(cause)}`, 'SPEECH_REQUEST_FAILED')
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new SpeechError(
        `speech gateway returned ${response.status}${detail.length > 0 ? `: ${detail}` : ''}`,
        'SPEECH_REQUEST_FAILED',
      )
    }
    const data = new Uint8Array(await response.arrayBuffer())
    if (data.byteLength === 0) {
      throw new SpeechError('speech gateway returned an empty audio body', 'SPEECH_REQUEST_FAILED')
    }
    return { data, mediaType: 'audio/mpeg' }
  }
}

/**
 * `OpenAiCompatibleSpeechProvider`: a {@link SpeechProvider} over any
 * `POST /audio/speech` route that speaks the OpenAI audio schema. One class
 * serves OpenAI itself and a gateway in front of other vendors, because the
 * request and reply are identical across them; a route differs only by base
 * URL and credential.
 *
 * A gateway owns the vendor call, so a MiniMax route reaches its native
 * `/v1/t2a_v2` endpoint through the gateway's adapter rather than through an
 * OpenAI base-URL override.
 * @module @deepseek-ai/dsh-speech-openai-compatible/provider
 */

import { SpeechError } from '@deepseek-ai/dsh-speech'
import type { SpeechAudio, SpeechProvider, SpeechSpec } from '@deepseek-ai/dsh-speech'

/** Attribution header sent on every request. */
const USER_AGENT = 'deepseek-harness'

/** Resolved options for one route; the plugin's `apply` supplies every default. */
export interface OpenAiCompatibleSpeechProviderOptions {
  /** Registry id this route registers under, for example `litellm` or `openai`. */
  readonly id: string
  /** Route API key. Empty makes the provider unavailable. */
  readonly apiKey: string
  /** Route base URL; `/audio/speech` is appended. */
  readonly baseURL: string
  /** Request deadline in milliseconds. */
  readonly timeoutMs: number
}

/**
 * Synthesis over one OpenAI-compatible speech route.
 *
 * `bitrate` rides `extra_body`, which a gateway forwards to the vendor
 * verbatim: the OpenAI speech schema has no bitrate field, and MiniMax reads it
 * from `audio_setting`. A vendor without that field ignores it — OpenAI's own
 * models return the same 128 kbps mp3 either way — so the request stays valid
 * on every route while only some honor it.
 */
export class OpenAiCompatibleSpeechProvider implements SpeechProvider {
  readonly id: string

  constructor(private readonly options: OpenAiCompatibleSpeechProviderOptions) {
    this.id = options.id
  }

  /**
   * Whether a route credential is present.
   * @returns true when the route holds a non-empty API key.
   */
  available(): boolean {
    return this.options.apiKey.length > 0
  }

  /**
   * Synthesize one resolved spec through this route.
   * @param spec - the seam-resolved request.
   * @param signal - optional cancellation forwarded to the route.
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
      // `voice` is required by this route: OpenAI and a gateway alike answer a
      // request without it with an opaque 500 rather than a 4xx.
      body: JSON.stringify({
        model: spec.model,
        input: spec.text,
        voice: spec.voice,
        response_format: 'mp3',
        extra_body: { bitrate: spec.bitrate },
      }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    }).catch((cause: unknown) => {
      throw new SpeechError(`speech route request failed: ${String(cause)}`, 'SPEECH_REQUEST_FAILED')
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new SpeechError(
        `speech route returned ${response.status}${detail.length > 0 ? `: ${detail}` : ''}`,
        'SPEECH_REQUEST_FAILED',
      )
    }
    const data = new Uint8Array(await response.arrayBuffer())
    if (data.byteLength === 0) {
      throw new SpeechError('speech route returned an empty audio body', 'SPEECH_REQUEST_FAILED')
    }
    return { data, mediaType: 'audio/mpeg' }
  }
}

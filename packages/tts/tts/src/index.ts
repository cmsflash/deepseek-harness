/**
 * Service Definition for the speech synthesis capability seam (`ctx.tts`):
 * a provider registry plus provider-selecting execution. Deployment policy —
 * model, bitrate, voice, and the input bound — is applied by an explicit
 * `resolve(request): SpeechSpec` step, so no provider hides a default inside
 * `synthesize()`. Duplicate ids are rejected. At execution time a configured
 * provider must exist and be usable; without one, exactly one usable provider
 * is required, so selection never depends on registration order.
 * @module @deepseek-ai/dsh-tts
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SpeechAudio, SpeechProvider, SpeechRequest, SpeechSpec } from './types.ts'
import { SpeechError } from './types.ts'

export { SpeechError } from './types.ts'
export type {
  SpeechAudio,
  SpeechErrorCode,
  SpeechMediaType,
  SpeechProvider,
  SpeechRequest,
  SpeechSpec,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tts: TtsRuntime
  }
}

/**
 * Required deployment policy for the speech seam. Every field is required with
 * no library default: model choice, audio weight, and the input bound all vary
 * by deployment and each carries a cost, so none may be inherited silently.
 */
export interface TtsRuntimeConfig {
  /** Provider-routed model identifier, for example `minimax/speech-2.6-hd`. */
  readonly model: string
  /**
   * Requested mp3 bitrate in bits per second. Billing is by input characters,
   * so this trades stored bytes against audio quality and nothing else.
   *
   * Advisory rather than guaranteed: it reaches the vendor as `extra_body`,
   * which MiniMax honors and OpenAI's own models ignore.
   */
  readonly bitrate: number
  /**
   * Maximum characters sent in one request. Longer text is truncated rather
   * than split, because a partial reading is a better failure than an
   * unbounded bill.
   */
  readonly maxChars: number
  /** Explicit provider id. Omitted = auto-select when exactly one is usable. */
  readonly provider?: string
  /**
   * Voice passed to the provider when a request names none. Required with no
   * library default: an OpenAI-shaped route rejects a request carrying no
   * voice, and the vocabulary is vendor-specific, so no value is portable
   * enough to inherit silently.
   */
  readonly voice: string
}

/**
 * The speech synthesis service, registered as `ctx.tts`.
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `SPEECH_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `SPEECH_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `SPEECH_PROVIDER_UNAVAILABLE`.
 */
export class TtsRuntime extends Service {
  static Config: z<TtsRuntimeConfig> = z.object({
    model: z.string().required(),
    bitrate: z.number().step(1).min(1).required(),
    maxChars: z.number().step(1).min(1).required(),
    provider: z.string(),
    voice: z.string().required(),
  })

  private readonly providers = new Map<string, SpeechProvider>()
  private readonly config: TtsRuntimeConfig

  constructor(ctx: Context, config: TtsRuntimeConfig) {
    super(ctx, 'tts')
    this.config = config
  }

  /**
   * Register a synthesis provider.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   * @throws {@link SpeechError} `SPEECH_DUPLICATE_PROVIDER` when the id is taken.
   */
  registerProvider(provider: SpeechProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new SpeechError(
        `a speech provider with id "${provider.id}" is already registered`,
        'SPEECH_DUPLICATE_PROVIDER',
      )
    }
    const providers = this.providers
    const dispose = this.ctx.effect(function* () {
      providers.set(provider.id, provider)
      yield () => providers.delete(provider.id)
    }, 'speech.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; this disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Apply deployment policy to one request. This is the only place defaults are
   * filled, so a provider always receives a complete spec.
   * @param request - the caller's text and optional voice.
   * @returns the resolved spec, with `truncated` set when text exceeded `maxChars`.
   * @throws {@link SpeechError} `SPEECH_EMPTY_TEXT` when the text is blank.
   */
  resolve(request: SpeechRequest): SpeechSpec {
    const text = request.text.trim()
    if (text.length === 0) {
      throw new SpeechError('speech synthesis requires non-blank text', 'SPEECH_EMPTY_TEXT')
    }
    const truncated = text.length > this.config.maxChars
    return {
      text: truncated ? text.slice(0, this.config.maxChars) : text,
      model: this.config.model,
      bitrate: this.config.bitrate,
      voice: request.voice ?? this.config.voice,
      truncated,
    }
  }

  /**
   * Resolve one request and synthesize it through the selected provider.
   *
   * Policy and selection failures surface as rejections rather than synchronous
   * throws, so one `catch` covers every way synthesis can fail.
   *
   * @param request - the caller's text and optional voice.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns the encoded audio and any usage the backend reported.
   * @throws {@link SpeechError} when no provider can run or the backend fails.
   */
  async synthesize(request: SpeechRequest, signal?: AbortSignal): Promise<SpeechAudio> {
    const spec = this.resolve(request)
    return this.selectProvider().synthesize(spec, signal)
  }

  /** Resolve the selected provider or throw the matching {@link SpeechError}. */
  private selectProvider(): SpeechProvider {
    const configuredId = this.config.provider
    if (configuredId !== undefined) {
      const provider = this.providers.get(configuredId)
      if (provider === undefined) {
        throw new SpeechError(
          `configured speech provider "${configuredId}" is not registered`,
          'SPEECH_PROVIDER_CONFIGURED_MISSING',
        )
      }
      if (!provider.available()) {
        throw new SpeechError(
          `configured speech provider "${configuredId}" is registered but unavailable`,
          'SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE',
        )
      }
      return provider
    }
    const usable = [...this.providers.values()].filter(provider => provider.available())
    const [single] = usable
    if (single === undefined) {
      throw new SpeechError('no usable speech provider is registered', 'SPEECH_PROVIDER_UNAVAILABLE')
    }
    if (usable.length > 1) {
      const ids = usable.map(provider => provider.id).join(', ')
      throw new SpeechError(
        `multiple usable speech providers are registered (${ids}); configure one explicitly`,
        'SPEECH_PROVIDER_AMBIGUOUS',
      )
    }
    return single
  }
}

export default TtsRuntime

/**
 * `@deepseek-ai/dsh-speech-litellm`: registers a gateway-backed
 * {@link LitellmSpeechProvider} with `ctx.speech`. A function/namespace plugin
 * (NOT a default-export service): a provider does not own the `ctx.speech`
 * key — it registers INTO the seam's registry, exactly as
 * `@deepseek-ai/dsh-web-search-exa` registers into `ctx.web`. The key is owned
 * by `@deepseek-ai/dsh-speech`.
 * @module @deepseek-ai/dsh-speech-litellm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-speech'
import { LITELLM_DEFAULT_BASE_URL, LitellmSpeechProvider } from './provider.ts'

export {
  LITELLM_DEFAULT_BASE_URL,
  LITELLM_SPEECH_PROVIDER_ID,
  LitellmSpeechProvider,
} from './provider.ts'
export type { LitellmSpeechProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'speech-litellm'

/** The speech seam this provider registers into. */
export const inject = ['speech']

/** Plugin config; `apply` fills environment and constant defaults. */
export interface Config {
  /** Gateway API key. Falls back to `$LITELLM_API_KEY`. Empty → provider unavailable. */
  apiKey?: string
  /** Gateway base; `/audio/speech` is appended. Falls back to `$LITELLM_BASE_URL`. */
  baseURL?: string
  /** Request deadline in milliseconds. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  timeoutMs: z.number().step(1).min(1),
})

/** Default request deadline: synthesis of a long reply is slower than a chat turn. */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Register the gateway speech provider with `ctx.speech`.
 * @param ctx - Cordis context carrying the speech seam.
 * @param config - plugin config; absent fields fall back to the launch environment.
 */
export function apply(ctx: Context, config: Config): void {
  const env = launchEnvironmentOf(ctx)
  ctx.speech.registerProvider(new LitellmSpeechProvider({
    // Every environment layer may name this key: the product trusts the
    // project it is launched in, and the managed store is not involved here.
    apiKey: config.apiKey ?? env.get('LITELLM_API_KEY')?.value ?? '',
    baseURL: config.baseURL ?? env.get('LITELLM_BASE_URL')?.value ?? LITELLM_DEFAULT_BASE_URL,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }))
}

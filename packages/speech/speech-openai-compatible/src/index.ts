/**
 * `@deepseek-ai/dsh-speech-openai-compatible`: registers one
 * {@link OpenAiCompatibleSpeechProvider} per configured route with `ctx.speech`.
 * A function/namespace plugin (NOT a default-export service): a provider does
 * not own the `ctx.speech` key — it registers INTO the seam's registry, exactly
 * as `@deepseek-ai/dsh-web-search-exa` registers into `ctx.web`. The key is
 * owned by `@deepseek-ai/dsh-speech`.
 *
 * One package hosts every OpenAI-shaped route because they differ only by base
 * URL and credential, following `@deepseek-ai/dsh-llm-pi-ai`'s `providers:` map
 * rather than a package per vendor.
 *
 * ```yaml
 * - id: speech-routes
 *   name: '@deepseek-ai/dsh-speech-openai-compatible'
 *   config:
 *     providers:
 *       # A gateway in front of many vendors.
 *       litellm:
 *         apiKeyEnv: LITELLM_API_KEY
 *         baseURL: https://gateway.example/v1
 *       # OpenAI itself; baseURL defaults to the public API.
 *       openai:
 *         apiKeyEnv: OPENAI_API_KEY
 * ```
 * @module @deepseek-ai/dsh-speech-openai-compatible
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-speech'
import { OpenAiCompatibleSpeechProvider } from './provider.ts'

export { OpenAiCompatibleSpeechProvider } from './provider.ts'
export type { OpenAiCompatibleSpeechProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'speech-openai-compatible'

/** The speech seam these routes register into. */
export const inject = ['speech']

/** OpenAI's public audio API; the default base for a route that names none. */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/** One configured route. The map key is the provider id the seam selects by. */
export interface SpeechRouteConfig {
  /** Environment/credential reference holding the key. Unset → route unavailable. */
  apiKeyEnv?: string
  /** Literal key, for a deployment that does not use a credential reference. */
  apiKey?: string
  /** Route base; `/audio/speech` is appended. Defaults to {@link OPENAI_DEFAULT_BASE_URL}. */
  baseURL?: string
  /** Environment reference holding the base URL, for a route whose host varies by deployment. */
  baseURLEnv?: string
  /** Request deadline in milliseconds. */
  timeoutMs?: number
}

/** Plugin config; `apply` fills environment and constant defaults per route. */
export interface Config {
  /** Routes to register, keyed by the provider id the seam selects by. */
  providers: Record<string, SpeechRouteConfig>
}

export const Config: z<Config> = z.object({
  providers: z.dict(z.object({
    apiKeyEnv: z.string(),
    apiKey: z.string(),
    baseURL: z.string(),
    baseURLEnv: z.string(),
    timeoutMs: z.number().step(1).min(1),
  })).required(),
})

/** Default request deadline: synthesis of a long reply is slower than a chat turn. */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Register one speech provider per configured route with `ctx.speech`.
 *
 * A route whose credential is absent still registers and reports
 * `available() === false`, so a deployment that pins it is told the route is
 * unusable rather than unregistered.
 *
 * @param ctx - Cordis context carrying the speech seam.
 * @param config - the route map; absent fields fall back to the launch environment.
 */
export function apply(ctx: Context, config: Config): void {
  const env = launchEnvironmentOf(ctx)
  for (const [id, route] of Object.entries(config.providers)) {
    // Every environment layer may name this key: the product trusts the
    // project it is launched in, and the managed store is not involved here.
    const keyFromEnv = route.apiKeyEnv !== undefined ? env.get(route.apiKeyEnv)?.value : undefined
    const baseFromEnv = route.baseURLEnv !== undefined ? env.get(route.baseURLEnv)?.value : undefined
    ctx.speech.registerProvider(new OpenAiCompatibleSpeechProvider({
      id,
      apiKey: route.apiKey ?? keyFromEnv ?? '',
      baseURL: route.baseURL ?? baseFromEnv ?? OPENAI_DEFAULT_BASE_URL,
      timeoutMs: route.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }))
  }
}

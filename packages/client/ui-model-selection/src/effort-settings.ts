/** Per-model reasoning effort remembered across sessions in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the model-selection plugin. */
export const MODEL_EFFORT_SETTINGS_NAMESPACE = 'ui-model-selection'

/** Section field carrying the remembered efforts, keyed by {@link effortKey}. */
export const REMEMBERED_EFFORTS_FIELD = 'rememberedEfforts'

/**
 * Compose the storage key for one exact route. Model ids are provider-owned
 * and collide across providers, so the provider is part of the key.
 * @param provider - registered provider route id.
 * @param model - provider-owned model id.
 * @returns the section key holding this route's remembered effort.
 */
export function effortKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/**
 * Durable model-selection section. A key maps to the effort id last selected
 * for that route, or to `null` recording that the user chose the provider
 * default explicitly — distinct from an absent key, which carries no choice
 * and leaves the adapter's declared default in force.
 */
export interface ModelEffortSettings {
  /** Remembered effort per `provider/model`; `null` is an explicit provider-default choice. */
  rememberedEfforts: Record<string, string | null>
}

/** Durable schema; also the wire envelope the browser scope validates against. */
export const ModelEffortSettingsSchema: z<ModelEffortSettings> = z.object({
  [REMEMBERED_EFFORTS_FIELD]: z.dict(z.union([z.string(), z.const(null)])).default({}),
})

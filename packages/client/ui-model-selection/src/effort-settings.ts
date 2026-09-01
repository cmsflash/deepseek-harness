/** Per-model reasoning effort remembered across sessions in the plugin's live configuration. */

import z from '@deepseek-ai/schemastery'

/** Profile entry id owning the remembered efforts. */
export const MODEL_EFFORT_SETTINGS_NAMESPACE = 'ui-model-selection'

/** Config field carrying the remembered efforts, keyed by {@link effortKey}. */
export const REMEMBERED_EFFORTS_FIELD = 'rememberedEfforts'

/**
 * Compose the storage key for one exact route. Model ids are provider-owned
 * and collide across providers, so the provider is part of the key.
 * @param provider - registered provider route id.
 * @param model - provider-owned model id.
 * @returns the field key holding this route's remembered effort.
 */
export function effortKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/**
 * Model-selection preferences. A key maps to the effort id last selected for
 * that route, or to `null` recording that the user chose the provider default
 * explicitly — distinct from an absent key, which carries no choice.
 */
export interface ModelEffortSettings {
  /** Remembered effort per `provider/model`; `null` is an explicit provider-default choice. */
  rememberedEfforts: Record<string, string | null>
}

/** Field schemas shared by the Host Config and the browser form. */
export const ModelEffortSettingsFields = {
  [REMEMBERED_EFFORTS_FIELD]: z.dict(z.union([z.string(), z.const(null)])).default({}),
}

/** Schema for the remembered-effort configuration values. */
export const ModelEffortSettingsSchema: z<ModelEffortSettings> = z.object(ModelEffortSettingsFields)

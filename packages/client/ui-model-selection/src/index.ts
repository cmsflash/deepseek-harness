/**
 * Model selection plugin, node half. Registers the durable section holding the
 * reasoning effort last selected per model route; the browser half ships via
 * exports["./client"], discovered through the package.json dsh.client
 * declaration.
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MODEL_EFFORT_SETTINGS_NAMESPACE, ModelEffortSettingsSchema } from './effort-settings.ts'

export {
  MODEL_EFFORT_SETTINGS_NAMESPACE, REMEMBERED_EFFORTS_FIELD, effortKey,
  type ModelEffortSettings,
} from './effort-settings.ts'

/**
 * Register the durable per-model effort section when a settings provider exists.
 * @param ctx - Host context whose optional settings service owns the section.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      settingsNamespace(MODEL_EFFORT_SETTINGS_NAMESPACE),
      ModelEffortSettingsSchema,
    )
  })
}

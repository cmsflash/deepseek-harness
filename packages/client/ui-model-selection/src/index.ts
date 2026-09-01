/**
 * Model selection plugin, node half. Declares the live per-model effort
 * memory as volatile Config on this entry; the browser half ships via
 * exports["./client"], discovered through the package.json dsh.client
 * declaration.
 */

import type {} from '@deepseek-ai/dsh-settings'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ModelEffortSettingsFields, REMEMBERED_EFFORTS_FIELD, type ModelEffortSettings } from './effort-settings.ts'

export {
  MODEL_EFFORT_SETTINGS_NAMESPACE, REMEMBERED_EFFORTS_FIELD, effortKey,
  type ModelEffortSettings,
} from './effort-settings.ts'

/** Live preferences projected to the browser. */
export interface Config {
  /** Reasoning effort last selected per `provider/model` route. */
  rememberedEfforts: Volatile<ModelEffortSettings['rememberedEfforts']>
}

/** Live preferences projected to the browser. */
export const Config = z.object({
  [REMEMBERED_EFFORTS_FIELD]: ModelEffortSettingsFields[REMEMBERED_EFFORTS_FIELD].volatile(),
})

/**
 * The model menus own this preference, so Settings generates no page for it.
 * @param ctx - Host plugin context used for optional settings presentation.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}

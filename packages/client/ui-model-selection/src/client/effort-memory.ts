/**
 * Remembered per-model reasoning effort over the plugin's settings namespace.
 * Selecting a model reuses the effort last chosen for that exact route instead
 * of resetting to the adapter default, so the two selection entries preselect
 * what the user last ran on that model.
 *
 * Reads derive from the shared settings mirror (no wire read of its own) and
 * writes go through the scope's serialized `set`. A remembered effort is
 * advisory: the adapter owns the effort vocabulary and can drop or rename a
 * level between runs, so every read is filtered against the model's current
 * metadata before it reaches a selection.
 */
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelCatalogModel } from './slots.ts'
import {
  MODEL_EFFORT_SETTINGS_NAMESPACE, REMEMBERED_EFFORTS_FIELD, effortKey,
  type ModelEffortSettings,
} from '../effort-settings.ts'

/** Namespace spec bound by the plugin's apply. */
export const MODEL_EFFORT_SCOPE = { namespace: MODEL_EFFORT_SETTINGS_NAMESPACE }

/**
 * Cap on remembered routes. The map accretes one entry per model ever
 * selected, and settings sections are read whole on every describe, so the
 * oldest entries are dropped rather than letting one document grow without
 * bound. Ten times a plausible working set of models.
 */
const MAX_REMEMBERED = 200

/** Reads and writes one route's remembered effort. */
export class EffortMemory {
  /** @param scope - the plugin's bound settings namespace scope. */
  constructor(private readonly scope: SettingsScope<ModelEffortSettings>) {}

  /**
   * Resolve the effort to apply when selecting one model, preferring what the
   * user last chose for that exact route over the adapter's declared default.
   * A remembered level the adapter no longer offers is ignored.
   * @param provider - registered provider route id.
   * @param model - the catalog entry being selected.
   * @returns the effort id, or undefined for provider/default behavior.
   */
  effortFor(provider: string, model: ModelCatalogModel): string | undefined {
    const remembered = this.stored()[effortKey(provider, model.id)]
    if (remembered === undefined) return model.reasoning?.defaultEffort
    // An explicit provider-default choice is stored as null and must survive
    // as "no effort", which is exactly what a declared default would override.
    if (remembered === null) return undefined
    if (model.reasoning?.efforts.some(level => level.id === remembered) !== true) {
      return model.reasoning?.defaultEffort
    }
    return remembered
  }

  /**
   * Record the effort selected for one route. Failures are swallowed: the
   * selection itself already landed on the Host, and a settings document that
   * refused the write must not fail the model switch the user asked for.
   * @param provider - registered provider route id.
   * @param model - provider-owned model id.
   * @param effort - selected effort, or undefined for an explicit provider default.
   * @returns settlement after the queued write.
   */
  async remember(provider: string, model: string, effort: string | undefined): Promise<void> {
    const key = effortKey(provider, model)
    // Deleting before setting moves a re-selected route to the end, so
    // insertion order stays least-recently-written first for the cap below.
    const entries = new Map(Object.entries(this.stored()))
    entries.delete(key)
    entries.set(key, effort ?? null)
    const next = Object.fromEntries([...entries].slice(-MAX_REMEMBERED))
    try {
      await this.scope.set(REMEMBERED_EFFORTS_FIELD, next)
    } catch (_rememberedEffortWriteFailure) {
      // The scope already reloaded Host state for a failed latest write; the
      // next selection re-reads it and writes again from that value.
    }
  }

  private stored(): Record<string, string | null> {
    return this.scope.getSnapshot().value?.[REMEMBERED_EFFORTS_FIELD] ?? {}
  }
}

/**
 * ModelSelect's injected face. The target 'conversation.input.model' seat is
 * declared (children table) and typed by ui-conversation's composer-bar
 * entry; this package only contributes the single occupant, so no SlotMap
 * merge lives here.
 */
import type { ModelProviderGroup, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelDirectoryState } from './directory.ts'

/**
 * One catalog model as its provider group carries it. Derived rather than
 * imported: the wire package re-exports the group, not its element type.
 */
export type ModelCatalogModel = ModelProviderGroup['models'][number]

/** Injected business face of the composer model seat. */
export interface ModelSelectInjected {
  /** Whether this session supports Agent-bound model inspection and selection. */
  available: boolean
  /** The session's shared directory store (same instance the /model popup reads). */
  directory: SnapshotStore<ModelDirectoryState>
  /** Refresh the advisory directory (fire-and-forget; errors land on the store). */
  load: () => void
  /**
   * Resolve the effort to preselect when switching to one model: the level
   * last chosen for that exact route, else the adapter's declared default.
   * @param provider - registered provider route id.
   * @param model - the catalog entry being selected.
   * @returns the effort id, or undefined for provider/default behavior.
   */
  effortFor: (provider: string, model: ModelCatalogModel) => string | undefined
  /**
   * Record the effort the user chose for one route, so a later switch back to
   * that model preselects it. Fire-and-forget: the selection it accompanies
   * already landed on the Host.
   * @param provider - registered provider route id.
   * @param model - provider-owned model id.
   * @param effort - selected effort, or undefined for an explicit provider default.
   */
  rememberEffort: (provider: string, model: string, effort: string | undefined) => void
  /**
   * Select a complete provider/model/reasoning selection.
   * @param selection - model selection and optional adapter-owned effort.
   * @returns whether the host accepted the selection.
   */
  select: (selection: ModelSelection) => Promise<boolean>
}

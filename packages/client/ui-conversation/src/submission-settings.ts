/** Busy-Enter preference stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the conversation plugin. */
export const CONVERSATION_SETTINGS_NAMESPACE = 'ui-conversation'

/** Field carrying the delivery mode for plain Enter while an agent is busy. */
export const BUSY_ENTER_FIELD = 'busyEnter'

/** Busy-Enter behaviors accepted at settings and input boundaries. */
export const BUSY_ENTER_BEHAVIORS = ['queue', 'steer'] as const

/** Configurable meaning of plain Enter while the addressed agent is busy. */
export type BusyEnterBehavior = typeof BUSY_ENTER_BEHAVIORS[number]

/** Default preserves Enter-as-Queue for running conversations. */
export const DEFAULT_BUSY_ENTER_BEHAVIOR: BusyEnterBehavior = 'queue'

/** Field carrying whether settled steps collapse behind one per-turn summary. */
export const COLLAPSE_SETTLED_STEPS_FIELD = 'collapseSettledSteps'

/**
 * Default collapses settled steps.
 *
 * A turn's earlier steps are the bulk of a long transcript and rarely what a
 * reader is looking for, and collapsing is also what lets history page by
 * digest instead of by whole step — so the default reading mode both shows
 * less noise and reaches much further back before paging.
 */
export const DEFAULT_COLLAPSE_SETTLED_STEPS = true

/** Durable conversation section shared by the Host schema and the browser scope. */
export interface ConversationSettings {
  /** Delivery mode for plain Enter while the addressed agent is busy. */
  busyEnter: BusyEnterBehavior
  /** Whether a turn's settled steps collapse behind one expandable summary row. */
  collapseSettledSteps: boolean
}

/** Durable conversation schema; also the wire envelope the browser scope validates against. */
export const ConversationSettingsSchema: z<ConversationSettings> = z.object({
  [BUSY_ENTER_FIELD]: z.union([...BUSY_ENTER_BEHAVIORS]).default(DEFAULT_BUSY_ENTER_BEHAVIOR),
  [COLLAPSE_SETTLED_STEPS_FIELD]: z.boolean().default(DEFAULT_COLLAPSE_SETTLED_STEPS),
})

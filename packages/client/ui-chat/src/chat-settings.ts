/** Chat transcript preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the Chat target. */
export const CHAT_SETTINGS_NAMESPACE = 'ui-chat'

/** Field carrying the transcript presentation mode. */
export const TRANSCRIPT_VIEW_FIELD = 'transcriptView'

/**
 * Transcript presentation modes accepted at settings boundaries.
 *
 * `normal` renders every row. `compact` folds a completed Turn's process rows
 * behind one control once the Turn ends with a final answer. `collapsed`
 * folds each Turn's settled steps behind one summary row while the Turn is
 * still running, keeping only its latest step rendered.
 */
export const TRANSCRIPT_VIEW_MODES = ['normal', 'compact', 'collapsed'] as const

/** Transcript presentation. */
export type TranscriptViewMode = typeof TRANSCRIPT_VIEW_MODES[number]

/** Default preserves the compact process disclosure introduced by Chat. */
export const DEFAULT_TRANSCRIPT_VIEW_MODE: TranscriptViewMode = 'compact'

/** Durable Chat section shared by the Host schema and browser scope. */
export interface ChatSettings {
  /** Presentation mode for Turn process content. */
  transcriptView: TranscriptViewMode
}

/** Durable Chat schema; also the wire envelope the browser scope validates against. */
export const ChatSettingsSchema: z<ChatSettings> = z.object({
  [TRANSCRIPT_VIEW_FIELD]: z.union([...TRANSCRIPT_VIEW_MODES]).default(DEFAULT_TRANSCRIPT_VIEW_MODE),
})

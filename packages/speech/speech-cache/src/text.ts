/**
 * Selection of the prose a completed turn should read aloud.
 * @module @deepseek-ai/dsh-speech-cache/text
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'

/** One turn's closing assistant message: its identity and its spoken prose. */
export interface SpokenMessage {
  /** Stable identity of the finalized model output. */
  readonly messageId: MessageId
  /** Concatenated `text` block content, with no reasoning or tool arguments. */
  readonly text: string
}

/**
 * Concatenate the speakable prose of one assistant message.
 *
 * `reasoning` blocks are thinking traces rather than prose addressed to the
 * reader, and `tool-call` blocks carry arguments; neither is spoken.
 *
 * @param content - the assistant message's content blocks.
 * @returns the concatenated text, empty when the message carries no text block.
 */
export function spokenText(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
}

/**
 * Find the closing assistant message of one turn.
 *
 * The turn's last `assistant/message` is its closing step: earlier steps of a
 * multi-step turn end in tool calls rather than a reply to the reader.
 *
 * @param events - the session's events, in log order.
 * @param turn - the turn whose closing message is wanted.
 * @returns the closing message, or `undefined` when the turn finalized no
 *   message or that message carries no spoken prose.
 */
export function closingMessageOf(
  events: readonly SessionEvent[],
  turn: number,
): SpokenMessage | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    if (event.data.turn !== turn) continue
    const message = event.data.message
    const text = spokenText(message.content).trim()
    return text.length === 0 ? undefined : { messageId: message.id, text }
  }
  return undefined
}

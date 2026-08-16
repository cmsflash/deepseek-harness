/** `speech` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'action.play': '朗读回答',
  'action.stop': '停止朗读',
  'action.loading': '正在准备语音…',
  'error.generic': '语音播放失败',
} satisfies Record<string, string>

/** The speech namespace key union. */
export type MessageSpeechKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The per-message read-aloud control's copy. */
    speech: MessageSpeechKey
  }
}

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'action.play': 'Read aloud',
  'action.stop': 'Stop reading',
  'action.loading': 'Preparing audio…',
  'error.generic': 'Could not play audio',
} satisfies Record<MessageSpeechKey, string>

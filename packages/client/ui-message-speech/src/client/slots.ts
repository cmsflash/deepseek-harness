/**
 * The speech entry's injected face. The target
 * 'conversation.chat.assistant-actions' slot is declared and typed by
 * ui-conversation; this package only contributes the entry, so no SlotMap
 * merge lives here. Live playback state arrives through the `speech` hook
 * (the framework standard kit binds it into `useSpeech`); inject carries the
 * one verb.
 * @module @deepseek-ai/dsh-client-ui-message-speech/client/slots
 */

import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls this package's LocaleNamespaceMap merge (the 'speech' seat).
import type {} from './locales.ts'
import type { SpeechPlaybackView } from './player.ts'

/** Injected business face of one assistant-message read-aloud entry. */
export interface MessageSpeechInjected {
  hooks: {
    /** The owning Session's playback state, shared by every message control. */
    speech: HostObservable<SpeechPlaybackView>
  }
  /**
   * Start reading one message aloud, or stop it when it is already playing.
   * Audio is normally already cached, so playback starts without a synthesis
   * round trip; a miss regenerates and is an ordinary outcome.
   * @param messageId - target assistant message.
   */
  toggle: (messageId: MessageId) => void
}

/** Full props of one assistant-message read-aloud entry. */
export type MessageSpeechActionProps =
  PropsRuntime<'conversation.chat.assistant-actions'>
  & InjectFace<MessageSpeechInjected>
  & PropsLocale<'speech'>

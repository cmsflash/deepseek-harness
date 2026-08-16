/**
 * Per-message read-aloud control: one button in the assistant message's
 * IconActions row that plays the audio synthesized when the turn ended.
 * @module @deepseek-ai/dsh-client-ui-message-speech/client/MessageSpeechAction
 */

import { useCallback } from 'react'
import {
  IconLoadingOutline16, IconPlayOutline16, IconStopFill16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MessageSpeechActionProps } from './slots.ts'
import css from './MessageSpeechAction.module.css'

/**
 * One message's read-aloud button.
 * @param props - the owner's message identity, the injected verb, and the
 * shared playback hook.
 * @returns the play/stop control.
 */
export function MessageSpeechAction({ messageId, toggle, useSpeech, t }: MessageSpeechActionProps) {
  const status = useSpeech(view => (view.activeMessageId === messageId ? view.status : 'idle'))
  const onClick = useCallback(() => { toggle(messageId) }, [messageId, toggle])
  const label = status === 'loading'
    ? t('action.loading')
    : status === 'error'
      ? t('error.generic')
      : status === 'playing' ? t('action.stop') : t('action.play')
  const variant = status === 'playing'
    ? css.active
    : status === 'loading' ? css.loading : status === 'error' ? css.failed : undefined
  const className = variant === undefined ? css.action : `${css.action} ${variant}`
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-pressed={status === 'playing'}
        onClick={onClick}
      >
        {status === 'loading'
          ? <IconLoadingOutline16 />
          : status === 'playing' ? <IconStopFill16 /> : <IconPlayOutline16 />}
      </button>
    </Tooltip>
  )
}

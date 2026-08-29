// @vitest-environment jsdom
/**
 * MessageSpeechAction presentation: the control reflects only its own
 * message's playback state and reports it to assistive technology.
 */
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import { MessageSpeechAction } from '../src/client/MessageSpeechAction.tsx'
import type { SpeechPlaybackView } from '../src/client/player.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const MSG = 'm-1' as MessageId
const OTHER = 'm-2' as MessageId

/** Render the control against a fixed playback view. */
function renderAction(view: SpeechPlaybackView, toggle = vi.fn()) {
  const props = {
    messageId: MSG,
    toggle,
    useSpeech: (select: (value: SpeechPlaybackView) => unknown) => select(view),
    t: (key: string) => en[key as keyof typeof en] ?? key,
  } as unknown as ComponentProps<typeof MessageSpeechAction>
  render(<MessageSpeechAction {...props} />)
  return { toggle }
}

const idle: SpeechPlaybackView = { activeMessageId: undefined, status: 'idle' }

describe('MessageSpeechAction', () => {
  it('offers to read the message aloud when nothing is playing', () => {
    renderAction(idle)
    expect(screen.getByRole('button', { name: en['action.play'] })).toBeTruthy()
  })

  it('offers to stop while this message is playing', () => {
    renderAction({ activeMessageId: MSG, status: 'playing' })
    const button = screen.getByRole('button', { name: en['action.stop'] })
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  it('stays idle while a different message is playing', () => {
    renderAction({ activeMessageId: OTHER, status: 'playing' })
    expect(screen.getByRole('button', { name: en['action.play'] })).toBeTruthy()
  })

  it('announces that audio is being prepared', () => {
    renderAction({ activeMessageId: MSG, status: 'loading' })
    expect(screen.getByRole('button', { name: en['action.loading'] })).toBeTruthy()
  })

  it('announces a failure without hiding the control', () => {
    renderAction({ activeMessageId: MSG, status: 'error' })
    expect(screen.getByRole('button', { name: en['error.generic'] })).toBeTruthy()
  })

  it('toggles its own message when clicked', () => {
    const { toggle } = renderAction(idle)
    screen.getByRole('button').click()
    expect(toggle).toHaveBeenCalledWith(MSG)
  })
})

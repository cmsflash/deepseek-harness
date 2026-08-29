/**
 * Read-aloud plugin, browser half: the play/stop entry in the
 * conversation.chat.assistant-actions strip. One SpeechPlayer per Session
 * backs every message control in that Session, so starting one reply stops
 * whatever was playing. Audio is fetched through the generated readAloud
 * Remote; the Host resolves the spoken text from its own Session log, so this
 * half sends message identity and never prose.
 * @module @deepseek-ai/dsh-client-read-aloud/client
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap merge (the assistant-actions entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { MessageSpeechAction } from './MessageSpeechAction.tsx'
import { SpeechPlayer } from './player.ts'
import type { MessageSpeechInjected } from './slots.ts'
import { en, zh } from './locales.ts'

export type { MessageSpeechActionProps, MessageSpeechInjected } from './slots.ts'
export type { SpeechPlaybackStatus, SpeechPlaybackView } from './player.ts'
export type { MessageSpeechKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'speech'

/** Required services: the slot registry, the Remote namespace, and the copy. */
export const inject = ['slots', 'remote', 'remote.readAloud', 'locale']

/**
 * Client plugin body: the per-message read-aloud entry and its per-session
 * playback layer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'read-aloud: dictionaries')

  const players = new Map<SessionId, SpeechPlayer>()
  const playerFor = (sessionId: SessionId): SpeechPlayer => {
    let player = players.get(sessionId)
    if (player === undefined) {
      player = new SpeechPlayer(async (messageId) => {
        const reply = await ctx.remote.readAloud.audio({ sessionId, messageId })
        if (!reply.ok || !reply.value.ok) return undefined
        return { data: reply.value.value.data, mediaType: reply.value.value.mediaType }
      })
      players.set(sessionId, player)
    }
    return player
  }

  // A dropped connection cannot be recovered mid-stream, and audio outliving
  // its transport would keep speaking into a disconnected UI.
  ctx.on('connection/reset', () => {
    for (const player of players.values()) player.stop()
  })

  ctx.slots.inject('conversation.chat.assistant-actions', () => {
    const dispose = ctx.slots.register({
      name: 'conversation.chat.assistant-actions',
      id: 'speech',
      order: 20,
      locale: NS,
      inject: (sessionId): MessageSpeechInjected => {
        const player = playerFor(sessionId)
        return {
          hooks: { speech: player },
          toggle: (messageId) => { void player.toggle(messageId) },
        }
      },
    }, MessageSpeechAction)
    return () => {
      dispose()
      for (const player of players.values()) player.dispose()
      players.clear()
    }
  })
}

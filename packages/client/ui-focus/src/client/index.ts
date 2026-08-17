/**
 * Browser focus-view plugin: contributes one entry to the conversation view
 * slot that renders the latest turn in full over collapsed per-turn metric
 * rows. Additive — it defines no service and replaces no shipped surface.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register call to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { FocusView, type FocusViewInjected } from './FocusView.tsx'
import { en, NS, zh } from './locales.ts'

/** Required services: the conversation slot, ordinary Session paging, and the locale service. */
export const inject = ['slots', 'sessions', 'locale']

/**
 * Client plugin body: register the focus view tab. The registration rides the
 * slot service's effect wrapper, so plugin unload removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-focus: dictionaries')
  // Registration-time text (the view tab label) reads through the bound
  // translate as a thunk, so it follows the active locale without
  // re-registration.
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'focus',
    order: 5,
    locale: NS,
    label: () => t('view.focus'),
    inject: (sessionId: SessionId): FocusViewInjected => {
      const session = ctx.sessions.binding(sessionId)?.session
      if (session === undefined) {
        throw new Error(`ui-focus: session "${sessionId}" is unavailable`)
      }
      return {
        loadOlder: () => { void session.loadOlder() },
      }
    },
  }, FocusView))
}

/** The composer seat docks beneath a fullscreen right panel. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
const docked = String.raw`:global\(\[data-rightbar-fullscreen\]\) \.root\[data-phase='active'\] \.scrollBody`

describe('docked composer seat', () => {
  it('spans the area the fullscreen panel covers, above the panel dock and below its floats', () => {
    const seat = css.match(new RegExp(String.raw`${docked} > \.composerSeat\s*\{([^}]*)\}`))?.[1]
    expect(seat).toContain('position: fixed')
    expect(seat).toContain('left: var(--dsh-sidebar-width, 0px)')
    expect(seat).toContain('z-index: 45')
    expect(seat).toContain('background: var(--dsw-alias-bg-base)')
  })

  it('fades the end of the panel into the seat without taking its pointer events', () => {
    const fade = css.match(new RegExp(String.raw`${docked} > \.composerSeat::before\s*\{([^}]*)\}`))?.[1]
    expect(fade).toContain('bottom: 100%')
    expect(fade).toContain('height: 36px')
    expect(fade).toContain('pointer-events: none')
  })

  it('keeps the transcript scroll height except under a view-owned composer overlay', () => {
    const spacer = css.match(new RegExp(String.raw`${docked}:not\(:has\(\[data-conversation-composer-overlay\]\)\)::after\s*\{([^}]*)\}`))?.[1]
    expect(spacer).toContain('height: var(--dsh-composer-height, 0px)')
  })

  it('docks without motion when reduced motion is requested', () => {
    expect(css).toMatch(new RegExp(String.raw`@media \(prefers-reduced-motion: reduce\)\s*\{\s*${docked} > \.composerSeat\s*\{\s*animation: none;`))
  })
})

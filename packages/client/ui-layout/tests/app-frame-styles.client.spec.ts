/**
 * The frame's overflow declarations as CSS text. jsdom resolves no layout, so
 * this reads the rules that keep a collapsed right panel — mounted at its full
 * width past the frame's edge (ui-sidebar-right `.panel`) — out of the frame's
 * scrollable overflow. The assembled-browser proof is the sidebar-right web
 * e2e case that focuses the composer against a collapsed panel.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/AppFrame.module.css', import.meta.url)), 'utf8')
const declarationText = css.replace(/\/\*[\s\S]*?\*\//g, ' ')

function declarations(selector: string): string[] {
  const rule = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.[\]():*+^$\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(declarationText)
  if (rule === null) throw new Error(`AppFrame.module.css has no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('AppFrame.module.css overflow', () => {
  it('clips the frame instead of making it a scroll container', () => {
    // `overflow: hidden` is programmatically scrollable: a focus() scroll walk
    // from the composer would carry the whole frame sideways by the width of
    // the hidden panel past its right edge.
    expect(declarations('.frame')).toContain('overflow: clip')
    expect(declarations('.frame')).not.toContain('overflow: hidden')
  })

  it('lets the right column overflow only while it has a track', () => {
    expect(declarations('.rightbarCol')).toContain('overflow: visible')
    expect(declarations('.frame[data-rightbar-collapsed] .rightbarCol')).toEqual(['overflow: clip'])
  })

  it('drops the right column from the mobile layout entirely', () => {
    expect(declarations('.frame[data-overlay] .rightbarCol')).toEqual(['display: none'])
  })
})

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

  it('lets the right column overflow only while it has a track or a fullscreen panel', () => {
    expect(declarations('.rightbarCol')).toContain('overflow: visible')
    // A narrow viewport's automatic fullscreen keeps no track, so the panel
    // spans the frame from the zero-width column the clip would cut it to.
    expect(declarations('.frame[data-rightbar-collapsed]:not([data-rightbar-fullscreen]) .rightbarCol')).toEqual(['overflow: clip'])
  })

  it('anchors the trackless mobile right column at the frame edge over the conversation row', () => {
    // A fullscreen panel opened on a phone covers the conversation from this
    // column, so the column stays rendered rather than dropped from layout.
    expect(declarations('.frame[data-overlay] .rightbarCol')).toEqual([
      'position: absolute', 'grid-area: 1 / 1 / 2 / -1', 'inset-block: 0', 'inset-inline-end: 0', 'width: 0',
    ])
  })
})

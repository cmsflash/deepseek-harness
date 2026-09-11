import { describe, expect, it } from 'vitest'
import {
  clampWidth, computeColumns, DRAWER_MAX, DRAWER_PEEK, MOBILE_MAX,
} from '../src/client/columns.ts'

describe('clampWidth', () => {
  it('clamps into the range and rounds', () => {
    expect(clampWidth(250.4, 240, 420)).toBe(250)
    expect(clampWidth(100, 240, 420)).toBe(240)
    expect(clampWidth(9999, 240, 420)).toBe(420)
  })
})

describe('computeColumns', () => {
  it('gives each edge column its preference when the center has enough room', () => {
    expect(computeColumns(1920, 280, 864)).toEqual({ sidebar: 280, center: 776, rightbar: 864, overlay: false })
  })

  it('keeps only the left rail when both panels are closed', () => {
    expect(computeColumns(1920, 0, 0)).toEqual({ sidebar: 56, center: 1864, rightbar: 0, overlay: false })
  })

  it('clamps sidebar preferences and limits the right panel to 70% of the frame', () => {
    expect(computeColumns(3000, 9999, 9999)).toEqual({ sidebar: 420, center: 480, rightbar: 2100, overlay: false })
    expect(computeColumns(1920, 1, 1)).toEqual({ sidebar: 264, center: 1356, rightbar: 300, overlay: false })
  })

  it.each([
    [1300, 280, 620, 400],
    [1100, 280, 420, 400],
    [1120, 420, 300, 400],
    [1119, 420, 0, 699],
    [1024, 420, 0, 604],
    [756, 0, 300, 400],
    [755, 0, 0, 699],
    [641, 0, 0, 585],
  ])('solves frame %i and sidebar %i to right %i and center %i', (viewport, sidebar, rightbar, center) => {
    expect(computeColumns(viewport, sidebar, 864)).toEqual({ sidebar: sidebar || 56, center, rightbar, overlay: false })
  })

  it('does not reduce the wide sidebar to keep a normal right panel open', () => {
    expect(computeColumns(1024, 420, 500)).toEqual({ sidebar: 420, center: 604, rightbar: 0, overlay: false })
  })

  it('restores a still-open preference when the frame widens', () => {
    expect(computeColumns(1100, 280, 864).rightbar).toBe(420)
    expect(computeColumns(1920, 280, 864).rightbar).toBe(864)
  })

  it('leaves a closed right track closed when the frame widens', () => {
    expect(computeColumns(755, 0, 0).rightbar).toBe(0)
    expect(computeColumns(1920, 0, 0).rightbar).toBe(0)
  })
})

describe('computeColumns — mobile overlay layout', () => {
  // Real device widths: iPhone SE/13 mini, iPhone 14/15, and a large phone.
  const PHONES = [375, 390, 414]

  it('gives center the whole viewport, with no rail and no right track', () => {
    for (const viewport of PHONES) {
      expect(computeColumns(viewport, 0, 0)).toEqual({ sidebar: 0, center: viewport, rightbar: 0, overlay: true })
    }
  })

  it('never lets an open sidebar or right panel steal width from the conversation', () => {
    for (const viewport of PHONES) {
      const drawerOpen = computeColumns(viewport, 280, 864)
      expect(drawerOpen.center).toBe(viewport)
      expect(drawerOpen.rightbar).toBe(0)
      expect(drawerOpen.overlay).toBe(true)
      // The drawer floats: it is sized, but it is not part of the flow.
      expect(drawerOpen.sidebar).toBeGreaterThan(0)
    }
  })

  it('sizes the drawer to leave a dismissable strip of the conversation', () => {
    // Narrow phones are peek-bound; from DRAWER_MAX + DRAWER_PEEK up the
    // ceiling binds instead, so the drawer never becomes a second column.
    const narrow = 320
    expect(computeColumns(narrow, 280, 0).sidebar).toBe(narrow - DRAWER_PEEK)
    expect(computeColumns(390, 280, 0).sidebar).toBe(DRAWER_MAX)
    expect(computeColumns(MOBILE_MAX, 280, 0).sidebar).toBe(DRAWER_MAX)
    for (const viewport of PHONES) {
      expect(viewport - computeColumns(viewport, 280, 0).sidebar).toBeGreaterThanOrEqual(DRAWER_PEEK)
    }
  })

  it('switches layouts exactly at MOBILE_MAX', () => {
    expect(computeColumns(MOBILE_MAX, 0, 0).overlay).toBe(true)
    expect(computeColumns(MOBILE_MAX + 1, 0, 0).overlay).toBe(false)
  })

  it('is pure across the breakpoint: re-widening restores the column layout', () => {
    expect(computeColumns(390, 280, 864).overlay).toBe(true)
    expect(computeColumns(1920, 280, 864)).toEqual({ sidebar: 280, center: 776, rightbar: 864, overlay: false })
  })
})

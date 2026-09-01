// Web e2e scenario: at phone viewports the frame is a single full-width
// column and the sidebar is an overlay drawer. Before the mobile layout the
// solver had no breakpoint, so a closed sidebar still held a 56px rail beside
// the conversation and an opened one took 280px of a 390px screen — the
// conversation kept 110px. These assertions pin the properties that fix
// depends on: the conversation owns the full width in both drawer states, the
// page never scrolls horizontally, and the drawer is reachable and dismissable.
//
// Widths come from getBoundingClientRect through the real engine: jsdom
// resolves no layout, and the package specs already cover the pure solver.
// The golden records viewport-relative facts (full-width, no horizontal
// scroll, disjoint controls), never absolute pixels, whose values depend on
// installed fonts and differ between macOS and Linux.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/mobile-viewport', import.meta.url))
const LAYOUT_EXPECTED = join(SNAPSHOT_DIR, 'layout.expected.md')
const MODE = webSnapshotMode()

/** iPhone 14/15 logical width — the reported phone case. */
const PHONE = { width: 390, height: 844 } as const
/** Smallest phone still in common use; the drawer is peek-bound at this width. */
const SMALL_PHONE = { width: 375, height: 812 } as const

/** Frame geometry as the browser resolved it. */
interface FrameGeometry {
  overlay: boolean
  centerWidth: number
  documentScrollWidth: number
  viewportWidth: number
  drawerWidth: number
  scrimPresent: boolean
  openerPresent: boolean
}

/**
 * Read the frame's resolved geometry.
 * @param page - the page under test.
 * @returns the measured geometry.
 */
async function readFrame(page: Page): Promise<FrameGeometry> {
  return page.evaluate(() => {
    const frame = document.querySelector('[class*="frame"]')
    if (frame === null) throw new Error('no frame element')
    const center = frame.querySelector('[class*="centerCol"]')
    if (center === null) throw new Error('no center column')
    const drawer = frame.querySelector('[class*="sidebarCol"]')
    if (drawer === null) throw new Error('no sidebar column')
    return {
      overlay: frame.hasAttribute('data-overlay'),
      centerWidth: Math.round(center.getBoundingClientRect().width),
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      drawerWidth: Math.round(drawer.getBoundingClientRect().width),
      scrimPresent: frame.querySelector('[role="presentation"]') !== null,
      openerPresent: frame.querySelector('[class*="drawerOpener"]') !== null,
    }
  })
}

describe('web e2e: the phone viewport renders one full-width column', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await chromium.launch()
    // Connect the workspace at a desktop width: the sidebar controls that
    // flow live in the drawer on a phone, and this scenario is about the
    // frame's geometry rather than the connect flow.
    page = await newEnglishPage(browser)
    await page.setViewportSize({ width: 1280, height: 900 })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    expect(tripwire.pageErrors).toEqual([])
  })

  it('gives the conversation the whole width and keeps the drawer reachable', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-viewport'))
    await page.setViewportSize(PHONE)
    await expect.poll(async () => (await readFrame(page)).overlay, { timeout: 15_000 }).toBe(true)

    // Closed: the conversation spans the frame — no rail, no details column.
    const closed = await readFrame(page)
    expect(closed.centerWidth).toBe(PHONE.width)
    expect(closed.drawerWidth).toBe(0)
    expect(closed.openerPresent).toBe(true)
    expect(closed.scrimPresent).toBe(false)
    expect(closed.documentScrollWidth).toBe(closed.viewportWidth)

    // Opening the drawer must not take width from the conversation.
    await page.locator('[class*="drawerOpener"]').click()
    await expect.poll(async () => (await readFrame(page)).scrimPresent, { timeout: 10_000 }).toBe(true)
    const open = await readFrame(page)
    expect(open.centerWidth).toBe(PHONE.width)
    expect(open.drawerWidth).toBeGreaterThan(0)
    // A strip of the conversation stays visible as the dismiss target.
    expect(open.drawerWidth).toBeLessThan(PHONE.width)
    expect(open.documentScrollWidth).toBe(open.viewportWidth)

    // The scrim dismisses it and the opener comes back. The drawer covers
    // the scrim's center, so the tap lands on the peek strip beside it —
    // the part of the scrim a user can actually reach.
    const peekX = open.drawerWidth + (PHONE.width - open.drawerWidth) / 2
    await page.locator('[role="presentation"]').click({
      position: { x: peekX, y: PHONE.height / 2 },
    })
    await expect.poll(async () => (await readFrame(page)).openerPresent, { timeout: 10_000 }).toBe(true)
    expect((await readFrame(page)).scrimPresent).toBe(false)

    const golden = [
      '# Frame geometry at the 390×844 phone viewport',
      '',
      '- Overlay layout active: ' + (closed.overlay ? 'true' : 'false'),
      '- Conversation spans the viewport (drawer closed): ' + (closed.centerWidth === PHONE.width ? 'true' : 'false'),
      '- Conversation spans the viewport (drawer open): ' + (open.centerWidth === PHONE.width ? 'true' : 'false'),
      '- Closed drawer takes no width: ' + (closed.drawerWidth === 0 ? 'true' : 'false'),
      '- Open drawer leaves a dismissable strip: ' + (open.drawerWidth < PHONE.width ? 'true' : 'false'),
      '- No horizontal page scroll: ' + (closed.documentScrollWidth === closed.viewportWidth ? 'true' : 'false'),
    ].join('\n').trimEnd()
    await compareOrRefreshGolden(LAYOUT_EXPECTED, golden, MODE)
  }, 90_000)

  it('holds the single-column layout on a smaller phone', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-viewport-small'))
    await page.setViewportSize(SMALL_PHONE)
    await expect.poll(async () => (await readFrame(page)).centerWidth, { timeout: 15_000 })
      .toBe(SMALL_PHONE.width)
    const geometry = await readFrame(page)
    expect(geometry.overlay).toBe(true)
    expect(geometry.documentScrollWidth).toBe(geometry.viewportWidth)
  }, 60_000)

  it('returns to the column layout when the window widens back to desktop', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-viewport-restore'))
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect.poll(async () => (await readFrame(page)).overlay, { timeout: 15_000 }).toBe(false)
    const geometry = await readFrame(page)
    // The sidebar is a real column again, so it takes width beside the center.
    expect(geometry.drawerWidth).toBeGreaterThan(0)
    expect(geometry.centerWidth).toBeLessThan(1280)
    expect(geometry.openerPresent).toBe(false)
  }, 60_000)
})

// Web e2e scenario: at phone viewports the thread list and the conversation
// are two full-screen views, and the browser's back action leaves the top
// one. These assertions pin what this layout depends on: whichever view is
// on screen owns the full width, the page never scrolls horizontally, the
// frame's back control and the browser history both return to the list, and
// a fullscreen right panel is one more view a back action closes.
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

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/mobile-viewport', import.meta.url))
const LAYOUT_EXPECTED = join(SNAPSHOT_DIR, 'layout.expected.md')
const KEYBOARD_EXPECTED = join(SNAPSHOT_DIR, 'keyboard.expected.md')
const MODE = webSnapshotMode()

/** iPhone 14/15 logical width — the reported phone case. */
const PHONE = { width: 390, height: 844 } as const
/** Smallest phone still in common use. */
const SMALL_PHONE = { width: 375, height: 812 } as const
/** An iPhone keyboard with its suggestion bar, in CSS pixels. */
const KEYBOARD_HEIGHT = 380

/** The stand-in keyboard the init script installs, as the page sees it. */
interface KeyboardStandIn {
  /** Open the keyboard at `height`, or close it with 0, panning the page the way iOS Safari does. */
  show(height: number): void
  /** The current page pan. */
  pan(): number
}

/**
 * Replace the visual viewport with one that reports an on-screen keyboard the
 * way iOS Safari does: the layout viewport keeps its height, the visual
 * viewport shrinks, and the page pans down by the keyboard height until
 * `scrollTo` moves it back. Chromium has no on-screen keyboard to emulate.
 */
function installKeyboardStandIn(): void {
  const native = window.visualViewport!
  const viewport = new EventTarget()
  let keyboard = 0
  let pan = 0
  for (const name of ['width', 'offsetLeft', 'pageLeft', 'scale'] as const) {
    Object.defineProperty(viewport, name, { get: () => native[name] })
  }
  Object.defineProperty(viewport, 'height', { get: () => native.height - keyboard })
  Object.defineProperty(viewport, 'offsetTop', { get: () => pan })
  Object.defineProperty(viewport, 'pageTop', { get: () => window.scrollY + pan })
  Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => viewport })
  const scrollTo = window.scrollTo.bind(window)
  window.scrollTo = ((...args: Parameters<typeof window.scrollTo>) => {
    pan = 0
    scrollTo(...args)
    viewport.dispatchEvent(new Event('scroll'))
  }) as typeof window.scrollTo
  const standIn: KeyboardStandIn = {
    show: (height) => {
      keyboard = height
      pan = height
      viewport.dispatchEvent(new Event('resize'))
    },
    pan: () => pan,
  }
  ;(window as { __dshKeyboard?: KeyboardStandIn }).__dshKeyboard = standIn
}

/** Where the keyboard leaves the phone's application, as the browser resolved it. */
interface KeyboardGeometry {
  viewportMeta: string
  rootHeight: number
  frameBottom: number
  composerBottom: number
  backTop: number
  pan: number
}

/**
 * Read the mount point, frame, composer, and back control boxes and the page pan.
 * @param page - the page under test.
 * @returns the measured geometry.
 */
async function readKeyboardGeometry(page: Page): Promise<KeyboardGeometry> {
  return page.evaluate(() => {
    const box = (selector: string): DOMRect => {
      const element = document.querySelector(selector)
      if (element === null) throw new Error(`no ${selector}`)
      return element.getBoundingClientRect()
    }
    return {
      viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
      rootHeight: Math.round(box('#root').height),
      frameBottom: Math.round(box('[class*="frame"]').bottom),
      composerBottom: Math.round(box('[data-composer-input]').bottom),
      backTop: Math.round(box('[class*="backButton"]').top),
      pan: (window as { __dshKeyboard?: KeyboardStandIn }).__dshKeyboard!.pan(),
    }
  })
}

/** Frame geometry as the browser resolved it. */
interface FrameGeometry {
  overlay: boolean
  listShown: boolean
  listLeft: number
  listWidth: number
  centerLeft: number
  centerWidth: number
  documentScrollWidth: number
  viewportWidth: number
  backPresent: boolean
  depth: number
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
    const list = frame.querySelector('[class*="sidebarCol"]')
    if (list === null) throw new Error('no sidebar column')
    const listBox = list.getBoundingClientRect()
    const centerBox = center.getBoundingClientRect()
    // The thread page carries the slide; the center column moves inside it.
    const pageBox = (frame.querySelector('[class*="threadPage"]') ?? center).getBoundingClientRect()
    return {
      overlay: frame.hasAttribute('data-overlay'),
      listShown: !list.hasAttribute('inert'),
      listLeft: Math.round(listBox.left),
      listWidth: Math.round(listBox.width),
      centerLeft: Math.round(Math.max(centerBox.left, pageBox.left)),
      centerWidth: Math.round(centerBox.width),
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      backPresent: frame.querySelector('[class*="backButton"]') !== null,
      depth: (history.state as { dshPhoneDepth?: number } | null)?.dshPhoneDepth ?? 0,
    }
  })
}

/**
 * Wait until the view transition has settled at the expected view.
 * @param page - the page under test.
 * @param listShown - whether the thread list should be on screen.
 * @returns the settled geometry.
 */
async function settledFrame(page: Page, listShown: boolean): Promise<FrameGeometry> {
  await expect.poll(async () => {
    const frame = await readFrame(page)
    return frame.listShown === listShown && (listShown
      ? frame.listLeft === 0 && frame.centerLeft >= frame.viewportWidth
      : frame.centerLeft === 0 && frame.listLeft < 0)
  }, { timeout: 10_000 }).toBe(true)
  return readFrame(page)
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
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    expect(tripwire.pageErrors).toEqual([])
  })

  it('shows the thread list and the conversation as full-screen views and returns through back actions', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-viewport'))
    await page.setViewportSize(PHONE)
    await expect.poll(async () => (await readFrame(page)).overlay, { timeout: 15_000 }).toBe(true)

    // Narrowing from desktop keeps the conversation on screen, alone.
    const thread = await settledFrame(page, false)
    expect(thread.centerWidth).toBe(PHONE.width)
    expect(thread.backPresent).toBe(true)
    expect(thread.depth).toBe(1)
    expect(thread.documentScrollWidth).toBe(thread.viewportWidth)

    // The frame's back control shows the list over the whole viewport and
    // rewinds the conversation's history entry.
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    const list = await settledFrame(page, true)
    expect(list.listWidth).toBe(PHONE.width)
    expect(list.centerLeft).toBeGreaterThanOrEqual(PHONE.width)
    expect(list.documentScrollWidth).toBe(list.viewportWidth)
    await expect.poll(async () => (await readFrame(page)).depth).toBe(0)

    // Opening a thread from the list pushes an entry; the browser's back
    // action (Android's back button, Safari's edge swipe) pops it.
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    expect((await settledFrame(page, false)).depth).toBe(1)
    await page.goBack()
    const popped = await settledFrame(page, true)

    const golden = [
      '# Frame geometry at the 390×844 phone viewport',
      '',
      '- Overlay layout active: ' + (thread.overlay ? 'true' : 'false'),
      '- Conversation spans the viewport: ' + (thread.centerWidth === PHONE.width ? 'true' : 'false'),
      '- Thread list spans the viewport: ' + (list.listWidth === PHONE.width ? 'true' : 'false'),
      '- Back control returns to the list: ' + (list.listShown ? 'true' : 'false'),
      '- Browser back returns to the list: ' + (popped.listShown ? 'true' : 'false'),
      '- No horizontal page scroll: ' + (thread.documentScrollWidth === thread.viewportWidth && list.documentScrollWidth === list.viewportWidth ? 'true' : 'false'),
    ].join('\n').trimEnd()
    await compareOrRefreshGolden(LAYOUT_EXPECTED, golden, MODE)
  }, 90_000)

  it('opens the right panel over the conversation and closes it on a browser back action', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-viewport-rightbar'))
    await page.setViewportSize(PHONE)
    await expect.poll(async () => (await readFrame(page)).overlay, { timeout: 15_000 }).toBe(true)
    if ((await readFrame(page)).listShown) await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    await settledFrame(page, false)
    const panel = page.locator('[data-rightbar-col] [data-sidebar-right-panel]')
    await page.locator('[data-sidebar-right-expand]').click()
    // A phone presents every opened panel fullscreen, covering the
    // conversation from the trackless column at the thread page's right edge.
    await expect.poll(() => panel.getAttribute('data-sidebar-right-panel'), { timeout: 10_000 }).toBe('fullscreen')
    await expect.poll(() => panel.boundingBox(), { timeout: 10_000 })
      .toEqual({ x: 0, y: 0, width: PHONE.width, height: PHONE.height })
    expect((await readFrame(page)).documentScrollWidth).toBe(PHONE.width)
    await expect.poll(async () => (await readFrame(page)).depth, { timeout: 10_000 }).toBe(2)
    await page.goBack()
    await expect.poll(() => page.locator('[data-rightbar-col] [data-sidebar-right-open]').count(), { timeout: 10_000 }).toBe(0)
    const thread = await settledFrame(page, false)
    expect(thread.centerWidth).toBe(PHONE.width)
    expect(thread.depth).toBe(1)
  }, 60_000)

  it('holds the single-column layout on a smaller phone', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-viewport-small'))
    await page.setViewportSize(SMALL_PHONE)
    await expect.poll(async () => {
      const frame = await readFrame(page)
      return [frame.centerWidth, frame.listWidth]
    }, { timeout: 15_000 }).toEqual([SMALL_PHONE.width, SMALL_PHONE.width])
    const geometry = await readFrame(page)
    expect(geometry.overlay).toBe(true)
    expect(geometry.listWidth).toBe(SMALL_PHONE.width)
    expect(geometry.documentScrollWidth).toBe(geometry.viewportWidth)
  }, 60_000)

  it('returns to the column layout when the window widens back to desktop', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-viewport-restore'))
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect.poll(async () => (await readFrame(page)).overlay, { timeout: 15_000 }).toBe(false)
    const geometry = await readFrame(page)
    // The sidebar is a real column again, so it takes width beside the center.
    expect(geometry.listWidth).toBeGreaterThan(0)
    expect(geometry.centerLeft).toBe(geometry.listWidth)
    expect(geometry.centerWidth).toBeLessThan(1280)
    expect(geometry.backPresent).toBe(false)
  }, 60_000)

  // Last: it reloads the page with the stand-in visual viewport installed.
  it('shrinks the frame above an on-screen keyboard instead of panning it off the top', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-viewport-keyboard'))
    await page.setViewportSize(PHONE)
    await page.addInitScript(installKeyboardStandIn)
    await page.reload({ waitUntil: 'load' })
    await expect.poll(async () => (await readFrame(page)).overlay, { timeout: 30_000 }).toBe(true)
    // Reloading the conversation's history entry keeps the conversation on screen.
    await settledFrame(page, false)
    const composer = page.locator('[data-composer-input][contenteditable="true"]')
    await composer.click()

    await page.evaluate((height) => {
      (window as { __dshKeyboard?: KeyboardStandIn }).__dshKeyboard!.show(height)
    }, KEYBOARD_HEIGHT)
    const visible = PHONE.height - KEYBOARD_HEIGHT
    await expect.poll(async () => (await readKeyboardGeometry(page)).rootHeight, { timeout: 10_000 }).toBe(visible)
    const open = await readKeyboardGeometry(page)
    expect(open.viewportMeta).toContain('interactive-widget=resizes-content')
    expect(open.frameBottom).toBe(visible)
    expect(open.composerBottom).toBeLessThanOrEqual(visible)
    expect(open.backTop).toBeGreaterThanOrEqual(0)
    expect(open.pan).toBe(0)

    await page.evaluate(() => { (window as { __dshKeyboard?: KeyboardStandIn }).__dshKeyboard!.show(0) })
    await expect.poll(async () => (await readKeyboardGeometry(page)).rootHeight, { timeout: 10_000 }).toBe(PHONE.height)

    const golden = [
      `# Frame geometry under a ${String(KEYBOARD_HEIGHT)}px on-screen keyboard at the 390×844 phone viewport`,
      '',
      '- Viewport meta asks for a content resize: ' + String(open.viewportMeta.includes('interactive-widget=resizes-content')),
      '- Frame ends at the keyboard: ' + String(open.frameBottom === visible),
      '- Composer above the keyboard: ' + String(open.composerBottom <= visible),
      '- Back control on screen: ' + String(open.backTop >= 0),
      '- Page pan scrolled back to the top: ' + String(open.pan === 0),
      '- Full height after the keyboard closes: true',
    ].join('\n')
    await compareOrRefreshGolden(KEYBOARD_EXPECTED, golden, MODE)
  }, 90_000)
})

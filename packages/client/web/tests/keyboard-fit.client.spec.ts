// @vitest-environment jsdom
/**
 * The on-screen keyboard fit, driven through a stand-in visual viewport and the
 * frame scheduling seam: each keyboard state and every frame is the test's
 * decision.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { installKeyboardFit, KEYBOARD_FIT_PROPERTY, type KeyboardFitOptions } from '../src/keyboard-fit.ts'

/** The layout viewport height the root element reports, in CSS pixels. */
const LAYOUT_HEIGHT = 664

/** A visual viewport whose geometry the test sets. */
class StubViewport extends EventTarget {
  height = LAYOUT_HEIGHT
  scale = 1
  offsetTop = 0
}

const win = document.defaultView!
let viewport: StubViewport
let container: HTMLDivElement
let frames: (() => void)[]
let scrollTo: MockInstance<Window['scrollTo']>
/** Every fit a test installed; the window and document listeners outlive a test unless disposed. */
const installed: (() => void)[] = []

/**
 * Install a fit that the suite disposes after the test.
 * @param options - the fit's options; the queued frame seam unless replaced.
 * @returns the fit's disposer.
 */
function install(options: KeyboardFitOptions = { container, scheduleFrame }): () => void {
  const stop = installKeyboardFit(options)
  installed.push(stop)
  return stop
}

/** The frame seam: queue each frame until the test runs it. */
function scheduleFrame(frame: () => void): () => void {
  frames.push(frame)
  return () => { frames = frames.filter(queued => queued !== frame) }
}

/** Run every queued frame. */
function runFrames(): void {
  for (const frame of frames.splice(0)) frame()
}

/** The height the fit currently publishes, or `''` while the mount point keeps its full height. */
function fitHeight(): string {
  return document.documentElement.style.getPropertyValue(KEYBOARD_FIT_PROPERTY)
}

/** Set the window's vertical scroll position. */
function scrollWindow(top: number): void {
  Object.defineProperty(win, 'scrollY', { configurable: true, writable: true, value: top })
}

/**
 * Report a visual viewport change the way a browser opening or closing a keyboard does.
 * @param height - the visible height.
 * @param offsetTop - how far the browser panned the visual viewport down.
 */
function keyboard(height: number, offsetTop = 0): void {
  viewport.height = height
  viewport.offsetTop = offsetTop
  viewport.dispatchEvent(new Event('resize'))
}

/** Focus a new text field appended to `parent`. */
function focusField(parent: HTMLElement): HTMLTextAreaElement {
  const field = document.createElement('textarea')
  parent.append(field)
  field.focus()
  return field
}

beforeEach(() => {
  viewport = new StubViewport()
  frames = []
  Object.defineProperty(win, 'visualViewport', { configurable: true, value: viewport })
  Object.defineProperty(document.documentElement, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ height: LAYOUT_HEIGHT }),
  })
  scrollTo = vi.spyOn(win, 'scrollTo').mockImplementation(() => {})
  scrollWindow(0)
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  for (const stop of installed.splice(0)) stop()
  Reflect.deleteProperty(win, 'visualViewport')
  Reflect.deleteProperty(document.documentElement, 'getBoundingClientRect')
  scrollWindow(0)
  document.documentElement.removeAttribute('style')
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('keyboard fit installation', () => {
  it('installs nothing where the window has no visual viewport', () => {
    Reflect.deleteProperty(win, 'visualViewport')
    const stop = install()
    expect(frames).toHaveLength(0)
    stop()
    expect(fitHeight()).toBe('')
  })

  it('installs nothing for a mount point outside a browsing context', () => {
    const detached = document.implementation.createHTMLDocument('detached')
    const mount = detached.createElement('div')
    detached.body.append(mount)
    const stop = install({ container: mount, scheduleFrame })
    expect(frames).toHaveLength(0)
    stop()
  })

  it('fits through the animation frame queue by default', () => {
    const queued: FrameRequestCallback[] = []
    const cancelled: number[] = []
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => queued.push(frame))
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => { cancelled.push(handle) })
    viewport.height = 300
    const stop = install({ container })
    expect(queued).toHaveLength(1)
    queued.splice(0, 1)[0]!(0)
    expect(fitHeight()).toBe('300px')

    keyboard(280)
    expect(queued).toHaveLength(1)
    stop()
    expect(cancelled).toEqual([1])
    expect(fitHeight()).toBe('')
  })
})

describe('fitting the mount point', () => {
  it('publishes the visible height while a keyboard hides part of the layout viewport', () => {
    install()
    runFrames()
    expect(fitHeight()).toBe('')

    keyboard(300.7)
    runFrames()
    // Rounded down, so the focused field stays wholly inside the visible area.
    expect(fitHeight()).toBe('300px')

    keyboard(LAYOUT_HEIGHT)
    runFrames()
    expect(fitHeight()).toBe('')
  })

  it('counts a cover as a keyboard from the threshold height up', () => {
    install()
    keyboard(LAYOUT_HEIGHT - 149, 149)
    runFrames()
    expect(fitHeight()).toBe('')
    expect(scrollTo).not.toHaveBeenCalled()

    keyboard(LAYOUT_HEIGHT - 150)
    runFrames()
    expect(fitHeight()).toBe(`${String(LAYOUT_HEIGHT - 150)}px`)
  })

  it('stands down while the page is zoomed', () => {
    install()
    keyboard(300)
    runFrames()
    expect(fitHeight()).toBe('300px')

    viewport.scale = 1.5
    keyboard(200, 120)
    runFrames()
    expect(fitHeight()).toBe('')
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('coalesces a burst of viewport changes into one frame and writes an unchanged height once', () => {
    const setProperty = vi.spyOn(document.documentElement.style, 'setProperty')
    install()
    runFrames()
    keyboard(300)
    viewport.dispatchEvent(new Event('scroll'))
    win.dispatchEvent(new Event('scroll'))
    expect(frames).toHaveLength(1)
    runFrames()
    viewport.dispatchEvent(new Event('scroll'))
    runFrames()
    expect(setProperty).toHaveBeenCalledOnce()
    expect(setProperty).toHaveBeenCalledWith(KEYBOARD_FIT_PROPERTY, '300px')
  })
})

describe('resetting the page pan', () => {
  it('scrolls the visual viewport pan back to the top while the mount point holds focus', () => {
    focusField(container)
    install()
    keyboard(300, LAYOUT_HEIGHT - 300)
    runFrames()
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it('scrolls a window scroll back to the top while nothing holds focus', () => {
    install()
    scrollWindow(120)
    keyboard(300)
    runFrames()
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it('leaves an unpanned or sub-pixel-panned page alone', () => {
    install()
    keyboard(300)
    runFrames()
    scrollWindow(0.4)
    keyboard(300, 0.3)
    runFrames()
    expect(fitHeight()).toBe('300px')
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('keeps the pan that reveals a field outside the mount point until focus returns inside', () => {
    focusField(document.body)
    install()
    keyboard(300, LAYOUT_HEIGHT - 300)
    runFrames()
    expect(fitHeight()).toBe('300px')
    expect(scrollTo).not.toHaveBeenCalled()

    focusField(container)
    expect(frames).toHaveLength(1)
    runFrames()
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
  })
})

describe('disposal', () => {
  it('stops watching, cancels a pending frame, and restores the full height', () => {
    const stop = install()
    keyboard(300)
    runFrames()
    keyboard(280)
    expect(frames).toHaveLength(1)
    stop()
    expect(frames).toHaveLength(0)
    expect(fitHeight()).toBe('')

    keyboard(260)
    win.dispatchEvent(new Event('scroll'))
    focusField(container)
    expect(frames).toHaveLength(0)
  })
})

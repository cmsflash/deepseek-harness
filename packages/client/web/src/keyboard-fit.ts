/**
 * On-screen keyboard fit. A browser that keeps the layout viewport at full
 * height while an on-screen keyboard is open (iOS Safari ignores the viewport
 * meta's `interactive-widget=resizes-content`) keeps the mount point's
 * `height: 100%` at the full layout viewport and pans the whole page up to
 * reveal the focused field, so the top of the frame leaves the screen. While a
 * keyboard-sized part of the layout viewport is hidden at zoom 1, this watcher
 * publishes the visible height as {@link KEYBOARD_FIT_PROPERTY} on the root
 * element, which `base.css` applies to the mount point, and scrolls the page pan
 * back to the top. Where the browser resizes the layout viewport itself, both
 * heights agree and nothing is written.
 * @module @deepseek-ai/dsh-client-web/src/keyboard-fit
 */

/** The root custom property `base.css` sizes the mount point by; set only while the fit applies. */
export const KEYBOARD_FIT_PROPERTY = '--dsh-keyboard-fit-height'

/**
 * Smallest hidden height, in CSS pixels, counted as an on-screen keyboard: above
 * what browser toolbars and an iPad's hardware-keyboard shortcut bar hide, below
 * every phone keyboard. A shorter cover keeps the browser's own pan.
 */
const KEYBOARD_MIN_HEIGHT = 150

/** Distance of the visual viewport's scale from 1 still treated as unzoomed. */
const ZOOM_TOLERANCE = 0.01

/**
 * Largest page pan, in CSS pixels, left in place. A pan can settle on a fraction
 * of a pixel that scrolling to the top cannot clear, and every reset raises
 * another scroll event.
 */
const PAN_TOLERANCE = 0.5

/** How the shell installs the keyboard fit. */
export interface KeyboardFitOptions {
  /** The mount point the fit resizes. The pan is reset only while focus is inside it or on no element. */
  readonly container: HTMLElement
  /**
   * Schedules one frame callback and returns its canceller. The callback runs
   * asynchronously, as `requestAnimationFrame` does.
   */
  readonly scheduleFrame?: (frame: () => void) => () => void
}

/**
 * Watch the visual viewport and fit the mount point to the part of it an
 * on-screen keyboard leaves visible. Installs nothing where the window has no
 * visual viewport.
 * @param options - the mount point and the frame scheduling seam.
 * @returns a disposer that stops watching, drops any pending frame, and restores the full height.
 */
export function installKeyboardFit(options: KeyboardFitOptions): () => void {
  const { container } = options
  const doc = container.ownerDocument
  const win = doc.defaultView
  const viewport = win?.visualViewport
  if (win == null || viewport == null) return () => {}
  const root = doc.documentElement
  const scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame
  /** The published height, or undefined while the mount point keeps its full height. */
  let published: string | undefined
  let cancelPending: (() => void) | undefined

  const unpublish = (): void => {
    if (published === undefined) return
    root.style.removeProperty(KEYBOARD_FIT_PROPERTY)
    published = undefined
  }

  const fit = (): void => {
    cancelPending = undefined
    // The root element keeps `height: 100%`, so its box is the height the mount point fills without the fit.
    const hidden = root.getBoundingClientRect().height - viewport.height
    if (Math.abs(viewport.scale - 1) > ZOOM_TOLERANCE || hidden < KEYBOARD_MIN_HEIGHT) {
      unpublish()
      return
    }
    // Rounding down keeps the focused field wholly visible, so the browser does not pan to reveal it again.
    const height = `${Math.floor(viewport.height)}px`
    if (height !== published) {
      root.style.setProperty(KEYBOARD_FIT_PROPERTY, height)
      published = height
    }
    const focused = doc.activeElement
    // A field outside the mount point, such as a portalled dialog's, keeps the pan the browser made to reveal it.
    if (focused !== doc.body && !container.contains(focused)) return
    if (win.scrollY > PAN_TOLERANCE || viewport.offsetTop > PAN_TOLERANCE) win.scrollTo(win.scrollX, 0)
  }

  const schedule = (): void => {
    cancelPending ??= scheduleFrame(fit)
  }

  viewport.addEventListener('resize', schedule)
  viewport.addEventListener('scroll', schedule)
  win.addEventListener('scroll', schedule, { passive: true })
  doc.addEventListener('focusin', schedule)
  schedule()

  return () => {
    viewport.removeEventListener('resize', schedule)
    viewport.removeEventListener('scroll', schedule)
    win.removeEventListener('scroll', schedule)
    doc.removeEventListener('focusin', schedule)
    cancelPending?.()
    cancelPending = undefined
    unpublish()
  }
}

/** Schedule one frame through the browser's animation frame queue. */
function defaultScheduleFrame(frame: () => void): () => void {
  const handle = requestAnimationFrame(frame)
  return () => { cancelAnimationFrame(handle) }
}

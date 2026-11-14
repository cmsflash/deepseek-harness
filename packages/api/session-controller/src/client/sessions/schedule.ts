/** Idle-clock scheduling shared by Session memory accounting. */

/**
 * Run one callback off the busy path, within a second on the browser's idle
 * clock; a macrotask stands in where the idle callback is unavailable.
 * @param fn - the callback to run.
 */
export function scheduleIdle(fn: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => { fn() }, { timeout: 1000 })
  } else {
    setTimeout(fn, 0)
  }
}

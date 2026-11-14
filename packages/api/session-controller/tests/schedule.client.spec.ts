/** Idle-clock scheduling of Session memory accounting. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleIdle } from '../src/client/sessions/schedule.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('scheduleIdle', () => {
  it('runs the callback on the browser idle clock within a second', () => {
    const idle = vi.fn<(callback: () => void, options: { readonly timeout: number }) => number>(() => 1)
    vi.stubGlobal('requestIdleCallback', idle)
    const fn = vi.fn()
    scheduleIdle(fn)
    expect(idle).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { timeout: 1000 })
    expect(fn).not.toHaveBeenCalled()
    idle.mock.calls[0]![0]()
    expect(fn).toHaveBeenCalledOnce()
  })

  it('runs the callback in a macrotask where the idle clock is unavailable', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestIdleCallback', undefined)
    const fn = vi.fn()
    scheduleIdle(fn)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(fn).toHaveBeenCalledOnce()
  })
})

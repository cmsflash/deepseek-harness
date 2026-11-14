/** Settings resolution, device classes, and the localStorage override surface (§2.2). */

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deviceClass, localCopyConfigOverride, resolveLocalCopySettings } from '../src/client/settings.ts'

/** One localStorage stub with the raw override text. */
function primeOverride(raw: string): void {
  window.localStorage.setItem('dsh.localCopy', raw)
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('local copy settings', () => {
  it('classifies a desktop from a phone by pointer and screen', () => {
    const wide = deviceClass({ matchMedia: () => ({ matches: false }), screen: { width: 1280, height: 800 } })
    expect(wide).toBe('desktop')
    const coarse = deviceClass({ matchMedia: () => ({ matches: true }), screen: { width: 1280, height: 800 } })
    expect(coarse).toBe('desktop')
    const phone = deviceClass({ matchMedia: () => ({ matches: true }), screen: { width: 390, height: 844 } })
    expect(phone).toBe('phone')
    const fineSmall = deviceClass({ matchMedia: () => ({ matches: false }), screen: { width: 390, height: 844 } })
    expect(fineSmall).toBe('desktop')
  })

  it('derives defaults per device class', () => {
    expect(resolveLocalCopySettings('desktop', {})).toMatchObject({ scope: 'all', diskBudgetBytes: 0, minPauseMs: 100 })
    expect(resolveLocalCopySettings('phone', {})).toMatchObject({ scope: 'opened', diskBudgetBytes: 1_073_741_824, minPauseMs: 300 })
  })

  it('validates each override field and ignores the unknown', () => {
    expect(localCopyConfigOverride({ scope: 'opened' })).toEqual({ scope: 'opened' })
    expect(localCopyConfigOverride({ scope: 'everywhere' })).toBeUndefined()
    expect(localCopyConfigOverride({ chunkBytes: -1 })).toBeUndefined()
    expect(localCopyConfigOverride({ minPauseMs: '100' })).toBeUndefined()
    expect(localCopyConfigOverride({ readerLoadGraceMs: 0 })).toEqual({ readerLoadGraceMs: 0 })
    expect(localCopyConfigOverride({ readerLoadGraceMs: -1 })).toBeUndefined()
    expect(resolveLocalCopySettings('phone', {})).toMatchObject({ readerLoadGraceMs: 30_000 })
    const ignored = localCopyConfigOverride({ extra: 1 })
    expect(ignored).toEqual({ extra: 1 })
    const scoped = resolveLocalCopySettings('desktop', { scope: 'opened', memoryBudgetBytes: 5, chunkBytes: 7, warmFollowGraceMs: 1 })
    expect(scoped).toMatchObject({ scope: 'opened', memoryBudgetBytes: 5, chunkBytes: 7, warmFollowGraceMs: 1 })
  })

  it('applies a valid localStorage override over any device default', () => {
    primeOverride('{"enabled":false}')
    const parsed: unknown = { enabled: false }
    const override = localCopyConfigOverride(parsed)
    expect(override).toEqual({ enabled: false })
    const overridden = resolveLocalCopySettings('desktop', override ?? {})
    expect(overridden.enabled).toBe(false)
  })

  it('rejects an invalid localStorage override before the defaults apply', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    primeOverride('{"scope":"galaxy"}')
    expect(localCopyConfigOverride({ scope: 'galaxy' })).toBeUndefined()
    expect(localCopyConfigOverride('nope')).toBeUndefined()
    expect(localCopyConfigOverride([1])).toBeUndefined()
    expect(localCopyConfigOverride(null)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })
})

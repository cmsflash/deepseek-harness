/** Compact token and duration formatting for the collapsed metric rows. */
import { describe, expect, it } from 'vitest'
import { formatDuration, formatTokens } from '../src/client/format.ts'

describe('formatTokens', () => {
  it('keeps counts under a thousand exact', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(517)).toBe('517')
    expect(formatTokens(999)).toBe('999')
  })

  it('scales thousands with one decimal until three digits', () => {
    expect(formatTokens(1_000)).toBe('1K')
    expect(formatTokens(12_240)).toBe('12.2K')
    expect(formatTokens(517_000)).toBe('517K')
  })

  it('scales millions', () => {
    expect(formatTokens(1_200_000)).toBe('1.2M')
    expect(formatTokens(120_000_000)).toBe('120M')
  })
})

describe('formatDuration', () => {
  it('reports sub-minute durations in tenths of a second', () => {
    expect(formatDuration(800)).toBe('0.8s')
    expect(formatDuration(45_200)).toBe('45.2s')
  })

  it('reports minutes with zero-padded seconds', () => {
    expect(formatDuration(65_000)).toBe('1m05s')
    expect(formatDuration(162_000)).toBe('2m42s')
  })

  it('reports hours with zero-padded minutes', () => {
    expect(formatDuration(3_600_000)).toBe('1h00m')
    expect(formatDuration(3_840_000)).toBe('1h04m')
  })
})

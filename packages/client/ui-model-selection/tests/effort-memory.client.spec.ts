// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { EffortMemory } from '../src/client/effort-memory.ts'
import type { ModelEffortSettings } from '../src/effort-settings.ts'
import type { ModelCatalogModel } from '../src/client/slots.ts'

const model: ModelCatalogModel = {
  id: 'deepseek-v4-pro',
  name: 'DeepSeek-V4-Pro',
  reasoning: {
    efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
    defaultEffort: 'high',
  },
}

/** A scope whose stored section the test drives directly. */
function scope(remembered: Record<string, string | null>, set = vi.fn().mockResolvedValue(undefined)) {
  const value: ModelEffortSettings = { rememberedEfforts: remembered }
  return {
    scope: {
      getSnapshot: () => ({
        status: 'ready', value, base: undefined, user: undefined,
        revision: 1, writable: true, mode: 'host',
      }),
      subscribe: () => () => {},
      set,
      unset: vi.fn(),
    } as unknown as SettingsScope<ModelEffortSettings>,
    set,
  }
}

describe('EffortMemory', () => {
  it('prefers a remembered level over the adapter default', () => {
    const memory = new EffortMemory(scope({ 'deepseek-official/deepseek-v4-pro': 'max' }).scope)
    expect(memory.effortFor('deepseek-official', model)).toBe('max')
  })

  it('keeps an explicitly chosen provider default distinct from no memory at all', () => {
    const remembered = new EffortMemory(scope({ 'deepseek-official/deepseek-v4-pro': null }).scope)
    expect(remembered.effortFor('deepseek-official', model)).toBeUndefined()
    const absent = new EffortMemory(scope({}).scope)
    expect(absent.effortFor('deepseek-official', model)).toBe('high')
  })

  it('keys by provider so the same model id under another route carries no memory', () => {
    const memory = new EffortMemory(scope({ 'deepseek-official/deepseek-v4-pro': 'max' }).scope)
    expect(memory.effortFor('other-gateway', model)).toBe('high')
  })

  it('falls back to the adapter default when the remembered level is no longer offered', () => {
    // The adapter renamed max→ultra between runs; the stored id is now stale.
    const memory = new EffortMemory(scope({ 'deepseek-official/deepseek-v4-pro': 'ultra' }).scope)
    expect(memory.effortFor('deepseek-official', model)).toBe('high')
  })

  it('carries no effort for a model the adapter exposes no reasoning for', () => {
    const memory = new EffortMemory(scope({ 'deepseek-official/plain': 'max' }).scope)
    expect(memory.effortFor('deepseek-official', { id: 'plain', name: 'Plain' })).toBeUndefined()
  })

  it('writes the selected level into the section under its route key', async () => {
    const { scope: bound, set } = scope({ 'deepseek-official/other': 'off' })
    await new EffortMemory(bound).remember('deepseek-official', 'deepseek-v4-pro', 'max')
    expect(set).toHaveBeenCalledWith('rememberedEfforts', {
      'deepseek-official/other': 'off',
      'deepseek-official/deepseek-v4-pro': 'max',
    })
  })

  it('stores an explicit provider-default choice as null', async () => {
    const { scope: bound, set } = scope({})
    await new EffortMemory(bound).remember('deepseek-official', 'deepseek-v4-pro', undefined)
    expect(set).toHaveBeenCalledWith('rememberedEfforts', { 'deepseek-official/deepseek-v4-pro': null })
  })

  it('drops the least recently written route past the cap', async () => {
    const stored: Record<string, string | null> = {}
    for (let index = 0; index < 200; index += 1) stored[`p/m${String(index)}`] = 'high'
    const { scope: bound, set } = scope(stored)
    await new EffortMemory(bound).remember('p', 'fresh', 'max')
    const written = set.mock.calls[0]?.[1] as Record<string, string | null>
    expect(Object.keys(written)).toHaveLength(200)
    expect(written['p/m0']).toBeUndefined()
    expect(written['p/fresh']).toBe('max')
  })

  it('keeps a re-selected route from being evicted as least recent', async () => {
    const stored: Record<string, string | null> = { 'p/oldest': 'off' }
    for (let index = 0; index < 199; index += 1) stored[`p/m${String(index)}`] = 'high'
    const { scope: bound, set } = scope(stored)
    await new EffortMemory(bound).remember('p', 'oldest', 'max')
    const written = set.mock.calls[0]?.[1] as Record<string, string | null>
    expect(written['p/oldest']).toBe('max')
    expect(Object.keys(written)).toHaveLength(200)
  })

  it('swallows a refused write so the accepted model switch still stands', async () => {
    const set = vi.fn().mockRejectedValue(new Error('settings-rejected'))
    const { scope: bound } = scope({}, set)
    await expect(new EffortMemory(bound).remember('p', 'm', 'max')).resolves.toBeUndefined()
  })

  it('reads an empty memory when no settings provider answered the namespace', () => {
    const bound = {
      getSnapshot: () => ({
        status: 'unavailable', value: undefined, base: undefined, user: undefined,
        revision: undefined, writable: false, mode: 'memory',
      }),
      subscribe: () => () => {},
      set: vi.fn(),
      unset: vi.fn(),
    } as unknown as SettingsScope<ModelEffortSettings>
    expect(new EffortMemory(bound).effortFor('deepseek-official', model)).toBe('high')
  })
})

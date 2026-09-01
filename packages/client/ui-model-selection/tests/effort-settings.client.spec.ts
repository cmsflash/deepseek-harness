import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  MODEL_EFFORT_SETTINGS_NAMESPACE, REMEMBERED_EFFORTS_FIELD, apply, effortKey,
} from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

describe('ui-model-selection Host settings', () => {
  it('registers, validates, and disposes the remembered-effort namespace', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const ns = MODEL_EFFORT_SETTINGS_NAMESPACE

    expect(ctx.settings.get(ns)).toEqual({ [REMEMBERED_EFFORTS_FIELD]: {} })
    const key = effortKey('deepseek-official', 'deepseek-v4-pro')
    await ctx.settings.update(ns, { [REMEMBERED_EFFORTS_FIELD]: { [key]: 'max', other: null } })
    expect(ctx.settings.get(ns)).toEqual({ [REMEMBERED_EFFORTS_FIELD]: { [key]: 'max', other: null } })
    await expect(ctx.settings.update(ns, { [REMEMBERED_EFFORTS_FIELD]: { [key]: 3 } })).rejects.toThrow()

    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(ns)
  })

  it('loads without a settings provider', async () => {
    const ctx = new Context()
    await expect(ctx.plugin({ apply }).await()).resolves.toBeDefined()
  })
})

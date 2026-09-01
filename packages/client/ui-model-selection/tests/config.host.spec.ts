import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as HostPlugin from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import { Config, REMEMBERED_EFFORTS_FIELD, apply, effortKey } from '../src/index.ts'

describe('ui-model-selection host', () => {
  it('validates and persists remembered efforts through the live configuration', async () => {
    const ctx = new Context()
    const configuration = await liveConfig(ctx, { Config, apply })
    expect(plainConfig(configuration.fiber.config)).toEqual({ [REMEMBERED_EFFORTS_FIELD]: {} })
    const key = effortKey('deepseek-official', 'deepseek-v4-pro')
    await configuration.update({ [REMEMBERED_EFFORTS_FIELD]: { [key]: 'max', other: null } })
    expect(plainConfig(configuration.fiber.config)).toEqual({ [REMEMBERED_EFFORTS_FIELD]: { [key]: 'max', other: null } })
    await expect(configuration.update({ [REMEMBERED_EFFORTS_FIELD]: { [key]: 3 } })).rejects.toThrow()
    await configuration.fiber.dispose()
  })
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))

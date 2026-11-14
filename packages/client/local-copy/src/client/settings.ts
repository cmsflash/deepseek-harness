/** Device classification and settings resolution for the local Session copy. */

import z from '@deepseek-ai/schemastery'

/** Which threads this device downloads. */
export type LocalCopyScope = 'all' | 'opened'

/** One device's resolved local-copy settings. */
export interface LocalCopySettings {
  readonly enabled: boolean
  readonly scope: LocalCopyScope
  readonly memoryBudgetBytes: number
  readonly diskBudgetBytes: number
  readonly chunkBytes: number
  readonly minPauseMs: number
  readonly warmFollowGraceMs: number
  readonly readerLoadGraceMs: number
}

/** Whether a coarse pointer on a small screen selects the phone policy. */
export type DeviceClass = 'desktop' | 'phone'

/** Browser inputs of {@link deviceClass}. */
export interface DeviceClassEnvironment {
  readonly matchMedia: (query: string) => { readonly matches: boolean }
  readonly screen: { readonly width: number; readonly height: number }
}

/**
 * Classify the device the page runs on.
 * @param env - matchMedia and screen of the window.
 * @returns `phone` when a coarse pointer meets a sub-600 px short side, else `desktop`.
 */
export function deviceClass(env: DeviceClassEnvironment): DeviceClass {
  return env.matchMedia('(pointer: coarse)').matches
    && Math.min(env.screen.width, env.screen.height) < 600
    ? 'phone'
    : 'desktop'
}

/** §2.12 defaults by device class. */
function defaultSettings(device: DeviceClass): LocalCopySettings {
  return {
    enabled: true,
    scope: device === 'phone' ? 'opened' : 'all',
    memoryBudgetBytes: device === 'phone' ? 26_214_400 : 104_857_600,
    diskBudgetBytes: device === 'phone' ? 1_073_741_824 : 0,
    chunkBytes: 1_048_576,
    minPauseMs: device === 'phone' ? 300 : 100,
    warmFollowGraceMs: 30_000,
    readerLoadGraceMs: 30_000,
  }
}

/** Tuning override for the local copy; every field optional. */
export interface LocalCopyConfig {
  readonly enabled?: boolean
  readonly scope?: LocalCopyScope
  readonly memoryBudgetBytes?: number
  readonly diskBudgetBytes?: number
  readonly chunkBytes?: number
  readonly minPauseMs?: number
  readonly warmFollowGraceMs?: number
  readonly readerLoadGraceMs?: number
}

/** Validated browser-local override of the local-copy settings (localStorage `dsh.localCopy`). */
export const Config: z<LocalCopyConfig> = z.object({
  enabled: z.boolean(),
  scope: z.union([z.const('all'), z.const('opened')]),
  memoryBudgetBytes: z.natural().min(1),
  diskBudgetBytes: z.natural(),
  chunkBytes: z.natural().min(64 * 1024).max(8_388_608),
  minPauseMs: z.natural().min(1),
  warmFollowGraceMs: z.natural().min(1),
  readerLoadGraceMs: z.natural(),
})

/**
 * Validate one raw override value.
 * @param value - value parsed from localStorage.
 * @returns the accepted override, or `undefined` when it is invalid.
 */
export function localCopyConfigOverride(value: unknown): LocalCopyConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  try {
    return Config(value)
  } catch {
    return undefined
  }
}

/**
 * Resolve one device's settings from the default table and an override.
 * @param device - the device the page runs on.
 * @param override - accepted override fields.
 * @returns the settings the plugin applies.
 */
export function resolveLocalCopySettings(device: DeviceClass, override: LocalCopyConfig): LocalCopySettings {
  return { ...defaultSettings(device), ...override }
}

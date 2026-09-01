/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-read-aloud`.
 * @module @deepseek-ai/dsh-client-read-aloud/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-read-aloud'

/** Cordis companion plugin name. */
export const name = 'client-ui-speech-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the plugin owns one slot registration and one
 * per-session player map, both released by the same effect disposer. The
 * lifecycle spec proves the registration is withdrawn and every player is
 * disposed when the owning fiber is disposed, so no second authority exists to
 * check at runtime.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-read-aloud`.
 * @module @deepseek-ai/dsh-read-aloud/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-read-aloud'

/** Cordis companion plugin name. */
export const name = 'read-aloud-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: cached audio is regenerable presentation that never
 * enters the Session log, so there is no logged relation to assert. Cache
 * contents are filesystem state whose only contract — a miss regenerates — is
 * exercised on every read.
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

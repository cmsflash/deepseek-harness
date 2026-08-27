/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-speech-openai-compatible`.
 * @module @deepseek-ai/dsh-speech-openai-compatible/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-speech-openai-compatible'

/** Cordis companion plugin name. */
export const name = 'speech-openai-compatible-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package registers one provider per configured route into `ctx.speech`
 * and holds no mutable data or event stream of its own; the seam owns
 * selection and enforcement.
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

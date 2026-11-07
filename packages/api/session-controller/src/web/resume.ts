/** Validation of a follow request's resume point and its comparison with an observed Session log. */

import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionFollowResume } from '../types.ts'

const CHAIN_LINK = /^[0-9a-f]{64}$/

function badResume(message: string): RemoteError<'gateway/bad-request'> {
  return new RemoteError('gateway/bad-request', message, {})
}

/**
 * Reject a malformed resume point.
 * @param resume - the request's resume point.
 */
export function validateFollowResume(resume: SessionFollowResume): void {
  const { afterSeq, link } = resume
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || Object.is(afterSeq, -0)) {
    throw badResume('resume.afterSeq must be a non-negative safe integer')
  }
  if (typeof link !== 'string' || !CHAIN_LINK.test(link)) {
    throw badResume('resume.link must be 64 lowercase hexadecimal characters')
  }
}

/**
 * Decide whether a held window continues an observed log. The link at
 * `afterSeq` covers the header and every stored line through that event, so a
 * log that lost or rewrote held events after a crash, or a new format
 * generation, has a different link there.
 * @param observation - the read the opening is served from.
 * @param resume - validated resume point.
 * @param limit - most events a resumed opening may carry.
 * @returns whether to answer with the events after `resume.afterSeq`.
 */
export function continuesLog(observation: SessionObservation, resume: SessionFollowResume, limit: number): boolean {
  const { cursor, chain } = observation
  if (chain === undefined || resume.afterSeq > cursor || cursor - resume.afterSeq > limit) return false
  const link: string | undefined = chain.linkAt(resume.afterSeq)
  return link === resume.link
}

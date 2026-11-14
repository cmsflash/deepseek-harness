/** One `/api/session/lines` fetch and its chain verification (§2.5 per chunk, §2.6 download row). */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { equalBytes, headerLinkOf, nextLink, parseLink } from './chain.ts'

/** One checkpoint of the copy's stored prefix, sent to the route (§2.3 `have`). */
export interface HaveCheckpoint {
  readonly seq: number
  readonly link: string
}

/** Why one chunk fetch did not produce verifiable lines. */
export type FetchLinesFailure =
  | { readonly kind: 'lines-unavailable' }
  | { readonly kind: 'line-unverifiable'; readonly seq: number }
  | { readonly kind: 'chain-mismatch'; readonly seq: number }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'network'; readonly message: string }

/** One verified chunk fetch: the validated head, its lines, and each line's link. */
export interface FetchedLines {
  readonly head: VerifiedHead
  readonly lines: readonly Uint8Array[]
  readonly links: readonly Uint8Array<ArrayBuffer>[]
  /** Worker-local busy time excluding the network wait, for the pause arithmetic. */
  readonly busyMs: number
}

/** The `SessionLinesHead` fields a verified response carries. */
export interface VerifiedHead {
  readonly start: number
  readonly through: number
  readonly cursor: number
  /** Parsed link bytes at `through`; `null` when nothing was sent from an empty log. */
  readonly link: Uint8Array<ArrayBuffer> | null
  readonly header: string | null
  readonly headerLink: Uint8Array<ArrayBuffer> | null
}

/** Inputs one chunk fetch needs from the copy. */
export interface FetchLinesRequest {
  readonly sessionId: SessionId
  readonly linesUrl: string
  readonly maxBytes: number
  readonly have: readonly HaveCheckpoint[]
  /** Link of the stored line below one continuation, when the copy holds one. */
  readonly storedLink: (seq: number) => Uint8Array<ArrayBuffer> | undefined
  readonly fetch: typeof fetch
  readonly signal?: AbortSignal
}

/**
 * Build the checkpoint list for one copy head: `head`, `head − 1`, `head − 2`, `head − 4`, …
 * down to 0, at most 32 entries (§2.5).
 * @param head - stored head seq, −1 when nothing is stored.
 * @param storedLink - link of one stored position, when the copy holds one.
 * @returns strictly descending checkpoints.
 */
export function buildHave(head: number, storedLink: (seq: number) => string | undefined): readonly HaveCheckpoint[] {
  if (head < 0) return []
  const checkpoints: HaveCheckpoint[] = []
  for (let offset = 0; head - offset >= 0 && checkpoints.length < 32; offset = offset === 0 ? 1 : offset * 2) {
    const seq = head - offset
    const link = storedLink(seq)
    if (link === undefined) break
    checkpoints.push({ seq, link })
  }
  return checkpoints
}

/**
 * Fetch one range of stored lines and verify every link (§2.5).
 * @param request - route address, checkpoints, byte budget and stored links.
 * @returns the verified lines, or one typed failure; a malformed head line rejects.
 */
export async function fetchLines(request: FetchLinesRequest): Promise<FetchedLines | { readonly failure: FetchLinesFailure }> {
  const url = new URL(request.linesUrl)
  url.searchParams.set('sessionId', request.sessionId)
  if (request.have.length > 0) {
    url.searchParams.set('have', request.have.map(checkpoint => `${String(checkpoint.seq)}:${checkpoint.link}`).join(','))
  }
  url.searchParams.set('maxBytes', String(request.maxBytes))
  const busyStart = performance.now()
  let response: Response
  try {
    response = await request.fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  } catch (error: unknown) {
    return { failure: { kind: 'network', message: error instanceof Error ? error.message : String(error) } }
  }
  if (response.status === 409) {
    const failure = await unavailableFailure(response)
    if (failure !== undefined) return failure
  }
  if (!response.ok) return { failure: { kind: 'http', status: response.status } }
  const bytes = new Uint8Array(await response.arrayBuffer())
  const pieces = splitLines(bytes)
  const head = verifiedHead(pieces[0], request.sessionId, pieces.length - 1)
  const lines = pieces.slice(1)
  let prior: Uint8Array<ArrayBuffer>
  if (head.start === 0) {
    /* v8 ignore next -- verifiedHead already rejects a from-scratch head without its header; this narrows the fields */
    if (head.header === null || head.headerLink === null) throw new Error('local copy: a from-scratch response carries no header')
    const computed = await headerLinkOf(new TextEncoder().encode(head.header))
    if (!equalBytes(computed, head.headerLink)) return { failure: { kind: 'chain-mismatch', seq: 0 } }
    prior = head.headerLink
  } else {
    const stored = request.storedLink(head.start - 1)
    if (stored === undefined) return { failure: { kind: 'chain-mismatch', seq: head.start } }
    prior = stored
  }
  const links: Uint8Array<ArrayBuffer>[] = []
  for (const line of lines) {
    prior = await nextLink(prior, line)
    links.push(prior)
  }
  // §2.5: the last computed link must equal the head line's link, also when nothing was sent.
  const lastComputed = links.at(-1) ?? prior
  if (head.link === null) {
    if (head.through >= head.start) return { failure: { kind: 'chain-mismatch', seq: head.through } }
  } else if (!equalBytes(lastComputed, head.link)) {
    return { failure: { kind: 'chain-mismatch', seq: head.through } }
  }
  return { head, lines, links, busyMs: performance.now() - busyStart }
}

/** Parse the head line for one 409 the route answers with, when it is one of the two known codes. */
async function unavailableFailure(response: Response): Promise<{ readonly failure: FetchLinesFailure } | undefined> {
  const body = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const code = (parsed as Record<string, unknown>)['code']
  if (code === 'session/lines-unavailable') return { failure: { kind: 'lines-unavailable' } }
  if (code === 'session/line-unverifiable') {
    const seq = (parsed as Record<string, unknown>)['seq']
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
      throw new Error('local copy: a line-unverifiable answer carries no seq')
    }
    return { failure: { kind: 'line-unverifiable', seq } }
  }
  return undefined
}

/** Split a newline-delimited byte body into its pieces; an empty trailing piece drops. */
function splitLines(bytes: Uint8Array): readonly Uint8Array[] {
  const pieces: Uint8Array[] = []
  let start = 0
  for (let index = 0; index < bytes.byteLength; index++) {
    if (bytes[index] !== 0x0a) continue
    pieces.push(bytes.subarray(start, index))
    start = index + 1
  }
  if (start < bytes.byteLength) pieces.push(bytes.subarray(start))
  return pieces
}

/** Strictly validate one response's first line (§4.4 step 6). */
function verifiedHead(piece: Uint8Array | undefined, sessionId: SessionId, lineCount: number): VerifiedHead {
  if (piece === undefined) throw new Error('local copy: the lines response carries no head line')
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(piece))
  } catch {
    throw new Error('local copy: the lines head line is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('local copy: the lines head line is not an object')
  }
  const head = parsed as Record<string, unknown>
  if (head['type'] !== 'dsh-session-lines' || head['version'] !== 1 || head['sessionId'] !== sessionId) {
    throw new Error('local copy: the lines head line does not name this response')
  }
  const start = head['start']
  const through = head['through']
  const cursor = head['cursor']
  if (typeof start !== 'number' || typeof through !== 'number' || typeof cursor !== 'number'
    || !Number.isSafeInteger(start) || !Number.isSafeInteger(through) || !Number.isSafeInteger(cursor)
    || start < 0 || cursor < -1 || through !== start + lineCount - 1) {
    throw new Error('local copy: the lines head line carries an invalid range')
  }
  const link = head['link']
  if (link !== null && typeof link !== 'string') throw new Error('local copy: the lines head link is neither null nor a string')
  let linkBytes: Uint8Array<ArrayBuffer> | null = null
  if (typeof link === 'string') {
    const parsed = parseLink(link)
    if (parsed === undefined) throw new Error('local copy: the lines head link is not 64 lowercase hex characters')
    linkBytes = parsed
  }
  const header = head['header']
  const headerLink = head['headerLink']
  if (start === 0) {
    if (typeof header !== 'string' || typeof headerLink !== 'string') {
      throw new Error('local copy: a from-scratch response carries no header')
    }
    const headerLinkBytes = parseLink(headerLink)
    if (headerLinkBytes === undefined) {
      throw new Error('local copy: a from-scratch response carries an invalid header link')
    }
    if (linkBytes === null) return { start, through, cursor, link: null, header, headerLink: headerLinkBytes }
    return { start, through, cursor, link: linkBytes, header, headerLink: headerLinkBytes }
  }
  if (header !== undefined || headerLink !== undefined) {
    throw new Error('local copy: a continuation response carries a header')
  }
  if (linkBytes === null) return { start, through, cursor, link: null, header: null, headerLink: null }
  return { start, through, cursor, link: linkBytes, header: null, headerLink: null }
}

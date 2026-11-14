/**
 * Authenticated GET /api/session/lines that serves one Session's stored log
 * lines as raw JSONL, oldest first. Checkpoints in `have` locate where the
 * caller's copy last agreed with the Host, so a download continues from the
 * first shared byte. The connection service authenticates requests before this
 * handler; a request activates no Agent and computes no projection.
 * @module @deepseek-ai/dsh-api-session-controller/lines-route
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLogChain } from '@deepseek-ai/dsh-session-persistence'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { SESSION_LINES_PATH, type SessionChainLink, type SessionLinesHead } from './types.ts'
import { chainLink } from './history.ts'

/** Largest number of `have` checkpoints one request may carry. */
const MAX_CHECKPOINTS = 32
/** Smallest and largest accepted `maxBytes`, and the budget applied when the request omits it. */
const MAX_BYTES_RANGE = { min: 4096, max: 8388608, default: 1048576 } as const
const CHAIN_LINK_TEXT = /^[0-9a-f]{64}$/
const DECIMAL_TEXT = /^\d+$/
const NEWLINE = Buffer.from('\n', 'utf8')
const HEADER_DECODER = new TextDecoder()

/**
 * The persistence module's chain tag, read per request: the persistence package
 * is an optional peer a Host may compose away, so module scope imports it only
 * as a type and the serving path loads the constant from the installed copy.
 * @returns the chain tag literal the persistence backend hashes header lines with.
 */
async function sessionLogChainTag(): Promise<string> {
  return (await import('@deepseek-ai/dsh-session-persistence')).SESSION_LOG_CHAIN_TAG
}

const TEXT_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
} as const
const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
} as const

/** One parsed `have` checkpoint: the caller's copy holds this seq with this chain link. */
interface SessionLinesCheckpoint {
  readonly seq: number
  readonly link: string
}

/** Validated query parameters of one lines request. */
interface SessionLinesParams {
  readonly sessionId: SessionId
  /** Checkpoints, highest seq first, or undefined when the request omits `have`. */
  readonly checkpoints: readonly SessionLinesCheckpoint[] | undefined
  readonly maxBytes: number
}

/** Point-read services the handler observes Sessions from, without activation. */
type SessionLinesContext = Pick<Context, 'sessionQuery'>

function failText(status: number, message: string): Response {
  return new Response(message, { status, headers: TEXT_HEADERS })
}

function failJson(status: 409, body: { readonly code: string; readonly seq?: number }): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/**
 * Parse one `seq:link` checkpoint.
 * @param text - one comma-separated element of the `have` parameter.
 * @returns the checkpoint, or undefined when the element is malformed.
 */
function parseCheckpoint(text: string): SessionLinesCheckpoint | undefined {
  const sep = text.indexOf(':')
  if (sep <= 0 || sep === text.length - 1) return undefined
  const seqText = text.slice(0, sep)
  if (!DECIMAL_TEXT.test(seqText)) return undefined
  const seq = Number(seqText)
  if (!Number.isSafeInteger(seq)) return undefined
  const link = text.slice(sep + 1)
  return CHAIN_LINK_TEXT.test(link) ? { seq, link } : undefined
}

/**
 * Read and validate the request's query parameters.
 * @param params - query parameters of the request URL.
 * @returns the parsed parameters, or the error response naming the rejected parameter.
 */
function parseSessionLinesParams(params: URLSearchParams): SessionLinesParams | Response {
  const sessionId = params.get('sessionId')
  if (sessionId === null || sessionId.length === 0) return failText(400, 'invalid sessionId')
  const maxBytesText = params.get('maxBytes')
  if (maxBytesText !== null) {
    const maxBytes = Number(maxBytesText)
    if (!DECIMAL_TEXT.test(maxBytesText)
      || maxBytes < MAX_BYTES_RANGE.min || maxBytes > MAX_BYTES_RANGE.max) {
      return failText(400, 'invalid maxBytes')
    }
  }
  const haveText = params.get('have')
  let checkpoints: readonly SessionLinesCheckpoint[] | undefined
  if (haveText !== null) {
    const parsed: SessionLinesCheckpoint[] = []
    for (const [index, text] of haveText.split(',').entries()) {
      const checkpoint = parseCheckpoint(text)
      const previous = parsed[index - 1]
      if (checkpoint === undefined || (previous !== undefined && checkpoint.seq >= previous.seq)) {
        return failText(400, 'invalid have')
      }
      parsed.push(checkpoint)
    }
    if (parsed.length > MAX_CHECKPOINTS) return failText(400, 'invalid have')
    checkpoints = parsed
  }
  return {
    sessionId: brandString<SessionId>(sessionId),
    checkpoints,
    maxBytes: maxBytesText === null ? MAX_BYTES_RANGE.default : Number(maxBytesText),
  }
}

/** A chain whose header line and stored-line read the handler verified for serving. */
type ServedSessionLogChain = SessionLogChain & {
  readonly headerLine: Uint8Array
  readonly storedLine: NonNullable<SessionLogChain['storedLine']>
}

/**
 * Build the response body head from the served range.
 * @param sessionId - Session whose lines were read.
 * @param start - seq of the first line sent.
 * @param through - seq of the last line sent, `start - 1` when none.
 * @param cursor - the observation's last seq.
 * @param chain - the observed log's chain with its header line verified.
 * @param headerLink - the tagged digest of the chain's header line.
 * @returns the serialized head line's bytes.
 */
function headBytes(
  sessionId: SessionId,
  start: number,
  through: number,
  cursor: number,
  chain: ServedSessionLogChain,
  headerLink: SessionChainLink,
): Uint8Array {
  const link = through < 0 ? undefined : chainLink(chain, through)
  const head: SessionLinesHead = {
    type: 'dsh-session-lines',
    version: 1,
    sessionId,
    start,
    through,
    cursor,
    link: link === undefined ? null : link,
    ...start === 0
      ? {
        header: HEADER_DECODER.decode(chain.headerLine),
        headerLink,
      }
      : {},
  }
  return Buffer.from(JSON.stringify(head), 'utf8')
}

/** The lines one request serves, or the seq whose stored line cannot be checked. */
type DueLines =
  | { readonly kind: 'served'; readonly lines: readonly Uint8Array[]; readonly through: number }
  | { readonly kind: 'unverifiable'; readonly seq: number }

/**
 * Collect the stored lines one request serves, stopping at the byte budget or at
 * the first event whose stored line cannot be checked.
 * @param events - the observation's contiguous events.
 * @param start - seq of the first line due.
 * @param cursor - the observation's last seq.
 * @param chain - the observed log's chain with its members verified.
 * @param maxBytes - response byte budget over the stored lines including newlines.
 * @returns the due lines with their last seq, or the unverifiable seq.
 */
function dueLines(
  events: readonly SessionEvent[],
  start: number,
  cursor: number,
  chain: ServedSessionLogChain,
  maxBytes: number,
): DueLines {
  const lines: Uint8Array[] = []
  let bytes = 0
  let through = start - 1
  for (let seq = start; seq <= cursor; seq += 1) {
    const stored = chain.storedLine(events[seq] as SessionEvent)
    if (stored === undefined) {
      if (seq === start) return { kind: 'unverifiable', seq }
      break
    }
    if (lines.length > 0 && bytes + stored.byteLength + 1 > maxBytes) break
    lines.push(stored)
    bytes += stored.byteLength + 1
    through = seq
  }
  return { kind: 'served', lines, through }
}

/**
 * Compose the head line and the stored lines into one response body.
 * @param sessionId - Session whose lines were read.
 * @param start - seq of the first line due.
 * @param served - the collected stored lines and their last seq.
 * @param cursor - the observation's last seq.
 * @param chain - the observed log's chain, for the head link and header digest.
 * @returns the complete response body bytes.
 */
async function responseBody(
  sessionId: SessionId,
  start: number,
  served: { readonly lines: readonly Uint8Array[]; readonly through: number },
  cursor: number,
  chain: ServedSessionLogChain,
): Promise<Uint8Array> {
  const tag = await sessionLogChainTag()
  const headerLink = brandString<SessionChainLink>(
    createHash('sha256').update(tag, 'utf8').update(chain.headerLine).digest('hex'),
  )
  const head = headBytes(sessionId, start, served.through, cursor, chain, headerLink)
  const segments: Uint8Array[] = [head, NEWLINE]
  for (const line of served.lines) segments.push(line, NEWLINE)
  return Buffer.concat(segments)
}

/**
 * Serve one Session's stored log lines to a local-copy client.
 * @param queries - point-read services for observations.
 * @param request - authenticated Fetch request; `request.signal` cancels the read.
 * @returns the head line and stored lines, or the error response.
 * @throws when the Session read fails outside its not-found taxonomy.
 */
export async function serveSessionLines(queries: SessionLinesContext, request: Request): Promise<Response> {
  const parsed = parseSessionLinesParams(new URL(request.url).searchParams)
  if (parsed instanceof Response) return parsed
  let observation: SessionObservation
  try {
    observation = await queries.sessionQuery.observeSession(parsed.sessionId, {
      signal: request.signal, projectionMode: 'none',
    })
  } catch (error: unknown) {
    const code = (error as { readonly code?: unknown } | null | undefined)?.code
    if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') return failText(404, 'not found')
    throw error
  }
  try {
    if (observation.header.origin === 'subagent') return failText(400, 'subagent sessions are not copied')
    if (observation.header.cwd === undefined) return failText(404, 'not found')
    const chain = observation.chain
    if (chain === undefined || chain.headerLine === undefined || chain.storedLine === undefined) {
      return failJson(409, { code: 'session/lines-unavailable' })
    }
    const served = chain as ServedSessionLogChain
    let start = 0
    for (const checkpoint of parsed.checkpoints ?? []) {
      if (served.linkAt(checkpoint.seq) === checkpoint.link) {
        start = checkpoint.seq + 1
        break
      }
    }
    const due = dueLines(observation.events, start, observation.cursor, served, parsed.maxBytes)
    if (due.kind === 'unverifiable') {
      return failJson(409, { code: 'session/line-unverifiable', seq: due.seq })
    }
    return new Response(
      (await responseBody(parsed.sessionId, start, due, observation.cursor, served)).slice(),
      { status: 200, headers: TEXT_HEADERS },
    )
  } finally {
    observation[Symbol.dispose]()
  }
}

/**
 * Stored-lines route contribution. The connection service supplies authentication;
 * `sessionQuery` supplies the non-activating Session observation.
 */
export const SessionLinesRoute = {
  inject: ['connection', 'sessionQuery'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.connection.fetch.register({
      path: SESSION_LINES_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => serveSessionLines(ctx, request),
    }), 'session-controller: /api/session/lines')
  },
}

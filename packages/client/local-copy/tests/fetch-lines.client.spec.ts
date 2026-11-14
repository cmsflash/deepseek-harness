/** `fetchLines` against a fake `/api/session/lines` route that follows §2.3 byte for byte. */

import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { buildHave, fetchLines, type FetchLinesRequest } from '../src/client/worker/fetch-lines.ts'
import { toHex } from '../src/client/worker/chain.ts'

const encoder = new TextEncoder()
const sessionId = brandString<SessionId>('session-fl')
const linesUrl = 'http://harness.test/api/session/lines'

/** One log fixture: header, lines and their true links under node:crypto. */
interface Log {
  readonly header: string
  readonly events: readonly string[]
  readonly headerLink: string
  readonly links: readonly string[]
}

/** Sha-256 over concatenated runs, computed independently of the code under test. */
function oracle(...runs: readonly Uint8Array[]): string {
  const hash = createHash('sha256')
  for (const run of runs) hash.update(run)
  return hash.digest('hex')
}

async function log(events: readonly string[], header = '{"version":4,"id":"fl"}'): Promise<Log> {
  const headerLink = oracle(Uint8Array.from('dsh-session-chain/1', character => character.codePointAt(0) ?? 0), encoder.encode(header))
  const links: string[] = []
  let previous = headerLink
  for (const text of events) {
    previous = oracle(hex(previous), encoder.encode(text))
    links.push(previous)
  }
  return { header, events, headerLink, links }
}

function hex(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32)
  for (let index = 0; index < 32; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/** One request the worker made, captured by the fake route. */
interface Served {
  readonly have: readonly { readonly seq: number; readonly link: string }[]
  readonly maxBytes: number
  readonly sessionId: string
}

/** Coerce one fetch input to a URL the way the builtin does. */
function toUrl(input: URL | RequestInfo): URL {
  if (input instanceof URL) return input
  if (input instanceof Request) return new URL(input.url)
  return new URL(`route-${input}`)
}

/** Serve one fetch as the §2.3 route would, remembering the request. */
function serve(from: Log, options: {
  readonly cursor?: number
  readonly status?: number
  readonly body?: string
  readonly headOverrides?: (head: Record<string, unknown>) => void
} = {}): { fetch: typeof fetch; served: () => Served } {
  const served: Served[] = []
  const routeFetch = vi.fn(async (input: URL | RequestInfo): Promise<Response> => {
    const url = toUrl(input)
    served.push({
      have: (url.searchParams.get('have') ?? '').split(',').filter((entry: string) => entry.length > 0)
        .map((entry: string) => {
          const [seq, link] = entry.split(':', 2)
          return { seq: Number(seq), link: link ?? '' }
        }),
      maxBytes: Number(url.searchParams.get('maxBytes')),
      sessionId: url.searchParams.get('sessionId') ?? '',
    })
    if (options.status !== undefined) {
      return new Response(options.body ?? '', { status: options.status })
    }
    const cursor = options.cursor ?? from.events.length - 1
    let start = 0
    for (const checkpoint of served[0]?.have ?? []) {
      if (checkpoint.seq >= 0 && checkpoint.seq < from.events.length && from.links[checkpoint.seq] === checkpoint.link) {
        start = checkpoint.seq + 1
      }
    }
    const maxBytes = served[0]?.maxBytes ?? 1_048_576
    const body: string[] = []
    let bytes = 0
    let through = start - 1
    for (let seq = start; seq < from.events.length; seq++) {
      const line = from.events[seq]
      if (line === undefined) break
      // The route sends at least one line when one is due, however large.
      if (body.length > 0 && bytes + line.length + 1 > maxBytes) break
      body.push(line)
      bytes += line.length + 1
      through = seq
    }
    const head: Record<string, unknown> = {
      type: 'dsh-session-lines',
      version: 1,
      sessionId,
      start,
      through,
      cursor,
      link: through === -1 ? null : from.links[through],
      ...(start === 0 ? { header: from.header, headerLink: from.headerLink } : {}),
    }
    options.headOverrides?.(head)
    const payload = `${JSON.stringify(head)}\n${body.join('\n')}${body.length > 0 ? '\n' : ''}`
    return new Response(payload, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
  })
  return { fetch: routeFetch, served: () => served[0] ?? { have: [], maxBytes: 0, sessionId: '' } }
}

/** One worker request bound to a fake route and the checkpoints the copy holds. */
function request(fetchRoute: typeof fetch, have: readonly { readonly seq: number; readonly link: string }[] = []): FetchLinesRequest {
  const stored = new Map<number, Uint8Array<ArrayBuffer>>()
  for (const checkpoint of have) {
    stored.set(checkpoint.seq, hex(checkpoint.link))
  }
  return {
    sessionId,
    linesUrl,
    maxBytes: 1_048_576,
    have,
    storedLink: seq => stored.get(seq),
    fetch: fetchRoute,
  }
}

describe('local copy fetch-lines', () => {
  it('downloads from scratch with a header and verifies every link', async () => {
    const from = await log(['{"seq":0}', '{"seq":1}', '{"seq":2}'])
    const { fetch: routeFetch } = serve(from)
    const outcome = await fetchLines(request(routeFetch))
    if ('failure' in outcome) throw new Error(`unexpected failure: ${JSON.stringify(outcome.failure)}`)
    expect(outcome.head).toMatchObject({ start: 0, through: 2, cursor: 2, header: from.header, headerLink: hex(from.headerLink) })
    expect(outcome.lines.map(line => new TextDecoder().decode(line))).toEqual(from.events)
    expect(outcome.links.map(link => toHex(link))).toEqual(from.links)
  })

  it('continues from a matching newest checkpoint', async () => {
    const from = await log(['{"seq":0}', '{"seq":1}', '{"seq":2}', '{"seq":3}'])
    const { fetch: routeFetch } = serve(from)
    const outcome = await fetchLines(request(routeFetch, [{ seq: 1, link: from.links[1] ?? '' }]))
    if ('failure' in outcome) throw new Error(`unexpected failure: ${JSON.stringify(outcome.failure)}`)
    expect(outcome.head.start).toBe(2)
    expect(outcome.lines.map(line => new TextDecoder().decode(line))).toEqual(['{"seq":2}', '{"seq":3}'])
  })

  it('falls back to an older matching checkpoint when the newest diverged', async () => {
    const from = await log(['{"seq":0}', '{"seq":1}', '{"seq":2}', '{"seq":3}'])
    const { fetch: routeFetch } = serve(from)
    const outcome = await fetchLines(request(routeFetch, [
      { seq: 3, link: 'f'.repeat(64) },
      { seq: 1, link: from.links[1] ?? '' },
    ]))
    if ('failure' in outcome) throw new Error(`unexpected failure: ${JSON.stringify(outcome.failure)}`)
    expect(outcome.head.start).toBe(2)
  })

  it('sends the session id and byte budget and no have before the first stored line', async () => {
    const from = await log(['{"seq":0}'])
    const { fetch: routeFetch, served } = serve(from)
    await fetchLines(request(routeFetch))
    expect(served().sessionId).toBe(sessionId)
    expect(served().maxBytes).toBe(1_048_576)
    expect(served().have).toEqual([])
  })

  it('reports a chain mismatch when the served tail does not match the head link', async () => {
    const from = await log(['{"seq":0}', '{"seq":1}'])
    const broken: Log = {
      header: from.header,
      events: from.events,
      headerLink: from.headerLink,
      links: [from.links[0] ?? '', createHash('sha256').update('nope').digest('hex')],
    }
    const { fetch: routeFetch } = serve(broken)
    const outcome = await fetchLines(request(routeFetch))
    expect(outcome).toEqual({ failure: { kind: 'chain-mismatch', seq: 1 } })
  })

  it('answers an up-to-date request with no lines and the stored head link', async () => {
    const from = await log(['{"seq":0}'])
    const { fetch: routeFetch } = serve(from)
    const outcome = await fetchLines(request(routeFetch, [{ seq: 0, link: from.links[0] ?? '' }]))
    if ('failure' in outcome) throw new Error(`unexpected failure: ${JSON.stringify(outcome.failure)}`)
    expect(outcome.head).toMatchObject({ start: 1, through: 0, cursor: 0, link: hex(from.links[0] ?? '') })
    expect(outcome.lines).toEqual([])
  })

  it('maps the two 409 answers and other statuses to their typed failures', async () => {
    const from = await log(['{"seq":0}'])
    const unavailable = serve(from, { status: 409, body: '{"code":"session/lines-unavailable"}' })
    const gone = await fetchLines(request(unavailable.fetch))
    expect(gone).toEqual({ failure: { kind: 'lines-unavailable' } })
    const line409 = serve(from, { status: 409, body: '{"code":"session/line-unverifiable","seq":7}' })
    expect(await fetchLines(request(line409.fetch))).toEqual({ failure: { kind: 'line-unverifiable', seq: 7 } })
    expect(await fetchLines(request(line409.fetch))).toEqual({ failure: { kind: 'line-unverifiable', seq: 7 } })
    const teapot = serve(from, { status: 418 })
    expect(await fetchLines(request(teapot.fetch))).toEqual({ failure: { kind: 'http', status: 418 } })
  })

  it('reports a network error with its message', async () => {
    const offline = vi.fn(async (): Promise<Response> => { throw new TypeError('fetch failed') })
    expect(await fetchLines(request(offline))).toEqual({ failure: { kind: 'network', message: 'fetch failed' } })
  })

  it('rejects malformed head lines', async () => {
    const from = await log(['{"seq":0}'])
    const corrupt = (overrides: (head: Record<string, unknown>) => void): typeof fetch =>
      serve(from, { headOverrides: overrides }).fetch
    const malformed: readonly ((head: Record<string, unknown>) => void)[] = [
      (head) => { head['version'] = 2 },
      (head) => { head['sessionId'] = 'session-other' },
      (head) => { head['through'] = 5 },
      (head) => { head['cursor'] = 'many' },
      (head) => { head['start'] = 0; delete head['header'] },
      (head) => { head['start'] = 1; head['header'] = 'extra' },
      (head) => { head['link'] = 'zz' },
      (head) => { head['type'] = 'other' },
    ]
    for (const overrides of malformed) {
      await expect(fetchLines(request(corrupt(overrides)))).rejects.toThrow(/local copy/)
    }
  })

  it('serves one oversized line alone when the budget cannot fit it', async () => {
    const fat = `{"big":"${'x'.repeat(2_000)}"}`
    const from = await log([fat, '{"seq":1}'])
    const { fetch: routeFetch } = serve(from)
    const outcome = await fetchLines({ ...request(routeFetch), maxBytes: 512 })
    if ('failure' in outcome) throw new Error(`unexpected failure: ${JSON.stringify(outcome.failure)}`)
    expect(outcome.lines.map(line => line.byteLength)).toEqual([fat.length])
    expect(outcome.head.through).toBe(0)
  })

  it('stops building checkpoints at the first missing stored link', () => {
    expect(buildHave(2, seq => (seq === 2 ? undefined : 'a'.repeat(64)))).toEqual([])
    expect(buildHave(-1, () => 'a'.repeat(64))).toEqual([])
  })

  it('passes an abort signal through to the route request', async () => {
    const from = await log(['{"seq":0}'])
    const { fetch: routeFetch, served } = serve(from)
    const outcome = await fetchLines({ ...request(routeFetch), signal: new AbortController().signal })
    if ('failure' in outcome) throw new Error(`unexpected failure: ${JSON.stringify(outcome.failure)}`)
    void served()
    expect(outcome.lines).toHaveLength(1)
  })

  it('reports a thrown non-error from the network as its string form', async () => {
    const throwing: typeof fetch = async (): Promise<Response> => { throw 'network is gone' }
    expect(await fetchLines(request(throwing))).toEqual({ failure: { kind: 'network', message: 'network is gone' } })
  })

  it('maps an unknown 409 body to a plain http failure', async () => {
    const from = await log(['{"seq":0}'])
    for (const body of ['not json', '42', '{"code":"session/other"}']) {
      const unknown = serve(from, { status: 409, body })
      expect(await fetchLines(request(unknown.fetch))).toEqual({ failure: { kind: 'http', status: 409 } })
    }
  })

  it('rejects a line-unverifiable answer that carries no usable seq', async () => {
    const from = await log(['{"seq":0}'])
    for (const body of ['{"code":"session/line-unverifiable"}', '{"code":"session/line-unverifiable","seq":"soon"}']) {
      const refusal = serve(from, { status: 409, body })
      await expect(fetchLines(request(refusal.fetch))).rejects.toThrow('local copy: a line-unverifiable answer carries no seq')
    }
  })

  it('rejects a from-scratch answer whose header link does not hash out', async () => {
    const from = await log(['{"seq":0}'])
    const forged = serve(from, { headOverrides: (head) => { head['headerLink'] = 'f'.repeat(64) } })
    expect(await fetchLines(request(forged.fetch))).toEqual({ failure: { kind: 'chain-mismatch', seq: 0 } })
  })

  it('mentions the requested start when a continuation has no stored link below it', async () => {
    const from = await log(['{"seq":0}', '{"seq":1}', '{"seq":2}'])
    const head = {
      type: 'dsh-session-lines', version: 1, sessionId, start: 2, through: 2, cursor: 2, link: from.links[2],
    }
    const continuation: typeof fetch = async (): Promise<Response> =>
      new Response(`${JSON.stringify(head)}\n${from.events[2] ?? ''}\n`)
    const outcome = await fetchLines(request(continuation, [{ seq: 0, link: from.links[0] ?? '' }]))
    expect(outcome).toEqual({ failure: { kind: 'chain-mismatch', seq: 2 } })
  })

  it('accepts an empty served log from scratch and a null link without lines', async () => {
    const from = await log([])
    const { fetch: routeFetch } = serve(from, { cursor: 0 })
    const outcome = await fetchLines(request(routeFetch))
    if ('failure' in outcome) throw new Error(`unexpected failure: ${JSON.stringify(outcome.failure)}`)
    expect(outcome.head).toMatchObject({ start: 0, through: -1, cursor: 0, link: null })
    expect(outcome.lines).toEqual([])
  })

  it('rejects a null link on a head that claims lines', async () => {
    const from = await log(['{"seq":0}', '{"seq":1}'])
    const lying = serve(from, { headOverrides: (head) => { head['link'] = null } })
    expect(await fetchLines(request(lying.fetch))).toEqual({ failure: { kind: 'chain-mismatch', seq: 1 } })
  })

  it('parses a final line without its trailing newline', async () => {
    const from = await log(['{"seq":0}'])
    const head = {
      type: 'dsh-session-lines', version: 1, sessionId, start: 0, through: 0, cursor: 0,
      link: from.links[0], header: from.header, headerLink: from.headerLink,
    }
    const plain: typeof fetch = async (): Promise<Response> =>
      new Response(`${JSON.stringify(head)}\n${from.events[0] ?? ''}`)
    const outcome = await fetchLines(request(plain))
    if ('failure' in outcome) throw new Error(`unexpected failure: ${JSON.stringify(outcome.failure)}`)
    expect(outcome.lines.map(line => new TextDecoder().decode(line))).toEqual(from.events)
  })

  it('rejects responses whose head line is missing, not JSON, or not an object', async () => {
    const from = await log(['{"seq":0}'])
    const empty: typeof fetch = async (): Promise<Response> => new Response('')
    await expect(fetchLines(request(empty))).rejects.toThrow('local copy: the lines response carries no head line')
    const notJson: typeof fetch = async (): Promise<Response> => new Response('not json\n')
    await expect(fetchLines(request(notJson))).rejects.toThrow('local copy: the lines head line is not JSON')
    const notObject: typeof fetch = async (): Promise<Response> => new Response('42\n')
    await expect(fetchLines(request(notObject))).rejects.toThrow('local copy: the lines head line is not an object')
    void from
  })

  it('rejects a head link that is neither null nor a string, and a bad header link', async () => {
    const from = await log(['{"seq":0}'])
    const numeric = serve(from, { headOverrides: (head) => { head['link'] = 42 } })
    await expect(fetchLines(request(numeric.fetch))).rejects.toThrow('local copy: the lines head link is neither null nor a string')
    const badHeader = serve(from, { headOverrides: (head) => { head['headerLink'] = 'not hex' } })
    await expect(fetchLines(request(badHeader.fetch))).rejects.toThrow('local copy: a from-scratch response carries an invalid header link')
  })

  it('rejects a continuation that carries a header, and accepts one that is up to date with a null link', async () => {
    const from = await log(['{"seq":0}', '{"seq":1}'])
    const withHeader = {
      type: 'dsh-session-lines', version: 1, sessionId, start: 1, through: 1, cursor: 1,
      link: from.links[1], header: 'extra',
    }
    const carrying: typeof fetch = async (): Promise<Response> =>
      new Response(`${JSON.stringify(withHeader)}\n${from.events[1] ?? ''}\n`)
    await expect(fetchLines(request(carrying, [{ seq: 0, link: from.links[0] ?? '' }])))
      .rejects.toThrow('local copy: a continuation response carries a header')
    const upToDate = {
      type: 'dsh-session-lines', version: 1, sessionId, start: 2, through: 1, cursor: 1, link: null,
    }
    const settled: typeof fetch = async (): Promise<Response> => new Response(`${JSON.stringify(upToDate)}\n`)
    const outcome = await fetchLines(request(settled, [{ seq: 1, link: from.links[1] ?? '' }]))
    if ('failure' in outcome) throw new Error(`unexpected failure: ${JSON.stringify(outcome.failure)}`)
    expect(outcome.head).toMatchObject({ start: 2, through: 1, link: null })
    expect(outcome.lines).toEqual([])
  })
})

/** Store and chain arithmetic of the local copy against a node:crypto oracle. */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SESSION_LOG_CHAIN_TAG, headerLinkOf, linkOf, nextLink, parseLink, toHex } from '../src/client/worker/chain.ts'
import { buildChunkInputs, type StoredLine } from '../src/client/worker/store.ts'

/** Oracle digest over bytes with node:crypto, independent of the code under test. */
function oracle(...runs: readonly Uint8Array[]): Uint8Array {
  const hash = createHash('sha256')
  for (const run of runs) hash.update(run)
  return new Uint8Array(hash.digest())
}

const tag = Uint8Array.from('dsh-session-chain/1', character => character.codePointAt(0) ?? 0)

describe('local copy chain arithmetic', () => {
  it('derives header and next links exactly as the persistence oracle does', async () => {
    const header = new TextEncoder().encode('{"version":4}')
    expect([...await headerLinkOf(header)]).toEqual([...oracle(tag, header)])
    const first = new TextEncoder().encode('{"type":"turn/start","seq":0}')
    const second = new TextEncoder().encode('{"type":"turn/end","seq":1}')
    const link0 = await nextLink(await headerLinkOf(header), first)
    expect([...link0]).toEqual([...oracle(await headerLinkOf(header), first)])
    expect([...await nextLink(link0, second)]).toEqual([...oracle(link0, second)])
  })

  it('hex-codes and parses links back', async () => {
    const header = new TextEncoder().encode('h')
    const link = await headerLinkOf(header)
    expect(toHex(link)).toMatch(/^[0-9a-f]{64}$/u)
    expect(linkOf(link)).toBe(toHex(link))
    const parsed = parseLink(toHex(link))
    expect(parsed === undefined ? [] : [...parsed]).toEqual([...link])
    expect(parseLink('not-a-link')).toBeUndefined()
    expect(parseLink(toHex(link).slice(0, 63))).toBeUndefined()
    expect(parseLink(toHex(link).toUpperCase())).toBeUndefined()
  })

  it('matches the literal tag the persistence chain uses', () => {
    expect(SESSION_LOG_CHAIN_TAG).toBe('dsh-session-chain/1')
  })

  it('splits lines into chunks around the budget, one oversized line alone', () => {
    const line = (seq: number, size: number, link = new Uint8Array(32).fill(seq)): StoredLine => ({
      seq,
      bytes: new Uint8Array(size).fill(0x61),
      link,
    })
    const s = 'session-1' as Parameters<typeof buildChunkInputs>[0]
    const lines = [line(0, 6), line(1, 4), line(2, 8)]
    // One byte of separator joins the run, so a joined data length of 11 fits a budget of 11.
    const split = buildChunkInputs(s, lines, 11)
    expect(split).toHaveLength(2)
    const first = split[0]
    const second = split[1]
    if (first === undefined || second === undefined) throw new Error('unreachable')
    expect(first).toMatchObject({ sessionId: s, first: 0, last: 1 })
    expect(second).toMatchObject({ sessionId: s, first: 2, last: 2 })
    // The data joins lines with newlines; ends mark each line's exclusive end.
    expect([...first.data]).toEqual([...new Uint8Array(6).fill(0x61), 0x0a, ...new Uint8Array(4).fill(0x61)])
    expect([...first.ends]).toEqual([6, 11])
    expect(first.links.byteLength).toBe(64)
    const fat = buildChunkInputs(s, [line(0, 6), line(1, 100)], 10)
    expect(fat).toHaveLength(2)
    expect(fat[1]).toMatchObject({ first: 1, last: 1 })
    expect(fat[1]?.data.byteLength).toBe(100)
  })
})

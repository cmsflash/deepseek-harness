/** Session seq of a rendered transcript row for the reader-range report. */

import { describe, expect, it } from 'vitest'
import type { GroupKey, NodeKey } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatRowSeq } from '../src/client/chat/row-seq.ts'
import { chatRenderKey } from '../src/client/chat/render-entry.ts'

const seqs = new Map([['user-1', 4], ['reply-1', 7], ['user-2', 12]])
const nodes = { get: (key: string) => (seqs.has(key) ? { anchorSeq: seqs.get(key)! } : undefined) }
const turns = new Map([[1, ['user-1', 'reply-1']], [2, []]])
const locations = { getTurn: (turn: number): readonly string[] => turns.get(turn) ?? [] }

describe('chatRowSeq', () => {
  it('maps a node row to its node, whatever group part or Turn it carries', () => {
    expect(chatRowSeq(chatRenderKey({ kind: 'node', key: 'reply-1' as NodeKey }), null, nodes, locations)).toBe(7)
    expect(chatRowSeq('["node","user-2",{"part":1}]', 1, nodes, locations)).toBe(12)
  })

  it('maps a node row whose node left the store to no seq, without asking its Turn', () => {
    expect(chatRowSeq('["node","gone",null]', 1, nodes, locations)).toBeNull()
  })

  it('maps group, synthetic, and malformed rows through the first node of their Turn', () => {
    expect(chatRowSeq(chatRenderKey({ kind: 'group', key: 'turn-1' as GroupKey }), 1, nodes, locations)).toBe(4)
    expect(chatRowSeq('collapsed-steps:1', 1, nodes, locations)).toBe(4)
    expect(chatRowSeq('["not json', 1, nodes, locations)).toBe(4)
    expect(chatRowSeq('["node",3]', 1, nodes, locations)).toBe(4)
  })

  it('maps a row without a Turn, or whose Turn has no node, to no seq', () => {
    expect(chatRowSeq('collapsed-steps', null, nodes, locations)).toBeNull()
    expect(chatRowSeq('["group","turn-2"]', 2, nodes, locations)).toBeNull()
    expect(chatRowSeq('["group","turn-3"]', 3, { get: () => undefined }, { getTurn: () => ['missing'] })).toBeNull()
  })
})

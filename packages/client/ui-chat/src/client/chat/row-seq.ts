/** Session seq of one rendered transcript row, for the reader-range report. */

import type { ChatLocationNodeIndex } from '../contract/snapshot.ts'

/** The node reads a row lookup needs from the Chat node store. */
export interface ChatRowNodes {
  get(key: string): { readonly anchorSeq: number } | undefined
}

/**
 * Resolve a rendered row's anchor seq: a node row through its node key, and a
 * group, collapsed, or synthetic row through the first node of its owning Turn.
 * @param anchorKey - the row's anchor key: a `chatRenderKey` or a synthetic row key.
 * @param turn - the row's owning Turn, or `null` when it has none.
 * @param nodes - the Chat node store.
 * @param locations - the Chat Location index.
 * @returns the anchor seq, or `null` when the row resolves to no node.
 */
export function chatRowSeq(
  anchorKey: string,
  turn: number | null,
  nodes: ChatRowNodes,
  locations: Pick<ChatLocationNodeIndex, 'getTurn'>,
): number | null {
  const parts = parsedKey(anchorKey)
  if (Array.isArray(parts) && parts[0] === 'node' && typeof parts[1] === 'string') {
    return nodes.get(parts[1])?.anchorSeq ?? null
  }
  if (turn === null) return null
  const nodeKey = locations.getTurn(turn)[0]
  return nodeKey === undefined ? null : nodes.get(nodeKey)?.anchorSeq ?? null
}

/** A JSON row key's parts, or `undefined` for a key that is not JSON. */
function parsedKey(anchorKey: string): unknown {
  if (!anchorKey.startsWith('["')) return undefined
  try {
    return JSON.parse(anchorKey)
  } catch (_syntaxError) {
    // A synthetic row key that only starts like JSON; its Turn resolves it.
    return undefined
  }
}

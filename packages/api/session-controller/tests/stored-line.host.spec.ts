/** The shared stored-line decoder inverts the JSONL writer's exact encoding. */

import { MessageId, createMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { eventLine } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { describe, expect, it } from 'vitest'
import { decodeStoredLine } from '../src/history-shared/wire-event.ts'

function userMessage(id: string, text: string) {
  return freezeMessage({
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** The persistence contract's plain one-turn corpus log, with an assistant stream. */
function oneTurnLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: SessionSeq(1), time: 2, data: userMessage('one-turn-user', 'hi'), surfaceOp: 'append' },
    { type: 'step/start', seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: SessionSeq(3), time: 4, data: {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'model', ...{ provider: 'mock', model: 'mock' } },
      }),
      stream: [
        { type: 'chunk', time: 3, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'text-chunks', time0: 3, index: 0, dt: [], texts: ['hello'] },
        { type: 'chunk', time: 4, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } } },
        { type: 'chunk', time: 4, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    }, surfaceOp: 'append' },
    { type: 'step/end', seq: SessionSeq(4), time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(5), time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** The JSONL chunk-run corpus log, whose streamed assistant text packs batched chunk runs. */
function streamChunkRunLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: SessionSeq(2), time: 8, data: {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 't0t1t2t3t4' }],
        source: { kind: 'model', ...{ provider: 'mock', model: 'mock' } },
      }),
      stream: [
        { type: 'text-chunks', time0: 3, index: 0, dt: [1, 1, 1, 1], texts: ['t0', 't1', 't2', 't3', 't4'] },
        { type: 'chunk', time: 8, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    }, surfaceOp: 'append' },
    { type: 'step/end', seq: SessionSeq(3), time: 9, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(4), time: 10, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** One turn whose steered surface message cites a three-event source run, stored as one range pair. */
function sourceRunLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: SessionSeq(1), time: 2, data: userMessage('run-first', 'first'), surfaceOp: 'append' },
    { type: 'user/message', seq: SessionSeq(2), time: 3, data: userMessage('run-middle', 'middle'), surfaceOp: 'append' },
    { type: 'user/message', seq: SessionSeq(3), time: 4, data: userMessage('run-last', 'last'), surfaceOp: 'append' },
    { type: 'user/message', seq: SessionSeq(4), time: 5, data: userMessage('run-final', 'final'),
      surfaceOp: { op: 'replace', startSeq: SessionSeq(1), endSeq: SessionSeq(3) },
      sourceEventSeqs: [SessionSeq(1), SessionSeq(2), SessionSeq(3)] },
    { type: 'turn/end', seq: SessionSeq(5), time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('decodeStoredLine', () => {
  it.each([
    ['plain one-turn log', oneTurnLog()],
    ['batched stream chunk log', streamChunkRunLog()],
    ['three-seq source run log', sourceRunLog()],
  ])('decodes every stored line of the %s back to its event', (_name, log) => {
    for (const event of log) {
      expect(decodeStoredLine(eventLine(event), event.seq)).toEqual(event)
    }
  })

  it('unpacks a stored source run and keeps its key position', () => {
    const event = sourceRunLog()[4] as SessionEvent
    const line = eventLine(event)
    expect(line).toContain('"surfaceOp":{"op":"replace","startSeq":1,"endSeq":3}')
    expect(line).toContain('"sourceEventSeqs":[[1,3]]')
    const decoded = decodeStoredLine(line, event.seq)
    expect(decoded.sourceEventSeqs).toEqual([1, 2, 3])
    expect(Object.keys(decoded)).toEqual(Object.keys(JSON.parse(line) as Record<never, never>))
  })

  it('rejects a line that names another seq', () => {
    const log = oneTurnLog()
    const line = eventLine(log[1] as SessionEvent)
    expect(() => decodeStoredLine(line, 0)).toThrow('names seq 1 where 0 was sent')
  })

  it('rejects a line that is not a JSON object', () => {
    expect(() => decodeStoredLine('[]', 0)).toThrow('is not a JSON object')
    expect(() => decodeStoredLine('null', 0)).toThrow('is not a JSON object')
  })
})

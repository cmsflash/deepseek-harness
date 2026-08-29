import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { closingMessageOf, spokenText } from '@deepseek-ai/dsh-read-aloud'

type Block = { type: string; text?: string; id?: string; name?: string; arguments?: string }

/** One `assistant/message` event carrying the given blocks. */
function assistantMessage(turn: number, step: number, id: string, content: Block[]): SessionEvent {
  return {
    type: 'assistant/message',
    seq: turn * 100 + step,
    time: 0,
    data: {
      turn,
      step,
      message: { id: MessageId(id), role: 'assistant', content, source: { kind: 'model' } },
    },
  } as unknown as SessionEvent
}

const text = (value: string): Block => ({ type: 'text', text: value })
const reasoning = (value: string): Block => ({ type: 'reasoning', text: value })
const toolCall = (name: string): Block => ({ type: 'tool-call', id: 'c1', name, arguments: '{}' })

describe('spokenText', () => {
  it('keeps only text blocks, in order', () => {
    expect(spokenText([text('a'), reasoning('hidden'), text('b'), toolCall('read')])).toBe('ab')
  })

  it('is empty for a message with no text block', () => {
    expect(spokenText([reasoning('thinking'), toolCall('read')])).toBe('')
  })

  it('contributes nothing for a text block carrying no text', () => {
    expect(spokenText([{ type: 'text' }, text('kept')])).toBe('kept')
  })
})

describe('closingMessageOf', () => {
  it('reads the last assistant message of the addressed turn', () => {
    const events = [
      assistantMessage(1, 1, 'm1', [text('first step'), toolCall('read')]),
      assistantMessage(1, 2, 'm2', [text('the summary')]),
    ]
    expect(closingMessageOf(events, 1)).toEqual({ messageId: MessageId('m2'), text: 'the summary' })
  })

  it('ignores messages belonging to other turns', () => {
    const events = [
      assistantMessage(1, 1, 'm1', [text('turn one')]),
      assistantMessage(2, 1, 'm2', [text('turn two')]),
    ]
    expect(closingMessageOf(events, 1)?.text).toBe('turn one')
    expect(closingMessageOf(events, 2)?.text).toBe('turn two')
  })

  it('excludes reasoning traces and tool arguments from the spoken prose', () => {
    const events = [assistantMessage(1, 1, 'm1', [
      reasoning('let me think about this at length'),
      text('Done.'),
      toolCall('write'),
    ])]
    expect(closingMessageOf(events, 1)?.text).toBe('Done.')
  })

  it('declines a closing message that carries no prose', () => {
    const events = [assistantMessage(1, 1, 'm1', [reasoning('thinking'), toolCall('read')])]
    expect(closingMessageOf(events, 1)).toBeUndefined()
  })

  it('declines a closing message whose prose is only whitespace', () => {
    const events = [assistantMessage(1, 1, 'm1', [text('   \n  ')])]
    expect(closingMessageOf(events, 1)).toBeUndefined()
  })

  it('declines a turn that finalized no assistant message', () => {
    expect(closingMessageOf([], 1)).toBeUndefined()
    expect(closingMessageOf([assistantMessage(2, 1, 'm1', [text('other')])], 1)).toBeUndefined()
  })

  it('skips non-assistant events while scanning', () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } as unknown as SessionEvent,
      assistantMessage(1, 1, 'm1', [text('after noise')]),
      { type: 'turn/end', seq: 2, time: 0, data: { turn: 1, reason: { kind: 'completed' } } } as unknown as SessionEvent,
    ]
    expect(closingMessageOf(events, 1)?.text).toBe('after noise')
  })
})

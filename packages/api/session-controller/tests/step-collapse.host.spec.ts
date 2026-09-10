/**
 * Step-level history elision: which of a turn's steps a collapsed page keeps
 * whole, what the withheld ones report through their digests, and that
 * expansion returns exactly what the page withheld.
 *
 * The pairing that matters throughout: `collapseSteps` and
 * `elidedEventsOfTurn` decide retention over the same scope, so a client that
 * expands a turn receives precisely the rows its page did not carry — no
 * duplicate, no hole.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { collapseSteps, diffLineDelta, elidedEventsOfTurn } from '../src/step-collapse.ts'

let seq = 0

function event(type: string, data: unknown, time = 1000): SessionEvent {
  return { type, seq: seq++, time, data } as unknown as SessionEvent
}

/** One complete step: boundaries around an assistant message and a tool pair. */
function step(turn: number, index: number, options: {
  text?: string
  tool?: boolean
  tokens?: { input: number; output: number }
  startTime?: number
  endTime?: number
} = {}): SessionEvent[] {
  const events: SessionEvent[] = [
    event('step/start', { turn, step: index }, options.startTime ?? 1000),
  ]
  if (options.tool === true) {
    events.push(event('tool/call', { turn, step: index, callId: `c${String(turn)}-${String(index)}`, name: 'write', arguments: '{}' }))
    events.push(event('tool/result', {
      turn,
      step: index,
      message: { source: { kind: 'tool', callId: `c${String(turn)}-${String(index)}` }, content: [] },
    }))
  }
  events.push(event('assistant/message', {
    turn,
    step: index,
    message: { content: options.text === undefined ? [] : [{ type: 'text', text: options.text }] },
    ...options.tokens === undefined ? {} : { usage: { inputTokens: options.tokens.input, outputTokens: options.tokens.output } },
  }, options.endTime ?? 1000))
  events.push(event('step/end', { turn, step: index }))
  return events
}

/** Wrap steps in a turn, with the prompting user message that opens it. */
function turn(number: number, steps: SessionEvent[][]): SessionEvent[] {
  return [
    event('turn/start', { turn: number }),
    event('user/message', { message: { content: [{ type: 'text', text: 'ask' }] } }),
    ...steps.flat(),
    event('turn/end', { turn: number, reason: { kind: 'completed' } }),
  ]
}

function types(result: readonly SessionEvent[]): string[] {
  return result.map(item => item.type)
}

describe('collapseSteps', () => {
  it('keeps the turn\'s last step whole and reduces earlier ones to their boundaries', () => {
    seq = 0
    const log = turn(1, [step(1, 1, { tool: true }), step(1, 2, { tool: true }), step(1, 3, { text: 'done', tool: true })])
    const { events: served, digests } = collapseSteps(log, log)

    // Step 3 is the turn's last: its interior rides the page untouched.
    expect(types(served).filter(type => type === 'assistant/message')).toHaveLength(1)
    expect(types(served)).toContain('tool/result')
    // Steps 1 and 2 keep only their boundaries, so the seq range stays joined.
    expect(types(served).filter(type => type === 'step/start')).toHaveLength(3)
    expect(types(served).filter(type => type === 'step/end')).toHaveLength(3)
    expect(digests.map(digest => digest.step)).toEqual([1, 2])
    expect(digests.every(digest => digest.elided === 3)).toBe(true)
  })

  it('never elides an event that carries no step coordinate', () => {
    seq = 0
    const log = turn(1, [step(1, 1, { tool: true }), step(1, 2, { text: 'done' })])
    const { events: served } = collapseSteps(log, log)

    // The reader's own words and the turn boundaries always survive.
    expect(types(served)).toContain('user/message')
    expect(types(served)).toContain('turn/start')
    expect(types(served)).toContain('turn/end')
  })

  it('retains the step carrying the turn\'s closing text even when a later step exists', () => {
    seq = 0
    // Step 2 speaks; step 3 only runs a tool. The footer reads its closing
    // message from step 2, so eliding it would degrade a settled turn.
    const log = turn(1, [step(1, 1, { tool: true }), step(1, 2, { text: 'the answer' }), step(1, 3, { tool: true })])
    const { events: served, digests } = collapseSteps(log, log)

    expect(digests.map(digest => digest.step)).toEqual([1])
    const texts = served
      .filter(item => item.type === 'assistant/message')
      .map(item => (item.data as { message: { content: { text?: string }[] } }).message.content[0]?.text)
    expect(texts).toContain('the answer')
  })

  it('decides retention per turn, so each turn keeps its own last step', () => {
    seq = 0
    const log = [
      ...turn(1, [step(1, 1, { tool: true }), step(1, 2, { text: 'a' })]),
      ...turn(2, [step(2, 1, { tool: true }), step(2, 2, { text: 'b' })]),
    ]
    const { digests } = collapseSteps(log, log)

    expect(digests.map(digest => `${String(digest.turn)}:${String(digest.step)}`)).toEqual(['1:1', '2:1'])
  })

  it('reports each withheld step\'s own cost: calls, tokens, and wall time', () => {
    seq = 0
    const log = turn(1, [
      step(1, 1, { tool: true, tokens: { input: 100, output: 20 }, startTime: 5000, endTime: 5750 }),
      step(1, 2, { text: 'done' }),
    ])
    const { digests } = collapseSteps(log, log)

    expect(digests).toHaveLength(1)
    const [digest] = digests
    expect(digest?.calls).toBe(1)
    expect(digest?.steps).toBe(1)
    expect(digest?.inputTokens).toBe(100)
    expect(digest?.outputTokens).toBe(20)
    expect(digest?.elapsedMs).toBe(750)
  })

  it('sums the three disjoint prompt-side token buckets', () => {
    seq = 0
    const log = turn(1, [
      [
        event('step/start', { turn: 1, step: 1 }),
        event('assistant/message', {
          turn: 1,
          step: 1,
          message: { content: [] },
          usage: { inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2, outputTokens: 7 },
        }),
        event('step/end', { turn: 1, step: 1 }),
      ],
      step(1, 2, { text: 'done' }),
    ])
    const { digests } = collapseSteps(log, log)

    expect(digests[0]?.inputTokens).toBe(17)
    expect(digests[0]?.outputTokens).toBe(7)
  })

  it('counts diff line volume from the applied diffs the tool result persisted', () => {
    seq = 0
    const log = turn(1, [
      [
        event('step/start', { turn: 1, step: 1 }),
        event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{}' }),
        event('tool/result', {
          turn: 1,
          step: 1,
          message: { source: { kind: 'tool', callId: 'c1' }, content: [] },
          meta: { diffs: [{ path: 'a.ts', oldText: 'x\n', newText: 'x\ny\n' }, { path: 7 }] },
        }),
        event('step/end', { turn: 1, step: 1 }),
      ],
      step(1, 2, { text: 'done' }),
    ])
    const { digests } = collapseSteps(log, log)

    // The malformed second entry contributes nothing; the call still counts.
    expect(digests[0]?.calls).toBe(1)
    expect(digests[0]?.added).toBe(1)
    expect(digests[0]?.removed).toBe(0)
    expect(digests[0]?.files).toBe(1)
  })

  it('serves the whole page unchanged when a turn has only one step', () => {
    seq = 0
    const log = turn(1, [step(1, 1, { text: 'done', tool: true })])
    const { events: served, digests } = collapseSteps(log, log)

    expect(served).toHaveLength(log.length)
    expect(digests).toEqual([])
  })

  it('decides retention over the whole log, not the page, so a split turn agrees across pages', () => {
    seq = 0
    const log = turn(1, [step(1, 1, { tool: true }), step(1, 2, { tool: true }), step(1, 3, { text: 'done' })])
    // A page cut before the final step must NOT promote step 2 to "last".
    const cut = log.slice(0, log.findIndex(item => item.type === 'step/start' && (item.data as { step: number }).step === 3))
    const { digests } = collapseSteps(cut, log)

    expect(digests.map(digest => digest.step)).toEqual([1, 2])
  })

  it('addresses a step whose start fell on an earlier page by its first elided event', () => {
    seq = 0
    const log = turn(1, [step(1, 1, { tool: true }), step(1, 2, { text: 'done' })])
    const interior = log.filter(item => item.type === 'tool/result')
    const { digests } = collapseSteps(interior, log)

    expect(digests).toHaveLength(1)
    expect(digests[0]?.startSeq).toBe(interior[0]?.seq)
  })
})

describe('elidedEventsOfTurn', () => {
  it('returns exactly what a collapsed page withheld for that turn', () => {
    seq = 0
    const log = turn(1, [step(1, 1, { tool: true }), step(1, 2, { tool: true }), step(1, 3, { text: 'done' })])
    const { events: served } = collapseSteps(log, log)
    const expanded = elidedEventsOfTurn(log, 1)

    const servedSeqs = new Set(served.map(item => item.seq))
    const expandedSeqs = new Set(expanded.map(item => item.seq))
    // Disjoint: expansion adds only what the page lacked.
    for (const value of expandedSeqs) expect(servedSeqs.has(value)).toBe(false)
    // Complete: together they reconstruct the whole range.
    expect(servedSeqs.size + expandedSeqs.size).toBe(log.length)
  })

  it('selects only the requested turn', () => {
    seq = 0
    const log = [
      ...turn(1, [step(1, 1, { tool: true }), step(1, 2, { text: 'a' })]),
      ...turn(2, [step(2, 1, { tool: true }), step(2, 2, { text: 'b' })]),
    ]
    expect(elidedEventsOfTurn(log, 2).every(item => (item.data as { turn: number }).turn === 2)).toBe(true)
  })

  it('stops at the caller\'s window head, so a turn older than the page adds no hole', () => {
    seq = 0
    // The turn starts well before the page that shows it: steps 1-2 belong to
    // pages the client has not loaded, step 3 is withheld on the page it holds.
    const log = turn(1, [
      step(1, 1, { tool: true }),
      step(1, 2, { tool: true }),
      step(1, 3, { tool: true }),
      step(1, 4, { text: 'done' }),
    ])
    const head = log.find(item => item.type === 'step/start'
      && (item.data as { step: number }).step === 3)?.seq as number

    const bounded = elidedEventsOfTurn(log, 1, head)
    expect(bounded.every(item => item.seq >= head)).toBe(true)
    // Unbounded expansion would reach below the window and leave the client's
    // contiguous range describing events it never received.
    expect(elidedEventsOfTurn(log, 1).some(item => item.seq < head)).toBe(true)
  })

  it('returns exactly the page\'s withheld rows when bounded to that page', () => {
    seq = 0
    const log = turn(1, [step(1, 1, { tool: true }), step(1, 2, { tool: true }), step(1, 3, { text: 'done' })])
    const head = log.find(item => item.type === 'step/start'
      && (item.data as { step: number }).step === 2)?.seq as number
    const page = log.filter(item => item.seq >= head)

    const { events: served } = collapseSteps(page, log)
    const expanded = elidedEventsOfTurn(log, 1, head)
    const servedSeqs = new Set(served.map(item => item.seq))
    const expandedSeqs = new Set(expanded.map(item => item.seq))

    for (const value of expandedSeqs) expect(servedSeqs.has(value)).toBe(false)
    expect(servedSeqs.size + expandedSeqs.size).toBe(page.length)
  })

  it('returns nothing for a turn the log does not contain', () => {
    seq = 0
    const log = turn(1, [step(1, 1, { text: 'done' })])
    expect(elidedEventsOfTurn(log, 99)).toEqual([])
  })
})

describe('diffLineDelta', () => {
  it('counts a created file as all additions', () => {
    expect(diffLineDelta(null, 'a\nb\n')).toEqual({ added: 2, removed: 0 })
  })

  it('cancels lines present in both images regardless of position', () => {
    expect(diffLineDelta('a\nb\n', 'b\na\n')).toEqual({ added: 0, removed: 0 })
  })

  it('reads a modified line as one addition and one removal', () => {
    expect(diffLineDelta('a\n', 'b\n')).toEqual({ added: 1, removed: 1 })
  })

  it('ends the last line on a single terminating newline', () => {
    expect(diffLineDelta(null, 'a')).toEqual({ added: 1, removed: 0 })
    expect(diffLineDelta(null, '')).toEqual({ added: 0, removed: 0 })
  })
})

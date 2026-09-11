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
import { collapseSteps, elidedEventsOfTurn } from '../src/step-collapse.ts'

let seq = 0

function event(type: string, data: unknown, time = 1000): SessionEvent {
  return {
    type, seq: seq++, time, data,
    ...['user/message', 'assistant/message', 'tool/result', 'system/message'].includes(type) ? { surfaceOp: 'append' } : {},
  } as unknown as SessionEvent
}

/** One settled root call as the log records it: the head, then the result. */
function toolPair(turn: number, step: number, callId: string, options: {
  name?: string
  args?: unknown
  isError?: boolean
  error?: { name: string; code: string }
  meta?: unknown
} = {}): SessionEvent[] {
  return [
    event('tool/call', { turn, step, callId, name: options.name ?? 'write', arguments: JSON.stringify(options.args ?? {}) }),
    event('tool/result', {
      turn,
      step,
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [], isError: options.isError === true }],
      },
      ...options.error === undefined ? {} : { error: options.error },
      ...options.meta === undefined ? {} : { meta: options.meta },
    }),
  ]
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
    events.push(...toolPair(turn, index, `c${String(turn)}-${String(index)}`))
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
  it('does not recount compaction replacements of an already recorded tool result', () => {
    seq = 0
    const log = [
      event('turn/start', { turn: 1 }),
      event('step/start', { turn: 1, step: 1 }),
      event('assistant/message', { turn: 1, step: 1, message: { content: [] } }),
      ...toolPair(1, 1, 'write-once', { args: { file_path: 'a.ts', content: 'new\n' }, meta: { diffs: [] } }),
      event('step/end', { turn: 1, step: 1 }),
      ...step(1, 2, { text: 'done' }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    const original = log.find(item => item.type === 'tool/result') as SessionEvent<'tool/result'>
    const replacement = {
      ...event('tool/result', original.data),
      surfaceOp: { op: 'replace' as const, startSeq: original.seq, endSeq: original.seq },
      sourceEventSeqs: [original.seq],
    } as SessionEvent
    log.push(replacement)
    expect(collapseSteps(log, log).digests).toMatchObject([
      { calls: 1, filePaths: ['a.ts'], added: 1, removed: 0 },
    ])
  })

  it('counts interrupted root and nested starts whose step or turn closed without outcomes', () => {
    for (const closeStep of [true, false]) {
      seq = 0
      const log = [
        event('turn/start', { turn: 1 }),
        event('step/start', { turn: 1, step: 1 }),
        event('assistant/message', { turn: 1, step: 1, message: { content: [] } }),
        event('tool/call', { turn: 1, step: 1, callId: 'interrupted', name: 'run_code', arguments: '{}' }),
        event('tool/ptc-dispatch-start', { rootCallId: 'interrupted', parentCallId: 'interrupted', subCallId: 'unsettled-child', name: 'write', arguments: { file_path: 'not-written.txt', content: 'do not count' } }),
        ...closeStep ? [event('step/end', { turn: 1, step: 1 })] : [],
        ...step(1, 2, { text: 'interrupted' }),
        event('turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
      ]
      expect(collapseSteps(log, log).digests).toMatchObject([
        { calls: 2, filePaths: [], added: 0, removed: 0 },
      ])
    }
  })

  it('accounts and elides settled PTC subcalls through their root step', () => {
    seq = 0
    const log = [
      event('turn/start', { turn: 1 }),
      event('step/start', { turn: 1, step: 1 }),
      event('assistant/message', { turn: 1, step: 1, message: { content: [] } }),
      event('tool/call', { turn: 1, step: 1, callId: 'root', name: 'run_code', arguments: '{}' }),
      event('tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'root', subCallId: 'a', name: 'run_code', arguments: { code: 'await tools.read({file_path: "b.txt"})' } }),
      event('tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'a', subCallId: 'b', name: 'read', arguments: { file_path: 'b.txt' } }),
      event('tool/ptc-dispatch', { rootCallId: 'root', parentCallId: 'a', subCallId: 'b', name: 'read', arguments: { file_path: 'b.txt' }, content: [], isError: true }),
      event('tool/ptc-dispatch', { rootCallId: 'root', parentCallId: 'root', subCallId: 'a', name: 'run_code', arguments: { code: 'await tools.read({file_path: "b.txt"})' }, content: [], isError: false }),
      event('tool/result', { turn: 1, step: 1, message: { source: { callId: 'root' }, content: [{ type: 'tool-result', isError: false }] } }),
      event('step/end', { turn: 1, step: 1 }),
      event('step/start', { turn: 1, step: 2 }),
      event('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'done' }] } }),
      event('step/end', { turn: 1, step: 2 }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    const collapsed = collapseSteps(log, log)
    expect(collapsed.digests).toMatchObject([{ steps: 1, calls: 3, filePaths: [], added: 0, removed: 0 }])
    expect(collapsed.events.some(item => item.type.startsWith('tool/ptc-'))).toBe(false)
    const withheld = elidedEventsOfTurn(log, 1)
    expect(withheld.filter(item => item.type.startsWith('tool/ptc-'))).toHaveLength(4)
    expect(withheld).toEqual(log.filter(item => !collapsed.events.includes(item)))

    const unrelated = event('tool/ptc-dispatch', { rootCallId: 'not-loaded', subCallId: 'orphan', name: 'read', arguments: {}, content: [], isError: false })
    expect(collapseSteps([unrelated], [...log, unrelated]).events).toEqual([unrelated])
  })

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

  it('reads an assistant message with no content as carrying no closing text', () => {
    seq = 0
    const log = turn(1, [
      step(1, 1, { tool: true }),
      [
        event('step/start', { turn: 1, step: 2 }),
        event('assistant/message', { turn: 1, step: 2, message: {} }),
        event('step/end', { turn: 1, step: 2 }),
      ],
      step(1, 3, { text: 'done' }),
    ])
    expect(collapseSteps(log, log).digests.map(digest => digest.step)).toEqual([1, 2])
  })

  it('never elides an event whose turn the scope never opened', () => {
    seq = 0
    // A coordinate-bearing event from a turn with no other events in scope has
    // no retention decision, so it is served rather than withheld.
    const stray = event('tool/result', {
      turn: 9, step: 1, message: { source: { kind: 'tool', callId: 'x' }, content: [{ isError: false }] },
    })
    const log = [...turn(1, [step(1, 1, { text: 'done' })])]
    const retainedScope = [...log]
    const { events: served } = collapseSteps([stray], retainedScope)
    expect(served).toEqual([stray])
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
        ...toolPair(1, 1, 'c1', { name: 'edit', meta: { diffs: [{ path: 'a.ts', oldText: 'x\n', newText: 'x\ny\n' }] } }),
        ...toolPair(1, 1, 'c2', { name: 'edit', meta: { diffs: [{ path: 'b.ts', oldText: 'p\nq\n', newText: 'p\n' }] } }),
        event('step/end', { turn: 1, step: 1 }),
      ],
      step(1, 2, { text: 'done' }),
    ])
    const { digests } = collapseSteps(log, log)

    expect(digests[0]).toMatchObject({ calls: 2, added: 1, removed: 1, filePaths: ['a.ts', 'b.ts'] })
  })

  it('reads a settled mutation exactly as the diff card does', () => {
    seq = 0
    const log = turn(1, [
      [
        event('step/start', { turn: 1, step: 1 }),
        // A create persists no hunk: the write's own content is what landed.
        ...toolPair(1, 1, 'create', { args: { file_path: 'new.ts', content: 'one\ntwo\n' }, meta: { diffs: [] } }),
        // A failed edit applied nothing, whatever its metadata says.
        ...toolPair(1, 1, 'failed', {
          name: 'edit', isError: true, error: { name: 'EditError', code: 'not-found' },
          meta: { diffs: [{ path: 'gone.ts', oldText: 'a\n', newText: 'b\n' }] },
        }),
        // An edit whose metadata is malformed counts as a call without lines.
        ...toolPair(1, 1, 'odd', { name: 'edit', meta: { diffs: [{ path: 7 }] } }),
        // A tool that persists no diff is a call and nothing more.
        ...toolPair(1, 1, 'shell', { name: 'bash', args: { command: 'ls' } }),
        // The same file touched again in the step counts once.
        ...toolPair(1, 1, 'again', { name: 'edit', meta: { diffs: [{ path: 'new.ts', oldText: 'two\n', newText: 'TWO\n' }] } }),
        event('step/end', { turn: 1, step: 1 }),
      ],
      step(1, 2, { text: 'done' }),
    ])
    const { digests } = collapseSteps(log, log)

    expect(digests[0]).toMatchObject({ calls: 5, added: 3, removed: 1, filePaths: ['new.ts'] })
  })

  it('reads a result whose call head lies outside the scope as a call without a head', () => {
    seq = 0
    const log = turn(1, [
      [
        event('step/start', { turn: 1, step: 1 }),
        ...toolPair(1, 1, 'orphan', { args: { file_path: 'a.ts', content: 'x\n' }, meta: { diffs: [] } }),
        event('step/end', { turn: 1, step: 1 }),
      ],
      step(1, 2, { text: 'done' }),
    ])
    // Cut the scope so the head is gone but its result remains.
    const scope = log.filter(item => item.type !== 'tool/call')
    const { digests } = collapseSteps(scope, scope)

    // Without the head no tool name is known, so the write fallback cannot apply.
    expect(digests[0]).toMatchObject({ calls: 1, added: 0, filePaths: [] })
  })

  it('omits endSeq while the step\'s end is still unlogged', () => {
    seq = 0
    const open = [
      event('turn/start', { turn: 1 }),
      event('step/start', { turn: 1, step: 1 }),
      ...toolPair(1, 1, 'c1'),
      event('assistant/message', { turn: 1, step: 1, message: { content: [] } }),
      event('step/end', { turn: 1, step: 1 }),
      event('step/start', { turn: 1, step: 2 }),
      ...toolPair(1, 2, 'c2'),
      event('step/start', { turn: 1, step: 3 }),
    ]
    const { digests } = collapseSteps(open, open)

    expect(digests.map(digest => digest.step)).toEqual([1, 2])
    expect(digests[0]?.endSeq).toBeDefined()
    expect(digests[1]?.endSeq).toBeUndefined()
  })

  it('reports whole-step figures from any page cut, with elided counting only that page', () => {
    seq = 0
    const log = turn(1, [
      [
        event('step/start', { turn: 1, step: 1 }, 5000),
        ...toolPair(1, 1, 'first', { name: 'edit', meta: { diffs: [{ path: 'a.ts', oldText: null, newText: 'x\n' }] } }),
        ...toolPair(1, 1, 'second', { name: 'edit', meta: { diffs: [{ path: 'b.ts', oldText: null, newText: 'y\n' }] } }),
        event('assistant/message', { turn: 1, step: 1, message: { content: [] }, usage: { inputTokens: 40, outputTokens: 4 } }, 5900),
        event('step/end', { turn: 1, step: 1 }),
      ],
      step(1, 2, { text: 'done' }),
    ])
    // Cut the step between its two tool pairs.
    const cutAt = log.findIndex(item => item.type === 'tool/call' && (item.data as { callId: string }).callId === 'second')
    const older = log.slice(0, cutAt)
    const newer = log.slice(cutAt)
    const [fromOlder] = collapseSteps(older, log).digests
    const [fromNewer] = collapseSteps(newer, log).digests

    const account = { turn: 1, step: 1, startSeq: log[2]?.seq, calls: 2, steps: 1, added: 2, removed: 0, filePaths: ['a.ts', 'b.ts'], inputTokens: 40, outputTokens: 4, elapsedMs: 900 }
    expect(fromOlder).toMatchObject(account)
    expect(fromNewer).toMatchObject(account)
    // The two pages withheld disjoint halves of the same interior.
    expect(fromOlder?.elided).toBe(2)
    expect(fromNewer?.elided).toBe(3)
    expect((fromOlder?.elided ?? 0) + (fromNewer?.elided ?? 0)).toBe(collapseSteps(log, log).digests[0]?.elided)
    // Both address the same step by the same boundaries, whichever page holds them.
    const end = log.find(item => item.type === 'step/end' && (item.data as { step: number }).step === 1)?.seq
    expect(fromOlder?.endSeq).toBe(end)
    expect(fromNewer?.endSeq).toBe(end)
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

  it('addresses a step by its start even when that start fell on an earlier page', () => {
    seq = 0
    const log = turn(1, [step(1, 1, { tool: true }), step(1, 2, { text: 'done' })])
    const interior = log.filter(item => item.type === 'tool/result')
    const { digests } = collapseSteps(interior, log)

    expect(digests).toHaveLength(1)
    expect(digests[0]?.startSeq).toBe(log.find(item => item.type === 'step/start')?.seq)
  })

  it('uses the first scoped step event rather than a page-local fallback when the start is missing', () => {
    seq = 0
    const log = turn(1, [step(1, 1, { tool: true }), step(1, 2, { text: 'done' })])
    // A scope cut inside step 1: neither the page nor the scope holds its start.
    const scope = log.filter(item => item.type !== 'step/start' || (item.data as { step: number }).step !== 1)
    const interior = scope.filter(item => item.type === 'tool/result')
    const { digests } = collapseSteps(interior, scope)

    expect(digests[0]?.startSeq).toBe(scope.find(item => item.type === 'tool/call')?.seq)
    expect(collapseSteps(scope, scope).digests[0]?.startSeq).toBe(digests[0]?.startSeq)
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

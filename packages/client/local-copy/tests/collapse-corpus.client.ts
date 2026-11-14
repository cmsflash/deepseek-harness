/** Session logs with elidable steps: multi-step turns, steers, interruptions, subagents and PTC runs. */

/** One raw event before it is stored. */
export type RawEvent = Record<string, unknown>

/** One named log of the corpus. */
export interface CorpusLog {
  readonly name: string
  readonly events: readonly RawEvent[]
}

const BASE_TIME = 1_700_000_000_000

/** One user-role message as the loop records it: a human prompt or steer, or an injected notice. */
function userMessage(seq: number, kind: 'user' | 'notices', text: string): Record<string, unknown> {
  return { id: `m${String(seq)}`, role: 'user', content: [{ type: 'text', text }], source: { kind } }
}

/** One settled tool-result message answering `callId`. */
function toolMessage(seq: number, callId: string, text: string): Record<string, unknown> {
  return {
    id: `m${String(seq)}`, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
    content: [{ type: 'text', text }], isError: false,
  }
}

/** How one written step looks: closing text, tool calls, a steer it claims, or no end boundary. */
interface StepOptions {
  readonly text?: string
  readonly tools?: number
  readonly steer?: string
  readonly open?: boolean
}

/** Sequential event writer with a clock that advances per event. */
class LogWriter {
  readonly events: RawEvent[] = []

  push(type: string, data: unknown, extra: Record<string, unknown> = {}): number {
    const seq = this.events.length
    this.events.push({ type, seq, time: BASE_TIME + seq * 250, data, ...extra })
    return seq
  }

  header(model = 'fk-1'): void {
    this.push('request/header', { header: { config: { model } }, reason: 'initial' })
  }

  human(text: string): void {
    this.push('user/message', userMessage(this.events.length, 'user', text), { surfaceOp: 'append' })
  }

  notice(text: string): void {
    this.push('user/message', userMessage(this.events.length, 'notices', text), { surfaceOp: 'append' })
  }

  assistant(turn: number, step: number, text: string | undefined, tokens = { input: 100 * step, output: 10 * step }): void {
    const time = BASE_TIME + this.events.length * 250
    this.push('assistant/message', {
      turn,
      step,
      message: {
        id: `m${String(this.events.length)}`,
        role: 'assistant',
        content: text === undefined ? [] : [{ type: 'text', text }],
        source: { kind: 'model', provider: 'fake', model: 'fk-1' },
      },
      usage: { inputTokens: tokens.input, outputTokens: tokens.output },
      stream: [
        { type: 'chunk', time: time - 200, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'text-chunks', time0: time - 150, index: 0, dt: [10, 10], texts: ['a', 'b'] },
        { type: 'chunk', time: time - 100, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: text ?? '' } } },
      ],
    }, { surfaceOp: 'append' })
  }

  tool(turn: number, step: number, callId: string, name = 'write', args: unknown = { file_path: `${callId}.ts`, content: 'x' }): void {
    this.push('tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) })
    this.result(turn, step, callId, `ok ${callId}`)
  }

  result(turn: number, step: number, callId: string, text: string): void {
    this.push('tool/result', { turn, step, message: toolMessage(this.events.length, callId, text) }, { surfaceOp: 'append' })
  }

  /** One whole step: an assistant message, its tool calls, then the boundary. */
  step(turn: number, step: number, options: StepOptions = {}): void {
    this.push('step/start', { turn, step })
    if (options.steer !== undefined) this.human(options.steer)
    this.assistant(turn, step, options.text)
    for (let call = 0; call < (options.tools ?? 1); call++) this.tool(turn, step, `c${String(turn)}-${String(step)}-${String(call)}`)
    if (options.open !== true) this.push('step/end', { turn, step })
  }

  turn(turn: number, prompt: string, steps: number, reason: unknown = { kind: 'completed' }): void {
    this.push('turn/start', { turn })
    this.human(prompt)
    for (let step = 1; step <= steps; step++) {
      this.step(turn, step, step === steps ? { text: `answer ${String(turn)}` } : { tools: (step % 3) + 1 })
    }
    this.push('turn/end', { turn, reason })
  }
}

/** Plain multi-step turns, one of them long enough to span several pages. */
function multiStep(): CorpusLog {
  const log = new LogWriter()
  log.header()
  log.turn(1, 'first', 4)
  log.turn(2, 'second', 1)
  log.turn(3, 'third', 12)
  log.turn(4, 'fourth', 3)
  return { name: 'multi-step turns', events: log.events }
}

/** Human steers inside running turns, plus injected notices that end no answer. */
function steered(): CorpusLog {
  const log = new LogWriter()
  log.header()
  log.turn(1, 'plan', 3)
  log.push('turn/start', { turn: 2 })
  log.human('build it')
  log.step(2, 1)
  log.step(2, 2, { text: 'half done' })
  log.step(2, 3)
  log.step(2, 4, { steer: 'also add tests' })
  log.step(2, 5, { tools: 2 })
  log.step(2, 6, { steer: 'and docs', text: 'tests added' })
  log.step(2, 7)
  log.notice('background job finished')
  log.step(2, 8)
  log.step(2, 9, { text: 'all done' })
  log.push('turn/end', { turn: 2, reason: { kind: 'completed' } })
  log.turn(3, 'thanks', 2)
  return { name: 'steered messages', events: log.events }
}

/** Interrupted and aborted turns, one with a step that never closed. */
function interrupted(): CorpusLog {
  const log = new LogWriter()
  log.header()
  log.turn(1, 'go', 3)
  log.push('turn/start', { turn: 2 })
  log.human('long task')
  log.step(2, 1, { tools: 3 })
  log.step(2, 2)
  log.step(2, 3, { open: true })
  log.push('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
  log.push('turn/start', { turn: 3 })
  log.human('retry')
  log.step(3, 1)
  log.step(3, 2, { text: 'partial' })
  log.step(3, 3)
  log.push('turn/end', { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  log.turn(4, 'finish', 4)
  return { name: 'interrupted turns', events: log.events }
}

/** Subagent delegations and PTC runs whose catalog and dispatch events sit inside steps. */
function subagents(): CorpusLog {
  const log = new LogWriter()
  log.header()
  log.push('turn/start', { turn: 1 })
  log.human('delegate')
  log.push('step/start', { turn: 1, step: 1 })
  log.assistant(1, 1, undefined)
  log.push('tool/call', { turn: 1, step: 1, callId: 'sub-1', name: 'subagent', arguments: '{"prompt":"look"}' })
  log.push('subagent/catalog', { version: 0, childId: 'session-child-1', childCreatedAt: BASE_TIME, mode: 'one-shot', label: 'look' })
  log.result(1, 1, 'sub-1', 'found')
  log.push('step/end', { turn: 1, step: 1 })
  log.push('step/start', { turn: 1, step: 2 })
  log.assistant(1, 2, undefined)
  log.push('tool/call', { turn: 1, step: 2, callId: 'ptc-1', name: 'run_code', arguments: '{}' })
  log.push('tool/ptc-dispatch-start', { rootCallId: 'ptc-1', parentCallId: 'ptc-1', subCallId: 'ptc-1a', name: 'read', arguments: { file_path: 'a.txt' } })
  log.push('tool/ptc-dispatch', { rootCallId: 'ptc-1', parentCallId: 'ptc-1', subCallId: 'ptc-1a', name: 'read', arguments: { file_path: 'a.txt' }, content: [], isError: false })
  log.result(1, 2, 'ptc-1', 'ran')
  log.push('step/end', { turn: 1, step: 2 })
  log.step(1, 3, { tools: 2 })
  log.step(1, 4, { text: 'delegated' })
  log.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  log.push('turn/start', { turn: 2 })
  log.human('again')
  log.push('step/start', { turn: 2, step: 1 })
  log.assistant(2, 1, undefined)
  log.push('tool/call', { turn: 2, step: 1, callId: 'sub-2', name: 'subagent', arguments: '{"prompt":"more"}' })
  log.push('subagent/catalog', { version: 0, childId: 'session-child-2', childCreatedAt: BASE_TIME, mode: 'continuable', label: 'more' })
  log.result(2, 1, 'sub-2', 'more found')
  log.push('step/end', { turn: 2, step: 1 })
  log.step(2, 2, { text: 'done again' })
  log.push('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return { name: 'subagents and PTC runs', events: log.events }
}

/**
 * Every corpus log, built fresh.
 * @returns the logs, each starting at seq 0.
 */
export function collapseCorpus(): readonly CorpusLog[] {
  return [multiStep(), steered(), interrupted(), subagents()]
}

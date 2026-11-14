import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  RemoteStream,
  RemoteStreamCarrierError,
  type RemoteStreamOptions,
} from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { streamHandle } from '@deepseek-ai/dsh-remote-mock'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import {
  createSessionControlStream,
  SessionEventStream,
  type SessionJournalChange,
  type SessionRemote,
} from '../src/client/index.ts'
import type { SessionRemotes } from '../src/client/sessions/remotes.ts'
import type {
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
  SessionControlFrame,
  SessionExpandStepsRequest,
  SessionExpandStepsValue,
  SessionControlKnown,
  SessionControlRequest,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionHistoryRecord,
  SessionLineEntry,
  SessionEventsPage,
  SessionPageRequest,
  SessionProjectionBaseline,
  SessionWireEvent,
} from '../src/types.ts'
import type { LocalHistoryRecord, SessionHistorySource } from '../src/client/contract/history-source.ts'
import { linkFor } from './remote/history.client.ts'

type SessionTransportRemote = Pick<SessionRemote, 'control' | 'follow' | 'page' | 'expandSteps'>

const ADDRESS: SessionAddress = { kind: 'session', sessionId: 'session-1' as never }
const SID = 'session-1' as never
const AVAILABLE_CONNECTION = {
  generation: {
    getSnapshot: () => ({ id: 1, host: { home: '/home/fixture' } }),
    subscribe: () => () => {},
  },
}

/** One journal record, and live frame, with the link the Host sends for its seq. */
function entry(seq: number): SessionHistoryRecord {
  return { type: 'event', event: { type: 'turn/start', seq, time: seq, data: { turn: seq } }, link: linkFor(seq) }
}

/** One journal record whose log kept no chain, so it carries no link. */
function unlinked(seq: number): SessionHistoryRecord {
  return { type: 'event', event: { type: 'turn/start', seq, time: seq, data: { turn: seq } } }
}

function resumed(
  after: number,
  cursor: number,
  records: readonly (SessionHistoryRecord | SessionLineEntry)[],
  assistantStream: SessionAssistantStreamBaseline = { revision: 0 },
): SessionFollowFrame {
  return {
    type: 'resumed',
    header: {
      version: SESSION_FORMAT_VERSION,
      id: ADDRESS.kind === 'session' ? ADDRESS.sessionId : ADDRESS.childSessionId,
      createdAt: 0,
      isSeeded: false,
    },
    after,
    cursor,
    records,
    projections: { asOfSeq: cursor, values: {} },
    assistantStream,
  }
}

/** One journal record framed as the stored line the Host sends for it. */
function lineEntry(record: SessionHistoryRecord, turnUsage?: null): SessionLineEntry {
  return {
    type: 'line',
    seq: record.event.seq,
    line: JSON.stringify(record.event),
    link: record.link!,
    ...(turnUsage === undefined ? {} : { turnUsage }),
  }
}

/** One journal record as the local copy reports it: linked, and measured. */
function localEntry(seq: number): LocalHistoryRecord {
  return { ...entry(seq), bytes: 16 }
}

/** A local-copy source whose every read answers nothing until a test programs it. */
interface LocalSource extends SessionHistorySource {
  readonly opening: Mock<SessionHistorySource['opening']>
  readonly page: Mock<SessionHistorySource['page']>
  readonly interval: Mock<SessionHistorySource['interval']>
  readonly elided: Mock<SessionHistorySource['elided']>
  readonly append: Mock<SessionHistorySource['append']>
  readonly opened: Mock<SessionHistorySource['opened']>
  readonly diverged: Mock<SessionHistorySource['diverged']>
}

/** The local-copy stand-in: unprogrammed reads answer undefined, so every call falls back to the Host. */
function localSource(): LocalSource {
  return {
    opening: vi.fn<SessionHistorySource['opening']>(),
    page: vi.fn<SessionHistorySource['page']>(),
    interval: vi.fn<SessionHistorySource['interval']>(),
    elided: vi.fn<SessionHistorySource['elided']>(),
    append: vi.fn<SessionHistorySource['append']>(),
    opened: vi.fn<SessionHistorySource['opened']>(),
    diverged: vi.fn<SessionHistorySource['diverged']>(),
  }
}

function page(records: readonly SessionHistoryRecord[], hasMore = false): SessionEventsPage {
  return { cursor: records.at(-1)?.event?.seq ?? -1, records, hasMore }
}

function snapshot(
  cursor: number,
  records: readonly SessionHistoryRecord[],
  hasMore = false,
  assistantStream: SessionAssistantStreamBaseline = { revision: 0 },
  projections: SessionProjectionBaseline = { asOfSeq: cursor, values: {} },
): SessionFollowFrame {
  return {
    type: 'snapshot',
    header: {
      version: SESSION_FORMAT_VERSION,
      id: ADDRESS.kind === 'session' ? ADDRESS.sessionId : ADDRESS.childSessionId,
      createdAt: 0,
      isSeeded: false,
    },
    cursor,
    records,
    hasMore,
    projections,
    assistantStream,
  }
}

function assistantFrame(frame: SessionAssistantStreamFrame): SessionFollowFrame {
  return { type: 'assistant-stream', frame }
}

function sessionClient(remote: SessionTransportRemote): SessionRemotes {
  return {
    session: remote as SessionRemote,
    $stream: <Item>(options: RemoteStreamOptions<Item>) => (
      new RemoteStream(AVAILABLE_CONNECTION, options)
    ),
    commands: { execute: () => Promise.reject(new Error('stream tests never run commands')) },
    subagents: {
      prompt: () => Promise.reject(new Error('stream tests never prompt a subagent')),
      interruptByParent: () => Promise.reject(new Error('stream tests never interrupt a subagent')),
    },
  }
}

interface FollowGeneration {
  readonly frames: readonly SessionFollowFrame[]
  readonly terminal?: Error
  readonly hold?: boolean
  readonly waitAfterFrames?: Promise<void>
}

class ScriptedSessionRemote implements SessionTransportRemote {
  readonly followRequests: SessionFollowRequest[] = []
  readonly pageRequests: SessionPageRequest[] = []
  readonly expandRequests: SessionExpandStepsRequest[] = []
  readonly controlRequests: SessionControlRequest[] = []
  readonly signals: AbortSignal[] = []

  constructor(
    private readonly generations: FollowGeneration[],
    private readonly pages: RemoteResult<SessionEventsPage>[],
    private readonly controlFrames: readonly SessionControlFrame[] = [],
    private readonly holdControl = true,
    private readonly expands: RemoteResult<SessionExpandStepsValue>[] = [],
  ) {}

  follow(request: SessionFollowRequest, signal = new AbortController().signal): RemoteStreamHandle<SessionFollowFrame, never> {
    return streamHandle(this.followFrames(request, signal))
  }

  private async *followFrames(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    const generation = this.generations.shift()
    if (generation === undefined) throw new Error('no scripted Session generation')
    this.followRequests.push(request)
    this.signals.push(signal)
    for (const frame of generation.frames) yield frame
    await generation.waitAfterFrames
    if (generation.terminal !== undefined) throw generation.terminal
    if (generation.hold === true && !signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
  }

  page(request: SessionPageRequest): Promise<RemoteResult<SessionEventsPage>> {
    this.pageRequests.push(request)
    const result = this.pages.shift()
    if (result === undefined) throw new Error('no scripted Session page')
    return Promise.resolve(result)
  }

  expandSteps(
    request: SessionExpandStepsRequest,
    _signal?: AbortSignal,
  ): Promise<RemoteResult<SessionExpandStepsValue>> {
    this.expandRequests.push(request)
    const result = this.expands.shift()
    if (result === undefined) throw new Error('no scripted Session expansion')
    return Promise.resolve(result)
  }

  control(request = {}, signal = new AbortController().signal): RemoteStreamHandle<SessionControlFrame, never> {
    this.controlRequests.push(request)
    return streamHandle(this.controlSequence(signal))
  }

  private async *controlSequence(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    for (const frame of this.controlFrames) yield frame
    if (this.holdControl && !signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
  }
}

function surfaceEvent(type = 'user/message'): SessionWireEvent {
  return { type, seq: 10, time: 10, data: {}, surfaceOp: 'append' }
}

const invalidWireEvents: [string, unknown][] = [
  ['null event', null],
  ['array event', []],
  ['extra envelope key', { ...surfaceEvent(), obsolete: true }],
  ['unknown ignorable extra envelope key', { type: 'extension/event', seq: 10, time: 10, data: {}, ignorable: true, obsolete: true }],
  ['missing data', { type: 'turn/start', seq: 10, time: 10 }],
  ['invalid type', { ...surfaceEvent(), type: null }],
  ['fractional sequence', { ...surfaceEvent(), seq: 1.5 }],
  ['negative sequence', { ...surfaceEvent(), seq: -1 }],
  ['negative zero sequence', { ...surfaceEvent(), seq: -0 }],
  ['unsafe sequence', { ...surfaceEvent(), seq: Number.MAX_SAFE_INTEGER + 1 }],
  ['fractional time', { ...surfaceEvent(), time: 0.5 }],
  ['invalid ignorable marker', { ...surfaceEvent(), ignorable: false }],
  ...['system/message', 'user/message', 'assistant/message', 'tool/result'].map((type): [string, unknown] => [
    `missing ${type} surface marker`,
    { type, seq: 10, time: 10, data: {} },
  ]),
  ...['turn/start', 'assistant/attempt', 'request/header', 'request/context', 'session/title', 'extension/event'].flatMap(type => [
    [`non-surface ${type} operation`, { ...surfaceEvent(type) }],
    [`non-surface ${type} sources`, { type, seq: 10, time: 10, data: {}, sourceEventSeqs: [0] }],
  ] as [string, unknown][]),
  ...['turn/start', 'assistant/attempt', 'request/context', 'tool/ptc-dispatch', 'session/title'].flatMap(type => [
    [`known ignorable ${type} operation`, { type, seq: 10, time: 10, data: {}, ignorable: true, surfaceOp: { opaque: true } }],
    [`known ignorable ${type} sources`, { type, seq: 10, time: 10, data: {}, ignorable: true, sourceEventSeqs: { opaque: true } }],
  ] as [string, unknown][]),
  ['assistant sources', { ...surfaceEvent('assistant/message'), sourceEventSeqs: [0] }],
  ...[[], [0, 0], [-1], [-0], [0.5], [10], [11], [Number.MAX_SAFE_INTEGER + 1]].map(
    (sourceEventSeqs): [string, unknown] => [`invalid sources ${JSON.stringify(sourceEventSeqs)}`, { ...surfaceEvent(), sourceEventSeqs }],
  ),
  ...[
    null, {}, 'replace',
    { op: 'replace', start: 0, end: 1 },
    { op: 'replace', startSeq: 0, end: 1 },
    { op: 'replace', start: 0, endSeq: 1 },
    { op: 'replace', startSeq: 0, endSeq: 1, start: 0, end: 1 },
    { op: 'replace', startSeq: 0, endSeq: 1, extra: true },
    { op: 'replace', startSeq: 0 },
    { op: 'replace', endSeq: 1 },
    ...[-1, -0, 0.5, 10, Number.MAX_SAFE_INTEGER + 1].flatMap(seq => [
      { op: 'replace', startSeq: seq, endSeq: 1 },
      { op: 'replace', startSeq: 0, endSeq: seq },
    ]),
  ].map((surfaceOp, index): [string, unknown] => [`invalid replacement ${index}`, { ...surfaceEvent(), surfaceOp }]),
  ...[{ system: '' }, { system: ' ' }, { system: 'prompt' }, { system: null }, { system: {} }, { tools: [] }, { adapterDefaults: {} }].map((optional): [string, unknown] => [
    `empty request header ${JSON.stringify(optional)}`,
    { type: 'request/header', seq: 10, time: 10, data: {
      reason: 'initial', header: { config: { provider: 'mock', model: 'mock' }, ...optional },
    } },
  ]),
  ...[false, undefined].map((isError): [string, unknown] => [
    `contradictory tool error ${String(isError)}`,
    { ...surfaceEvent('tool/result'), data: {
      message: { role: 'tool', content: [], ...(isError === undefined ? {} : { isError }) },
      error: { name: 'Error', code: 'FAILURE' },
    } },
  ]),
]

describe.each(['snapshot', 'live', 'page'] as const)('Session %s wire acceptance', (path) => {
  it.each(invalidWireEvents)('refuses %s without publishing or retrying', async (_name, event) => {
    // The Remote mock is the decoded JSON transport, not a typed same-process producer.
    const record = { type: 'event', event } as SessionHistoryRecord
    const opening = snapshot(path === 'live' ? 9 : 11, [entry(path === 'live' ? 9 : 11)])
    const remote = new ScriptedSessionRemote([{
      frames: path === 'snapshot' ? [snapshot(10, [record])]
        : path === 'live' ? [opening, record] : [opening],
      hold: true,
    }], path === 'page' ? [{ ok: true, value: page([record]) }] : [])
    const publish = vi.fn()
    const failed = vi.fn()
    const carrierFailed = vi.fn()
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false, publish, failed, carrierFailed,
    })
    try {
      if (path === 'snapshot') {
        await expect(stream.open({})).rejects.toThrow()
        expect(publish).not.toHaveBeenCalled()
      } else {
        await stream.open({})
        if (path === 'page') await expect(stream.prepend({})).rejects.toThrow()
        else await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce() })
        expect(publish).toHaveBeenCalledOnce()
      }
      expect(remote.followRequests).toHaveLength(1)
      expect(carrierFailed).not.toHaveBeenCalled()
    } finally {
      await stream.dispose()
    }
  })
})

describe('Session Client stream adapters', () => {
  it('preserves current envelopes and payloads without normalization across every journal path', async () => {
    const events: SessionWireEvent[] = [
      surfaceEvent(),
      surfaceEvent('system/message'),
      { ...surfaceEvent('system/message'), surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2], data: { message: { source: { plugin: 'system', extra: true }, content: [] }, extra: { retained: true } } },
      { ...surfaceEvent(), sourceEventSeqs: [0, 2] },
      { ...surfaceEvent(), surfaceOp: { op: 'replace', startSeq: 2, endSeq: 0 }, sourceEventSeqs: [2, 0] },
      { ...surfaceEvent('assistant/message'), data: { turn: 1, step: 1, message: {}, stream: [] } },
      { ...surfaceEvent('tool/result'), data: {
        message: { role: 'tool', content: [], isError: true },
        error: { name: 'Error', code: 'FAILURE' }, meta: { extension: ['retained'] },
      } },
      { ...surfaceEvent('tool/result'), sourceEventSeqs: [0], data: {
        message: { role: 'tool', content: [], isError: true },
      } },
      { type: 'request/header', seq: 10, time: 10, data: {
        reason: 'initial', header: { config: { provider: 'mock', model: 'mock' } },
      } },
      { type: 'request/header', seq: 10, time: 10, data: {
        reason: 'change', header: {
          config: { provider: 'mock', model: 'mock' }, extension: { nested: ['retained'] },
          tools: [{ name: 'fixture' }], adapterDefaults: { temperature: 1 },
        },
      } },
      ...['extension/event', 'tool/code-dispatch', 'tool/code-dispatch-start'].map(type => ({
        type, seq: 10, time: 10, data: { nested: [null, true] }, ignorable: true,
        surfaceOp: { opaque: ['retained'] }, sourceEventSeqs: { opaque: [null] },
      }) as unknown as SessionWireEvent),
    ]
    for (const event of events) {
      const before = structuredClone(event)
      const record: SessionHistoryRecord = { type: 'event', event }
      const remote = new ScriptedSessionRemote([{
        frames: [snapshot(10, [record]), { type: 'event', event: { ...event, seq: 11 } }], hold: true,
      }], [{ ok: true, value: page([{ type: 'event', event: { ...event, seq: 9 } }]) }])
      const changes: SessionJournalChange[] = []
      let appended!: () => void
      const ready = new Promise<void>((resolve) => { appended = resolve })
      const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
        sessionId: SID,
        full: () => false,
        publish: (change) => { changes.push(change); if (change.type === 'append') appended() },
        failed: vi.fn(),
      })
      try {
        await stream.open({})
        await ready
        await stream.prepend({})
        expect(changes.map(change => change.type)).toEqual(['replace', 'append', 'prepend'])
        expect(changes[0]).toMatchObject({ page: { records: [record] } })
        expect(event).toEqual(before)
      } finally {
        await stream.dispose()
      }
    }
  })
  it('preserves turn-end accounting through replacement, live append, and older-page prepend', async () => {
    const usage = { uncachedInputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0, unpricedCalls: 1 }
    const ended = (seq: number, turn: number, turnUsage: typeof usage | null): SessionHistoryRecord => ({
      type: 'event',
      event: { type: 'turn/end', seq, time: seq, data: { turn, reason: { kind: 'completed' } } },
      turnUsage,
    })
    const initial = ended(10, 2, usage)
    const live = ended(11, 3, usage)
    const older = ended(9, 1, null)
    const remote = new ScriptedSessionRemote([
      { frames: [snapshot(10, [initial]), live], hold: true },
    ], [{ ok: true, value: page([older]) }])
    const changes: SessionJournalChange[] = []
    let appended!: () => void
    const ready = new Promise<void>((resolve) => { appended = resolve })
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: (change) => {
        changes.push(change)
        if (change.type === 'append') appended()
      },
      failed: vi.fn(),
    })
    try {
      await stream.open({})
      await ready
      await stream.prepend({})
      expect(changes).toMatchObject([
        { type: 'replace', entries: [initial] },
        { type: 'append', entry: live },
        { type: 'prepend', entries: [older] },
      ])
    } finally {
      await stream.dispose()
    }
  })

  it('opts into assistant notifications and publishes the reconnect baseline plus live frame', async () => {
    const attemptId = LlmAttemptId('transport-attempt')
    const baseline: SessionAssistantStreamBaseline = {
      revision: 2,
      activeAttempt: {
        attemptId,
        startedAfterSeq: -1,
        turn: 1,
        step: 1,
        nextIndex: 1,
        stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['a'] }],
      },
    }
    const frame: SessionAssistantStreamFrame = {
      type: 'chunk', attemptId, revision: 3, index: 1,
      time: 1, chunk: { type: 'text-delta', index: 0, text: 'b' },
    }
    const remote = new ScriptedSessionRemote(
      [{ frames: [snapshot(0, [entry(0)], false, baseline), assistantFrame(frame)], hold: true }],
      [],
    )
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(changes).toHaveLength(2) })

    expect(remote.followRequests).toEqual([{ address: ADDRESS, activate: true, assistantStream: true }])
    expect(changes).toMatchObject([
      { type: 'replace', page: { assistantStream: baseline } },
      { type: 'assistant-stream', frame },
    ])
    await stream.dispose()
  })

  it('rejects an opted-in opening that omits its Assistant baseline', async () => {
    const remote = new ScriptedSessionRemote([{
      frames: [{
        type: 'snapshot',
        header: {
          version: SESSION_FORMAT_VERSION,
          id: ADDRESS.sessionId,
          createdAt: 0,
          isSeeded: false,
        },
        cursor: -1,
        records: [],
        hasMore: false,
        projections: { asOfSeq: -1, values: {} },
      }],
    }], [])
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: vi.fn(),
      failed: vi.fn(),
    })

    try {
      await expect(stream.open({})).rejects.toMatchObject({
        code: 'gateway/internal',
        message: 'session assistant stream omitted its opted-in opening baseline',
      })
    } finally {
      await stream.dispose()
    }
  })

  it('rejects an Assistant frame that arrives before the opening baseline', async () => {
    const remote = new ScriptedSessionRemote([{
      frames: [assistantFrame({
        type: 'start', attemptId: LlmAttemptId('pre-opening-attempt'),
        revision: 1, startedAfterSeq: -1, turn: 1, step: 1,
      })],
    }], [])
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: vi.fn(),
      failed: vi.fn(),
    })

    try {
      await expect(stream.open({})).rejects.toMatchObject({
        code: 'gateway/internal',
        message: 'session event stream emitted an entry before its opening cursor',
      })
      expect(remote.followRequests).toEqual([{ address: ADDRESS, activate: true, assistantStream: true }])
    } finally {
      await stream.dispose()
    }
  })

  it('rebaselines after a transient assistant revision gap without advancing the durable cursor', async () => {
    const attemptId = LlmAttemptId('gapped-attempt')
    const start: SessionAssistantStreamFrame = {
      type: 'start', attemptId, revision: 1, startedAfterSeq: -1,
      turn: 1, step: 1,
    }
    const gap: SessionAssistantStreamFrame = {
      type: 'chunk', attemptId, revision: 3, index: 0,
      time: 1, chunk: { type: 'text-delta', index: 0, text: 'lost predecessor' },
    }
    const replacement: SessionAssistantStreamBaseline = {
      revision: 3,
      activeAttempt: {
        attemptId,
        startedAfterSeq: -1,
        turn: 1,
        step: 1,
        nextIndex: 1,
        stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['lost predecessor'] }],
      },
    }
    const remote = new ScriptedSessionRemote([
      {
        frames: [snapshot(0, [entry(0)]), assistantFrame(start), assistantFrame(gap)],
      },
      { frames: [snapshot(0, [entry(0)], false, replacement)], hold: true },
    ], [])
    const changes: SessionJournalChange[] = []
    const carrierFailed = vi.fn()
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: (change) => { changes.push(change) },
      carrierFailed,
      failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(remote.followRequests).toHaveLength(2) })

    expect(changes.map(change => change.type)).toEqual([
      'replace', 'assistant-stream', 'resume',
    ])
    expect(changes.at(-1)).toMatchObject({
      type: 'resume', page: { records: [], assistantStream: replacement },
    })
    expect(remote.pageRequests).toEqual([])
    expect(carrierFailed).toHaveBeenCalledWith(expect.objectContaining({
      message: 'session assistant stream skipped revision 2',
    }))
    await stream.dispose()
  })

  it('rebaselines when a replacement Agent lifecycle restarts at revision one', async () => {
    const attemptId = LlmAttemptId('replacement-lifecycle-attempt')
    const previous: SessionAssistantStreamBaseline = {
      revision: 2,
      activeAttempt: {
        attemptId,
        startedAfterSeq: -1,
        turn: 1,
        step: 1,
        nextIndex: 1,
        stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['old'] }],
      },
    }
    const replacementStart: SessionAssistantStreamFrame = {
      type: 'start', attemptId, revision: 1, startedAfterSeq: -1,
      turn: 2, step: 1,
    }
    const replacement: SessionAssistantStreamBaseline = {
      revision: 1,
      activeAttempt: {
        attemptId,
        startedAfterSeq: -1,
        turn: 2,
        step: 1,
        nextIndex: 0,
        stream: [],
      },
    }
    const remote = new ScriptedSessionRemote([
      {
        frames: [snapshot(0, [entry(0)], false, previous), assistantFrame(replacementStart)],
      },
      { frames: [snapshot(0, [entry(0)], false, replacement)], hold: true },
    ], [])
    const changes: SessionJournalChange[] = []
    const carrierFailed = vi.fn()
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: (change) => { changes.push(change) },
      carrierFailed,
      failed: vi.fn(),
    })

    try {
      await stream.open({})
      await vi.waitFor(() => { expect(remote.followRequests).toHaveLength(2) })
      expect(changes).toMatchObject([
        { type: 'replace', page: { assistantStream: previous } },
        { type: 'resume', page: { records: [], assistantStream: replacement } },
      ])
      expect(carrierFailed).toHaveBeenCalledWith(expect.objectContaining({
        message: 'session assistant stream skipped revision 3',
      }))
    } finally {
      await stream.dispose()
    }
  })

  it('validates one scalar current-event range before publishing Client entries', async () => {
    const remote = new ScriptedSessionRemote(
      [{ frames: [snapshot(2, [entry(0), entry(1), entry(2)]), entry(3)], hold: true }],
      [],
    )
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(changes).toHaveLength(2) })

    expect(changes[0]).toMatchObject({
      type: 'replace',
      entries: [
        entry(0),
        entry(1),
        entry(2),
      ],
    })
    expect(changes[1]).toEqual({ type: 'append', entry: entry(3) })
    await stream.dispose()
  })

  it('binds an event journal to one address and publishes replace, append, and prepend changes', async () => {
    const remote = new ScriptedSessionRemote(
      [{
        frames: [
          snapshot(3, [entry(2), entry(3)], true),
          entry(3),
          entry(4),
        ],
        hold: true,
      }],
      [
        { ok: true, value: page([entry(0), entry(1)], false) },
      ],
    )
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })

    await stream.open({ maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } })
    await vi.waitFor(() => { expect(changes).toHaveLength(2) })
    await stream.prepend({ beforeSeq: 2, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } })

    expect(remote.followRequests).toEqual([{
      address: ADDRESS, activate: true, assistantStream: true, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 },
    }])
    expect(remote.pageRequests).toEqual([
      { address: ADDRESS, throughSeq: 4, beforeSeq: 2, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } },
    ])
    expect(changes).toMatchObject([
      { type: 'replace', entries: [entry(2), entry(3)], hasMore: true },
      { type: 'append', entry: entry(4) },
      { type: 'prepend', entries: [entry(0), entry(1)], hasMore: false },
    ])
    await stream.dispose()
    expect(remote.signals[0]?.aborted).toBe(true)
  })

  it('replaces the retained window from each reconnect snapshot', async () => {
    const lost = new RemoteStreamCarrierError('lost')
    const remote = new ScriptedSessionRemote(
      [
        {
          frames: [snapshot(1, [entry(0), entry(1)]), entry(2)],
          terminal: lost,
        },
        { frames: [snapshot(4, [entry(0), entry(1), entry(2), entry(3), entry(4)])], hold: true },
      ],
      [],
    )
    const changes: SessionJournalChange[] = []
    const carrierFailed = vi.fn()
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: (change) => { changes.push(change) },
      carrierFailed,
      failed: vi.fn(),
    })

    await stream.open({ maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } })
    await vi.waitFor(() => { expect(remote.followRequests).toHaveLength(2) })

    expect(remote.followRequests).toEqual([
      { address: ADDRESS, activate: true, assistantStream: true, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } },
      {
        address: ADDRESS, activate: true, assistantStream: true, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 },
        resume: { afterSeq: 2, link: linkFor(2) },
      },
    ])
    expect(remote.pageRequests).toEqual([])
    expect(changes.map(change => change.type)).toEqual(['replace', 'append', 'replace'])
    expect(carrierFailed).toHaveBeenCalledWith(lost)
    await stream.dispose()
  })

  it('appends only the events a resumed reconnect carries after the held window', async () => {
    const remote = new ScriptedSessionRemote(
      [
        {
          frames: [snapshot(1, [entry(0), entry(1)], true), entry(2)],
          terminal: new RemoteStreamCarrierError('lost'),
        },
        { frames: [resumed(2, 4, [entry(3), entry(4)], { revision: 3 }), entry(5)], hold: true },
      ],
      [],
    )
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(changes).toHaveLength(4) })

    expect(remote.followRequests[1]?.resume).toEqual({ afterSeq: 2, link: linkFor(2) })
    expect(changes.slice(2)).toEqual([
      {
        type: 'resume',
        page: {
          records: [entry(3), entry(4)],
          hasMore: false,
          projections: { asOfSeq: 4, values: {} },
          assistantStream: { revision: 3 },
        },
        entries: [entry(3), entry(4)],
      },
      { type: 'append', entry: entry(5) },
    ])
    expect(remote.pageRequests).toEqual([])
    await stream.dispose()
  })

  it('asks the Host for stored lines only while a local copy is registered', async () => {
    const remote = new ScriptedSessionRemote(
      [
        { frames: [snapshot(1, [entry(0), entry(1)])], hold: true },
        { frames: [snapshot(1, [entry(0), entry(1)])], hold: true },
      ],
      [],
    )
    const bare = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: vi.fn(),
      failed: vi.fn(),
    })
    await bare.open({})
    expect(remote.followRequests[0]?.lines).toBeUndefined()
    await bare.dispose()

    const sourced = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      source: localSource(),
      publish: vi.fn(),
      failed: vi.fn(),
    })
    await sourced.open({})
    expect(remote.followRequests[1]?.lines).toBe(true)
    await sourced.dispose()
  })

  it('decodes a resumed opening of stored lines and offers the batch to the copy after publication', async () => {
    const source = localSource()
    const remote = new ScriptedSessionRemote(
      [
        { frames: [snapshot(1, [entry(0), entry(1)])], terminal: new RemoteStreamCarrierError('lost') },
        { frames: [resumed(1, 3, [lineEntry(entry(2)), lineEntry(entry(3))])], hold: true },
      ],
      [],
    )
    const changes: SessionJournalChange[] = []
    const publish = vi.fn((change: SessionJournalChange) => { changes.push(change) })
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      source,
      publish,
      failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(changes).toHaveLength(2) })

    expect(remote.followRequests[1]).toMatchObject({
      lines: true,
      resume: { afterSeq: 1, link: linkFor(1) },
    })
    expect(changes[1]).toEqual({
      type: 'resume',
      page: {
        records: [entry(2), entry(3)],
        hasMore: false,
        projections: { asOfSeq: 3, values: {} },
        assistantStream: { revision: 0 },
      },
      entries: [entry(2), entry(3)],
    })
    expect(source.append).toHaveBeenCalledExactlyOnceWith(SID, [
      { seq: 2, line: JSON.stringify(entry(2).event), link: linkFor(2) },
      { seq: 3, line: JSON.stringify(entry(3).event), link: linkFor(3) },
    ])
    expect(source.append.mock.invocationCallOrder[0]).toBeGreaterThan(publish.mock.invocationCallOrder.at(-1)!)
    await stream.dispose()
  })

  it('decodes each live stored-line frame and offers it to the copy after publication', async () => {
    const source = localSource()
    const remote = new ScriptedSessionRemote(
      [{ frames: [snapshot(1, [entry(0), entry(1)]), lineEntry(entry(2)), lineEntry(entry(3), null)], hold: true }],
      [],
    )
    const changes: SessionJournalChange[] = []
    const publish = vi.fn((change: SessionJournalChange) => { changes.push(change) })
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      source,
      publish,
      failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(changes).toHaveLength(3) })

    expect(changes.slice(1)).toEqual([
      { type: 'append', entry: entry(2) },
      { type: 'append', entry: { ...entry(3), turnUsage: null } },
    ])
    expect(source.append).toHaveBeenCalledTimes(2)
    expect(source.append).toHaveBeenNthCalledWith(1, SID, [
      { seq: 2, line: JSON.stringify(entry(2).event), link: linkFor(2) },
    ])
    expect(source.append).toHaveBeenNthCalledWith(2, SID, [
      { seq: 3, line: JSON.stringify(entry(3).event), link: linkFor(3) },
    ])
    expect(source.append.mock.invocationCallOrder[0]).toBeGreaterThan(publish.mock.invocationCallOrder[1]!)
    await stream.dispose()
  })

  it('prepends a local page with digests and serves its records to the journal', async () => {
    const digest = {
      turn: 0, step: 1, startSeq: 0, endSeq: 1, elided: 2, steps: 1, calls: 0,
      filePaths: [], added: 0, removed: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0,
    }
    const source = localSource()
    source.page.mockResolvedValue({ records: [localEntry(0), localEntry(1)], hasMore: false, digests: [digest], cursor: 1 })
    const remote = new ScriptedSessionRemote([{ frames: [snapshot(3, [entry(2), entry(3)], true)], hold: true }], [])
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      source,
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })

    await stream.open({})
    await stream.prepend({ beforeSeq: 2 })

    expect(source.page).toHaveBeenCalledWith(SID, {
      beforeSeq: 2,
      stepDetail: undefined,
      throughSeq: 3,
      full: false,
    })
    expect(changes[1]).toEqual({
      type: 'prepend',
      page: { records: [localEntry(0), localEntry(1)], hasMore: false, digests: [digest] },
      entries: [localEntry(0), localEntry(1)],
      hasMore: false,
    })
    expect(remote.pageRequests).toEqual([])
    await stream.dispose()
  })

  it('falls back to the Host when the copy serves no page, expansion, or full interval', async () => {
    const remote = new ScriptedSessionRemote(
      [{ frames: [snapshot(3, [entry(2), entry(3)], true)], hold: true }],
      [{ ok: true, value: page([entry(0), entry(1)]) }, { ok: true, value: page([entry(0), entry(1), entry(2), entry(3)]) }],
      [],
      true,
      [{ ok: true, value: { records: [entry(2)] } }],
    )
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => true,
      source: localSource(),
      publish: vi.fn(),
      failed: vi.fn(),
    })

    await stream.open({})
    await stream.prepend({ beforeSeq: 2 })
    expect(remote.pageRequests).toEqual([{ address: ADDRESS, throughSeq: 3, beforeSeq: 2 }])

    const expanded = await stream.expandSteps(0, 2)
    expect(remote.expandRequests).toEqual([{ address: ADDRESS, throughSeq: 3, turn: 0, fromSeq: 2 }])
    expect(expanded).toEqual([entry(2)])

    const range = await stream.readFullRange(0)
    expect(range).toEqual([entry(0), entry(1), entry(2), entry(3)])
    expect(remote.pageRequests).toEqual([
      { address: ADDRESS, throughSeq: 3, beforeSeq: 2 },
      { address: ADDRESS, fromSeq: 0, throughSeq: 3, stepDetail: 'full' },
    ])
    await stream.dispose()
  })

  it('falls back to the Host when a copy read rejects, logging the first failure only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('local copy: the worker was terminated')
    const source = localSource()
    source.page.mockRejectedValue(failure)
    source.elided.mockRejectedValue(failure)
    source.interval.mockRejectedValue(failure)
    const remote = new ScriptedSessionRemote(
      [{ frames: [snapshot(3, [entry(2), entry(3)], true)], hold: true }],
      [{ ok: true, value: page([entry(0), entry(1)]) }, { ok: true, value: page([entry(0), entry(1), entry(2), entry(3)]) }],
      [],
      true,
      [{ ok: true, value: { records: [entry(2)] } }],
    )
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => true,
      source,
      publish: vi.fn(),
      failed: vi.fn(),
    })

    try {
      await stream.open({})
      await stream.prepend({ beforeSeq: 2 })
      expect(await stream.expandSteps(0, 2)).toEqual([entry(2)])
      expect(await stream.readFullRange(0)).toEqual([entry(0), entry(1), entry(2), entry(3)])
      expect(remote.pageRequests).toEqual([
        { address: ADDRESS, throughSeq: 3, beforeSeq: 2 },
        { address: ADDRESS, fromSeq: 0, throughSeq: 3, stepDetail: 'full' },
      ])
      expect(remote.expandRequests).toEqual([{ address: ADDRESS, throughSeq: 3, turn: 0, fromSeq: 2 }])
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        '[session-controller] local copy read failed; reading from the Host instead:',
        failure,
      )
    } finally {
      warn.mockRestore()
      await stream.dispose()
    }
  })

  it('repairs a live gap from the Host when the copy read rejects, and keeps following', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const source = localSource()
    source.page.mockRejectedValue(new Error('local copy: the worker request failed'))
    const remote = new ScriptedSessionRemote(
      [{ frames: [snapshot(0, [entry(0)]), entry(2), entry(3)], hold: true }],
      [{ ok: true, value: page([entry(0), entry(1), entry(2)]) }],
    )
    const changes: SessionJournalChange[] = []
    const failed = vi.fn()
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      source,
      publish: (change) => { changes.push(change) },
      failed,
    })

    try {
      await stream.open({})
      await vi.waitFor(() => { expect(changes).toHaveLength(3) })
      expect(source.page).toHaveBeenCalledOnce()
      expect(remote.pageRequests).toEqual([{ address: ADDRESS, throughSeq: 2 }])
      expect(changes[2]).toEqual({ type: 'append', entry: entry(3) })
      expect(failed).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
      await stream.dispose()
    }
  })

  it('reads a full interval the copy covers without a Host page call', async () => {
    const source = localSource()
    source.interval.mockResolvedValue([localEntry(0), localEntry(1), localEntry(2), localEntry(3)])
    const remote = new ScriptedSessionRemote([{ frames: [snapshot(3, [entry(2), entry(3)], true)], hold: true }], [])
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => true,
      source,
      publish: vi.fn(),
      failed: vi.fn(),
    })

    await stream.open({})
    const range = await stream.readFullRange(0)

    expect(range).toEqual([localEntry(0), localEntry(1), localEntry(2), localEntry(3)])
    expect(remote.pageRequests).toEqual([])
    await stream.dispose()
  })

  it('rejects a local full interval that does not cover the requested range', async () => {
    const source = localSource()
    source.interval.mockResolvedValue([localEntry(0), localEntry(2)])
    const remote = new ScriptedSessionRemote([{ frames: [snapshot(2, [entry(1), entry(2)])], hold: true }], [])
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => true,
      source,
      publish: vi.fn(),
      failed: vi.fn(),
    })

    await stream.open({})
    await expect(stream.readFullRange(0)).rejects.toThrow('session full-detail interval is incomplete')
    await stream.dispose()
  })

  it('opens from a local page without awaiting a follow frame', async () => {
    const remote = new ScriptedSessionRemote([{ frames: [snapshot(9, [entry(9)])], hold: true }], [])
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      source: localSource(),
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })
    const local = page([entry(2), entry(3)], true)

    await stream.open({}, { page: { records: local.records, hasMore: local.hasMore }, cursor: 3 })

    expect(changes).toEqual([{
      type: 'replace',
      page: { records: [entry(2), entry(3)], hasMore: true },
      entries: [entry(2), entry(3)],
      hasMore: true,
      local: true,
    }])
    expect(remote.followRequests).toHaveLength(1)
    await stream.dispose()
  })

  it('adopts an already-held window and resumes from its newest entry', async () => {
    const remote = new ScriptedSessionRemote([{ frames: [resumed(1, 2, [entry(2)])], hold: true }], [])
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      source: localSource(),
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })

    stream.adopt({}, { first: 0, last: 1, newest: entry(1) })
    expect(changes).toEqual([])

    await vi.waitFor(() => { expect(changes).toHaveLength(1) })
    expect(remote.followRequests[0]?.resume).toEqual({ afterSeq: 1, link: linkFor(1) })
    expect(changes[0]).toEqual({
      type: 'resume',
      page: {
        records: [entry(2)],
        hasMore: false,
        projections: { asOfSeq: 2, values: {} },
        assistantStream: { revision: 0 },
      },
      entries: [entry(2)],
    })
    await stream.dispose()
  })

  it('fails the stream when a stored line does not decode to the event it names', async () => {
    const malformed: SessionLineEntry = { type: 'line', seq: 2, line: '{"seq":9}', link: linkFor(2) }
    const remote = new ScriptedSessionRemote(
      [{ frames: [snapshot(1, [entry(0), entry(1)]), malformed], hold: true }],
      [],
    )
    const failed = vi.fn()
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      source: localSource(),
      publish: (change) => { changes.push(change) },
      failed,
    })

    await stream.open({})
    await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce() })

    expect(failed.mock.calls[0]?.[0]).toMatchObject({
      code: 'gateway/internal',
      message: 'stored line names seq 9 where 2 was sent',
    })
    expect(changes).toHaveLength(1)
    await stream.dispose()
  })

  it('continues the held window when a snapshot opening ends at the offered link', async () => {
    const remote = new ScriptedSessionRemote(
      [
        { frames: [snapshot(1, [entry(0), entry(1)])], terminal: new RemoteStreamCarrierError('lost') },
        {
          frames: [snapshot(1, [entry(0), entry(1)], true, { revision: 4 }, { asOfSeq: 1, values: { title: 'held' } })],
          hold: true,
        },
      ],
      [],
    )
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(changes).toHaveLength(2) })

    expect(remote.followRequests[1]?.resume).toEqual({ afterSeq: 1, link: linkFor(1) })
    expect(changes[1]).toEqual({
      type: 'resume',
      page: {
        records: [],
        hasMore: false,
        projections: { asOfSeq: 1, values: { title: 'held' } },
        assistantStream: { revision: 4 },
      },
      entries: [],
    })
    await stream.dispose()
  })

  it('replaces the window when the snapshot opening ends at the offered seq with another link', async () => {
    const otherLink: SessionHistoryRecord = { ...entry(1), link: linkFor(9) }
    const remote = new ScriptedSessionRemote(
      [
        { frames: [snapshot(1, [entry(0), entry(1)])], terminal: new RemoteStreamCarrierError('lost') },
        { frames: [snapshot(1, [entry(0), otherLink])], hold: true },
      ],
      [],
    )
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(changes).toHaveLength(2) })

    expect(changes.map(change => change.type)).toEqual(['replace', 'replace'])
    await stream.dispose()
  })

  it('replaces the window when the snapshot opening ends past the offered seq', async () => {
    const remote = new ScriptedSessionRemote(
      [
        { frames: [snapshot(1, [entry(0), entry(1)])], terminal: new RemoteStreamCarrierError('lost') },
        { frames: [snapshot(2, [entry(0), entry(1), entry(2)])], hold: true },
      ],
      [],
    )
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(changes).toHaveLength(2) })

    expect(changes.map(change => change.type)).toEqual(['replace', 'replace'])
    await stream.dispose()
  })

  it('replaces the window when the snapshot opening carries no record', async () => {
    const remote = new ScriptedSessionRemote(
      [
        { frames: [snapshot(1, [entry(0), entry(1)])], terminal: new RemoteStreamCarrierError('lost') },
        { frames: [snapshot(-1, [])], hold: true },
      ],
      [],
    )
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(changes).toHaveLength(2) })

    expect(changes.map(change => change.type)).toEqual(['replace', 'replace'])
    await stream.dispose()
  })

  it('replaces the window on a first opening, which offers no resume point', async () => {
    const remote = new ScriptedSessionRemote(
      [{ frames: [snapshot(1, [entry(0), entry(1)])], hold: true }],
      [],
    )
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(changes).toHaveLength(1) })

    expect(remote.followRequests[0]).not.toHaveProperty('resume')
    expect(changes.map(change => change.type)).toEqual(['replace'])
    await stream.dispose()
  })

  it('names only the newest held record, whose link addresses the whole window', async () => {
    const records = Array.from({ length: 21 }, (_, seq) => entry(seq))
    const remote = new ScriptedSessionRemote(
      [
        { frames: [snapshot(20, records)], terminal: new RemoteStreamCarrierError('lost') },
        { frames: [snapshot(20, records)], hold: true },
      ],
      [],
    )
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false, publish: vi.fn(), failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(remote.followRequests).toHaveLength(2) })

    expect(remote.followRequests[1]?.resume).toEqual({ afterSeq: 20, link: linkFor(20) })
    await stream.dispose()
  })

  it('offers the link of the last event a covering record stands for', async () => {
    const covering: SessionHistoryRecord = { ...entry(3), covers: { from: 1, to: 3 } }
    const remote = new ScriptedSessionRemote(
      [
        { frames: [snapshot(3, [entry(0), covering])], terminal: new RemoteStreamCarrierError('lost') },
        { frames: [snapshot(3, [entry(0), covering])], hold: true },
      ],
      [],
    )
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false, publish: vi.fn(), failed: vi.fn(),
    })

    await stream.open({ stepDetail: 'collapsed' })
    await vi.waitFor(() => { expect(remote.followRequests).toHaveLength(2) })

    expect(remote.followRequests[1]?.resume).toEqual({ afterSeq: 3, link: linkFor(3) })
    await stream.dispose()
  })

  it('asks for a snapshot when the newest held record carries no link', async () => {
    const remote = new ScriptedSessionRemote(
      [
        { frames: [snapshot(2, [entry(0), entry(1), unlinked(2)])], terminal: new RemoteStreamCarrierError('lost') },
        { frames: [snapshot(2, [entry(0), entry(1), unlinked(2)])], hold: true },
      ],
      [],
    )
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false, publish: vi.fn(), failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(remote.followRequests).toHaveLength(2) })

    expect(remote.followRequests[1]).not.toHaveProperty('resume')
    await stream.dispose()
  })

  it('offers the link of the newest record a resumed opening carried', async () => {
    const remote = new ScriptedSessionRemote(
      [
        { frames: [snapshot(1, [entry(0), entry(1)]), entry(2)], terminal: new RemoteStreamCarrierError('lost') },
        { frames: [resumed(2, 4, [entry(3), entry(4)])], terminal: new RemoteStreamCarrierError('lost') },
        { frames: [snapshot(4, [entry(0), entry(1), entry(2), entry(3), entry(4)])], hold: true },
      ],
      [],
    )
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false, publish: vi.fn(), failed: vi.fn(),
    })

    await stream.open({})
    await vi.waitFor(() => { expect(remote.followRequests).toHaveLength(3) })

    expect(remote.followRequests.map(request => request.resume)).toEqual([
      undefined,
      { afterSeq: 2, link: linkFor(2) },
      { afterSeq: 4, link: linkFor(4) },
    ])
    await stream.dispose()
  })

  it('rejects a resumed opening that answers a request without a resume point', async () => {
    const remote = new ScriptedSessionRemote([{ frames: [resumed(0, 1, [entry(1)])], hold: true }], [])
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false, publish: vi.fn(), failed: vi.fn(),
    })

    const opening = stream.open({})
    await expect(opening).rejects.toThrow('not offered')
    await expect(opening).rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('repairs a resumed event stream without an optional message limit', async () => {
    const finish = Promise.withResolvers<undefined>()
    const remote = new ScriptedSessionRemote(
      [
        {
          frames: [snapshot(0, [entry(0)])],
          waitAfterFrames: finish.promise,
          terminal: new RemoteStreamCarrierError('lost'),
        },
        { frames: [snapshot(1, [entry(0), entry(1)])], hold: true },
      ],
      [],
    )
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: vi.fn(),
      failed: vi.fn(),
    })

    await stream.open({})
    finish.resolve(undefined)
    await vi.waitFor(() => { expect(remote.followRequests).toHaveLength(2) })
    expect(remote.followRequests).toEqual([
      { address: ADDRESS, activate: true, assistantStream: true },
      { address: ADDRESS, activate: true, assistantStream: true, resume: { afterSeq: 0, link: linkFor(0) } },
    ])
    expect(remote.pageRequests).toEqual([])
    await stream.dispose()
  })

  it.each([{}, { maxMessages: 50 }, { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }])('repairs a live gap preserving history limits %j', async (request) => {
    const remote = new ScriptedSessionRemote(
      [{ frames: [snapshot(0, [entry(0)]), entry(2)], hold: true }],
      [{ ok: true, value: page([entry(0), entry(1), entry(2)]) }],
    )
    const changes: SessionJournalChange[] = []
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: (change) => { changes.push(change) },
      failed: vi.fn(),
    })

    try {
      await stream.open(request)
      await vi.waitFor(() => { expect(changes).toHaveLength(2) })
      expect(remote.pageRequests).toEqual([{ address: ADDRESS, throughSeq: 2, ...request }])
    } finally {
      await stream.dispose()
    }
  })

  it('turns a pagination failure into a typed stream failure', async () => {
    const failure = new RemoteError('session/not-found', 'missing', { sessionId: 'session-1' as never })
    const remote = new ScriptedSessionRemote(
      [{ frames: [snapshot(-1, [])], hold: true }],
      [{ ok: false, error: failure }],
    )
    const stream = new SessionEventStream(sessionClient(remote), ADDRESS, {
      sessionId: SID,
      full: () => false,
      publish: vi.fn(),
      failed: vi.fn(),
    })

    await stream.open({})
    await expect(stream.prepend({})).rejects.toMatchObject({ code: 'session/not-found' })
    await expect(stream.open({})).rejects.toThrow('already opened')
    expect(remote.signals[0]?.aborted).toBe(false)
    expect(remote.pageRequests).toEqual([{ address: ADDRESS, throughSeq: -1 }])
    await stream.dispose()
    expect(remote.signals[0]?.aborted).toBe(true)
  })

  it('maps the Host-wide control baseline and deltas into one snapshot stream', async () => {
    const baseline: SessionControlFrame = {
      type: 'baseline',
      value: { projections: {} },
    }
    const update: SessionControlFrame = {
      type: 'projection', sessionId: 'session-1' as never, key: 'title', value: 'updated', seq: 1,
    }
    const remote = new ScriptedSessionRemote([], [], [baseline, update])
    const accept = vi.fn<(frame: SessionControlFrame) => void>()
    const stream = createSessionControlStream(sessionClient(remote), {
      accept,
      known: () => [],
      failed: vi.fn(),
    })

    stream.start()
    stream.start()
    await vi.waitFor(() => { expect(accept).toHaveBeenCalledTimes(2) })
    expect(accept.mock.calls.map(([frame]) => frame)).toEqual([baseline, update])
    await stream.dispose()
    await stream.dispose()
  })

  it('reports the held checkpoints on every control opening', async () => {
    const baseline: SessionControlFrame = { type: 'baseline', value: { projections: {} } }
    const checkpoint: SessionControlKnown = {
      sessionId: 'session-1' as never, asOfSeq: 7, link: 'a'.repeat(64) as never,
    }
    let held: readonly SessionControlKnown[] = [checkpoint]
    const remote = new ScriptedSessionRemote([], [], [baseline])
    const accept = vi.fn<(frame: SessionControlFrame) => void>()
    const stream = createSessionControlStream(sessionClient(remote), {
      accept,
      known: () => held,
      failed: vi.fn(),
    })
    stream.start()
    await vi.waitFor(() => { expect(accept).toHaveBeenCalledOnce() })
    expect(remote.controlRequests).toEqual([{ known: [checkpoint] }])

    held = []
    stream.restart()
    await vi.waitFor(() => { expect(accept).toHaveBeenCalledTimes(2) })
    expect(remote.controlRequests).toEqual([{ known: [checkpoint] }, { known: [] }])
    await stream.dispose()
  })

  it('classifies control streams that end before and after their opening baseline', async () => {
    const beforeFailed = vi.fn()
    const before = createSessionControlStream(
      sessionClient(new ScriptedSessionRemote([], [], [], false)),
      { accept: vi.fn(), known: () => [], failed: beforeFailed },
    )
    before.start()
    await vi.waitFor(() => { expect(beforeFailed).toHaveBeenCalledOnce() })
    expect(beforeFailed.mock.calls[0]?.[0]).toMatchObject({
      message: 'session control stream ended before its opening snapshot',
    })
    await before.dispose()

    const baseline: SessionControlFrame = {
      type: 'baseline',
      value: { projections: {} },
    }
    const carrierFailed = vi.fn()
    const failed = vi.fn()
    const afterRemote = new ScriptedSessionRemote([], [], [baseline], false)
    const after = createSessionControlStream(sessionClient(afterRemote), {
      accept: vi.fn(),
      known: () => [],
      carrierFailed: (error) => {
        carrierFailed(error)
        void after.dispose()
      },
      failed,
    })
    after.start()
    await vi.waitFor(() => { expect(carrierFailed).toHaveBeenCalledOnce() })
    expect(carrierFailed.mock.calls[0]?.[0]).toMatchObject({
      message: 'session control stream ended without a terminal result',
    })
    expect(failed).not.toHaveBeenCalled()
    await after.dispose()
  })
})

/**
 * Durable handling of the billed `costUsd` usage member and of descriptor
 * version 2 on subagent children. A released v0 log carrying both must reach V3
 * with its recorded values through the real JSONL read and write opens, a native
 * V3 log written by this backend must round-trip the same values through close
 * and reopen under the isolated generation verifier, and invalid neighbours must
 * still refuse without publishing.
 */

import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generationLogPath, type JsonlCompression } from '../src/format.ts'
import { verifyJsonlCurrentGeneration } from '../src/generation.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const id = SessionId('released-writer-child')
const parentSession = SessionId('released-writer-parent')
const config = { provider: 'litellm', model: 'research-model' }
/** Shapes match what a v0.1.1 writer stamped: continuable descriptor v2 with a paired provider/model route. */
const descriptorV2 = {
  version: 2, mode: 'continuable', provider: 'spawn', label: 'Research pricing',
  agentProvider: config.provider, agentModel: config.model,
}
const usage = { inputTokens: 65430, outputTokens: 283, costUsd: 0.188056 }
const question = {
  id: 'question', role: 'user', source: { kind: 'user' },
  content: [{ type: 'text', text: 'Summarize current pricing.' }],
}
const answerBlock = { type: 'text', text: 'Priced per token.' }
const answer = {
  id: 'answer', role: 'assistant', source: { kind: 'model', ...config },
  content: [answerBlock],
}

function rows(descriptor: SessionFormatJsonObject, messageUsage: SessionFormatJsonObject): SessionFormatJsonObject[] {
  return [
    { type: 'subagent/descriptor', data: descriptor },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'user/message', data: question, surfaceOp: 'append' },
    { type: 'request/header', data: { header: { config, system: 'Research assistant.' }, reason: 'initial' } },
    { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } } },
    { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Priced per token.' } } },
    { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: answerBlock } } },
    { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'usage', usage: messageUsage } } },
    { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } } },
    {
      type: 'assistant/message', surfaceOp: 'append', sourceEventSeqs: [[5, 9]],
      data: { turn: 1, step: 1, message: answer, usage: messageUsage },
    },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

let root: string
const contexts: Context[] = []

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function mount(compression: JsonlCompression): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  return ctx
}

async function store(compression: JsonlCompression, body: readonly SessionFormatJsonObject[]): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-v0-released-writer-'))
  const path = generationLogPath(root, undefined, id, 0, compression)
  const header = { type: 'session', version: 0, id, createdAt: 1000, parentSession, origin: 'subagent', delegationDepth: 1 }
  const events = body.map((row, seq) => ({ ...row, seq, time: 1001 + seq }))
  const chunks = [JSON.stringify(header) + '\n', events.map(event => JSON.stringify(event) + '\n').join('')]
  const bytes = compression === 'none' ? Buffer.from(chunks.join(''))
    : Buffer.concat(await Promise.all(chunks.map(chunk => compressZstdFrame(chunk))))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  return path
}

async function observe(path: string) {
  const identity = await stat(path, { bigint: true })
  return { bytes: await readFile(path), ino: identity.ino, size: identity.size, mtimeNs: identity.mtimeNs }
}

async function readSession(ctx: Context, access: 'read' | 'write') {
  const handle = await ctx.sessionPersistence.open(id, access)
  try {
    const result = await handle.read()
    const session = Session.fromRestore(id, result.events, handle.header, handle.inheritedEventCount, result.eventState)
    if (access === 'write') await handle.flush()
    return { header: handle.header, events: result.events, session }
  } finally {
    await handle.close()
  }
}

function assertMigrated({ header, events, session }: Awaited<ReturnType<typeof readSession>>) {
  expect(header).toMatchObject({ version: 3, id, parentSession, origin: 'subagent', delegationDepth: 1, isSeeded: false })
  const descriptor = events.find(event => event.type === 'subagent/descriptor') as SessionEvent<'subagent/descriptor'>
  expect(descriptor.data).toEqual({ ...descriptorV2, version: 3 })
  const assistant = events.filter(event => event.type === 'assistant/message')
  expect(assistant).toHaveLength(1)
  expect(assistant[0]?.data.usage).toEqual(usage)
  expect(assistant[0]?.data.stream).toContainEqual({ type: 'chunk', time: 1009, chunk: { type: 'usage', usage } })
  expect(events.map(event => event.type).filter(type => type.startsWith('assistant/'))).toEqual(['assistant/message'])
  expect(session.deriveMessages().map(({ role, content }) => ({ role, content }))).toEqual([
    { role: 'system', content: [{ type: 'text', text: 'Research assistant.' }] },
    { role: 'user', content: question.content },
    { role: 'assistant', content: answer.content },
  ])
  expect(session.inheritedEventCount).toBe(SessionLogOffset(0))
}

describe.each(['none', 'zstd'] as const)('released v0 writer variants (%s)', (compression) => {
  it('migrates descriptor version 2 and billed cost through read and write opens', async () => {
    const path = await store(compression, rows(descriptorV2, usage))
    const source = await observe(path)
    const ctx = await mount(compression)
    const prepared = await readSession(ctx, 'read')
    assertMigrated(prepared)
    await ctx.sessionPersistence.flush()
    expect(await observe(path)).toEqual(source)
    expect(await readdir(dirname(path))).toEqual([basename(path)])

    const written = await readSession(ctx, 'write')
    assertMigrated(written)
    expect(written.events).toEqual(prepared.events)
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    const successor = generationLogPath(root, undefined, id, 3, compression)
    expect((await readdir(dirname(path))).filter(name => name !== 'session.lock').sort())
      .toEqual([basename(path), basename(successor)].sort())
    expect(await observe(path)).toEqual(source)

    const reopened = await mount(compression)
    const native = await readSession(reopened, 'read')
    assertMigrated(native)
    expect(native.events).toEqual(prepared.events)
  })

  it('round-trips a native V3 log whose usage carries a nonzero billed cost through close and reopen', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-v0-released-writer-'))
    const nativeId = SessionId('native-billed-cost')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION, id: nativeId, createdAt: 1000, isSeeded: false, delegationDepth: 1,
      parentSession, origin: 'subagent',
    }
    const stream = [
      { type: 'text-chunks', time0: 1005, index: 0, dt: [1], texts: ['Priced ', 'per token.'] },
      { type: 'chunk', time: 1008, chunk: { type: 'usage', usage } },
      { type: 'chunk', time: 1009, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ] satisfies SessionEvent<'assistant/message'>['data']['stream']
    const assembler = new BlockAssembler()
    for (const timed of expandAssistantStream(stream)) assembler.push(timed.chunk)
    expect(assembler.usage).toEqual(usage)
    const log: SessionEvent[] = [
      { type: 'subagent/descriptor', seq: SessionSeq(0), time: 1001, data: { ...descriptorV2, version: 3 } },
      { type: 'turn/start', seq: SessionSeq(1), time: 1002, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(2), time: 1003, data: { turn: 1, step: 1 } },
      { type: 'user/message', seq: SessionSeq(3), time: 1004, data: question, surfaceOp: 'append' },
      { type: 'request/header', seq: SessionSeq(4), time: 1005, data: { header: { config }, reason: 'initial' } },
      {
        type: 'assistant/message', seq: SessionSeq(5), time: 1010, surfaceOp: 'append',
        data: { turn: 1, step: 1, message: { ...answer, content: assembler.blocks() }, usage, stream },
      },
      { type: 'step/end', seq: SessionSeq(6), time: 1011, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: SessionSeq(7), time: 1012, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[]

    const writer = await mount(compression)
    const created = await writer.sessionPersistence.create(header)
    try {
      await created.append(log)
    } finally {
      await created.close()
    }
    await writer.fiber.dispose()
    contexts.splice(contexts.indexOf(writer), 1)
    const path = generationLogPath(root, undefined, nativeId, SESSION_FORMAT_VERSION, compression)
    expect((await readdir(dirname(path))).filter(name => name !== 'session.lock')).toEqual([basename(path)])
    // The isolated verifier applies strict current admission and replays every embedded stream against its message.
    await expect(verifyJsonlCurrentGeneration(path, compression, nativeId, log.length))
      .resolves.toMatchObject({ bytes: (await stat(path)).size })

    const reopened = await mount(compression)
    for (const access of ['read', 'write'] as const) {
      const handle = await reopened.sessionPersistence.open(nativeId, access)
      try {
        expect(handle.header).toEqual(header)
        const restored = await handle.read()
        expect(restored.events).toEqual(log)
        const assistant = restored.events.find(event => event.type === 'assistant/message') as SessionEvent<'assistant/message'>
        expect(assistant.data.usage?.costUsd).toBe(0.188056)
        expect(assistant.data.stream).toContainEqual({ type: 'chunk', time: 1008, chunk: { type: 'usage', usage } })
        const session = Session.fromRestore(nativeId, restored.events, handle.header, handle.inheritedEventCount, restored.eventState)
        expect(session.deriveMessages().at(-1)).toMatchObject({ role: 'assistant', content: answer.content })
      } finally {
        await handle.close()
      }
    }
    expect((await readdir(dirname(path))).filter(name => name !== 'session.lock')).toEqual([basename(path)])
  })

  it.each([
    {
      name: 'a descriptor version 2 carrying a version 3 member',
      body: rows({ ...descriptorV2, agentReasoningEffort: 'high' }, usage),
      diagnostic: /subagent\/descriptor 0 data has unexpected member "agentReasoningEffort"/,
    },
    {
      name: 'an unreleased descriptor version',
      body: rows({ ...descriptorV2, version: 1 }, usage),
      diagnostic: /subagent\/descriptor 0 uses unsupported descriptor version 1/,
    },
    {
      name: 'a negative billed cost',
      body: rows(descriptorV2, { ...usage, costUsd: -0.01 }),
      diagnostic: /usage costUsd must not be negative/,
    },
    {
      name: 'an unreleased usage member',
      body: rows(descriptorV2, { ...usage, billedCents: 19 }),
      diagnostic: /usage has unexpected member "billedCents"/,
    },
  ])('refuses $name without publishing a successor', async ({ body, diagnostic }) => {
    const path = await store(compression, body)
    const source = await observe(path)
    const ctx = await mount(compression)
    for (const access of ['read', 'write'] as const) {
      const opened = ctx.sessionPersistence.open(id, access).then(async (handle) => { await handle.close() })
      await expect(opened).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
      await expect(opened).rejects.toThrow(diagnostic)
      await ctx.sessionPersistence.flush()
      expect(await observe(path)).toEqual(source)
      expect((await readdir(dirname(path))).filter(name => name !== 'session.lock')).toEqual([basename(path)])
    }
  })
})

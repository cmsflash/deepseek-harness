/** A dependency wait is a fixed-rate Host task, due at its creation, whose row carries the `dependencyWait` marker. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ScheduleService from '../src/index.ts'
import {
  REQUIRED_TITLE_MESSAGE, ScheduleId, createEveryScheduleRecord, renderDependencyWaitSetupPrompt, resolveEveryOccurrence,
} from '../src/domain.ts'
import { scheduleDomain, scheduleTaskSchema, type ScheduleTask } from '../src/storage.ts'
import type { ScheduleRecord } from '../src/types.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { agentFor, harness, type HarnessAgent } from './harness.ts'

const contexts: Context[] = []
const releases: (() => void)[] = []
const roots: string[] = []
const sessionId = SessionId('waiting-owner')
const CREATED_AT = '2026-09-16T00:00:00.000Z'
const ONE_HOUR_LATER = '2026-09-16T01:00:00.000Z'
const TWO_HOURS_LATER = '2026-09-16T02:00:00.000Z'

const SETUP_PROMPT = [
  "The user has put this conversation on hold until something outside it happens, such as a colleague's reply or review, or a job finishing. This reminder repeats until it is deleted.",
  'Work out from the conversation what the work is waiting on, then do one of these:',
  '- If nothing outside the conversation is blocking the work, delete this reminder with schedule_delete and say so in one line.',
  '- If it has already happened, delete this reminder with schedule_delete and continue the work.',
  '- Otherwise, use schedule_update to set this reminder\'s title to a short noun phrase naming what the work is waiting on, such as "Nico\'s review of PR 123", and its prompt to a self-contained instruction for the later checks: what to check and how, ending with "If it has happened, delete this reminder with schedule_delete, then <the next step of the work>. Otherwise, reply with one short line saying what you checked, and do nothing else." Leave its timing unchanged. Then reply with one short line naming what the work is waiting on.',
].join('\n')

const CHECK_PROMPT = 'Check whether Nico approved PR 123. If it has happened, delete this reminder with schedule_delete, then merge PR 123. '
  + 'Otherwise, reply with one short line saying what you checked, and do nothing else.'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(CREATED_AT)) })
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** Harness whose Session controller restores one spy Agent per Session, so due reminders deliver. */
async function setup(options: Parameters<typeof harness>[0] = {}) {
  const test = await harness({ ...options, onContext: ctx => contexts.push(ctx) })
  const agents = new Map<SessionId, HarnessAgent>()
  const agentOf = (id: SessionId): HarnessAgent => {
    const known = agents.get(id)
    if (known !== undefined) return known
    const agent = agentFor(test.ctx, id)
    agents.set(id, agent)
    return agent
  }
  test.resolve.mockImplementation(async id => ({ agent: agentOf(id) }))
  return { ...test, agentOf }
}

function table(test: Awaited<ReturnType<typeof harness>>) {
  const domain = test.ctx.storageDomain.get('schedule')
  if (domain === undefined) throw new Error('Schedule domain not initialized')
  // The fixture's Schedule service opens this name with scheduleDomain; registry lookup erases that type.
  return domain.table('tasks') as KvTable<ScheduleRecord['id'], ScheduleTask>
}

/** Recurring batch text delivering one reminder occurrence, as the model receives it. */
function batch(id: string, occurrenceAt: string, prompt: string): string {
  return [
    '[SCHEDULE REMINDER BATCH]',
    'This is a scheduled message from the user',
    `reminders_json: ${JSON.stringify([{ schedule_id: id, occurrence_at: occurrenceAt, reminder_prompt: prompt }])}`,
  ].join('\n')
}

/** Stored wait row whose setup prompt was already delivered, for states the service reaches only over time. */
function storedWait(id: string, owner: SessionId, status: ScheduleTask['status'], description?: string): ScheduleTask {
  return {
    sessionId: owner, status,
    record: createEveryScheduleRecord(ScheduleId(id), renderDependencyWaitSetupPrompt(), 3600, Date.now(), 'Stored wait'),
    deliveryHistory: { records: [], earlierRecordsUnavailable: false },
    dependencyWait: description === undefined ? {} : { description },
  }
}

function seed(...tasks: ScheduleTask[]) {
  return async (_ctx: Context, facility: DomainFacility) => {
    const domain = await facility.open(scheduleDomain)
    for (const task of tasks) await domain.table('tasks').put(task.record.id, task)
    await domain.close()
  }
}

function gatePut(test: Awaited<ReturnType<typeof setup>>) {
  const tasks = table(test)
  const put = tasks.put.bind(tasks)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const spy = vi.spyOn(tasks, 'put').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    return put(...args)
  })
  return { entered: entered.promise, release: () => { release.resolve(undefined) }, spy }
}

async function openJson(root: string) {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const domain = await new DomainFacility(ctx, { backend: 'json' }).open(scheduleDomain)
  ctx.effect(() => async () => { await domain.close(); await backend.close() })
  return { ctx, domain }
}

it('renders the setup prompt verbatim', () => {
  expect(renderDependencyWaitSetupPrompt()).toBe(SETUP_PROMPT)
})

it('stores a wait due at its creation, delivers the setup prompt at once, and checks again each interval', async () => {
  const test = await setup()
  const agent = test.agentOf(sessionId)
  const put = vi.spyOn(table(test), 'put')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  const record = await test.service.wait({ sessionId, title: '  Dependency check  ' })
  expect(record.id).toMatch(/^schedule-[0-9a-f-]{36}$/)
  expect(record).toEqual({
    id: record.id, kind: 'every', title: 'Dependency check', prompt: SETUP_PROMPT, everySeconds: 3600, scheduledAt: CREATED_AT,
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(put).toHaveBeenNthCalledWith(1, record.id, {
    sessionId, record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false }, dependencyWait: {},
  })
  expect(test.resolve).toHaveBeenCalledExactlyOnceWith(sessionId)
  expect(agent.followup).toHaveBeenCalledOnce()
  const message = agent.followup.mock.calls[0]![0]
  expect(message.source).toEqual({ kind: 'schedule' })
  expect(message.content).toEqual([{ type: 'text', text: batch(record.id, CREATED_AT, SETUP_PROMPT) }])
  const receipt = { scheduledAt: CREATED_AT, deliveredAt: CREATED_AT, messageId: message.id }
  expect(table(test).get(record.id)).toEqual({
    sessionId, status: 'active', record: { ...record, scheduledAt: ONE_HOUR_LATER }, lastDelivery: receipt,
    deliveryHistory: {
      records: [{ ...receipt, prompt: SETUP_PROMPT }], earlierRecordsUnavailable: false, earlierRecordsPruned: false,
    },
    dependencyWait: {},
  })
  // Storing the wait and acknowledging its setup delivery each announce their own commit.
  expect(changed).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(3_599_999)
  expect(agent.followup).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(agent.followup).toHaveBeenCalledTimes(2)
  expect(agent.followup.mock.calls[1]![0].content)
    .toEqual([{ type: 'text', text: batch(record.id, ONE_HOUR_LATER, SETUP_PROMPT) }])
  expect(table(test).get(record.id)?.record.scheduledAt).toBe(TWO_HOURS_LATER)
})

it('resolves a target equal to the decision instant as one occurrence followed by the next interval', () => {
  const record = { everySeconds: 3600, scheduledAt: CREATED_AT }
  const first = { occurrenceAt: CREATED_AT, nextScheduledAt: ONE_HOUR_LATER }
  expect(resolveEveryOccurrence(record, Date.parse(CREATED_AT))).toEqual(first)
  expect(resolveEveryOccurrence(record, Date.parse(ONE_HOUR_LATER) - 1)).toEqual(first)
  expect(resolveEveryOccurrence({ ...record, scheduledAt: ONE_HOUR_LATER }, Date.parse(ONE_HOUR_LATER)))
    .toEqual({ occurrenceAt: ONE_HOUR_LATER, nextScheduledAt: TWO_HOURS_LATER })
})

it('spaces later checks by the configured interval and accepts only whole seconds of at least 60', async () => {
  expect(ScheduleService.Config({}).dependencyWaitSeconds).toBe(3600)
  for (const dependencyWaitSeconds of [59, 0, 90.5]) {
    expect(() => ScheduleService.Config({ dependencyWaitSeconds })).toThrow()
  }
  const configured = await setup({ config: { dependencyWaitSeconds: 600 } })
  const record = await configured.service.wait({ sessionId, title: 'Dependency check' })
  expect(record).toMatchObject({ kind: 'every', everySeconds: 600, scheduledAt: CREATED_AT })
  await vi.advanceTimersByTimeAsync(0)
  expect(table(configured).get(record.id)?.record.scheduledAt).toBe('2026-09-16T00:10:00.000Z')
  // Direct construction receives no schema defaults and resolves the same interval itself.
  const direct = await setup({ direct: true })
  expect(await direct.service.wait({ sessionId, title: 'Dependency check' }))
    .toMatchObject({ kind: 'every', everySeconds: 3600, scheduledAt: CREATED_AT })
})

it('names the wait from a title update and keeps the marker through prompt-only and timing-only updates', async () => {
  const test = await setup()
  const agent = test.agentOf(sessionId)
  const created = await test.service.wait({ sessionId, title: 'Dependency check' })
  await vi.advanceTimersByTimeAsync(0)
  const delivered = table(test).get(created.id)!.record
  const instructed = await test.service.update({ sessionId, id: created.id, expected: delivered, prompt: CHECK_PROMPT })
  if (!('record' in instructed)) throw new Error('Expected the instruction update to commit')
  expect(instructed.record).toEqual({ ...delivered, prompt: CHECK_PROMPT })
  expect(table(test).get(created.id)?.dependencyWait).toEqual({})
  const named = await test.service.update({
    sessionId, id: created.id, expected: instructed.record, title: "  Nico's review of PR 123  ",
  })
  if (!('record' in named)) throw new Error('Expected the rename to commit')
  expect(named.record).toEqual({ ...instructed.record, title: "Nico's review of PR 123" })
  expect(table(test).get(created.id)?.dependencyWait).toEqual({ description: "Nico's review of PR 123" })
  expect((await test.service.catalog())[0]?.dependencyWait).toEqual({ description: "Nico's review of PR 123" })
  // The next check carries the Agent's own instruction, and delivery keeps the named marker.
  await vi.advanceTimersByTimeAsync(3_600_000)
  expect(agent.followup.mock.calls.at(-1)![0].content).toEqual([{ type: 'text', text: batch(created.id, ONE_HOUR_LATER, CHECK_PROMPT) }])
  const current = table(test).get(created.id)!
  expect(current.dependencyWait).toEqual({ description: "Nico's review of PR 123" })
  expect(await test.service.update({
    sessionId, id: created.id, expected: current.record, change: { kind: 'every', every_seconds: 7200 },
  })).toMatchObject({ updated: true, record: { everySeconds: 7200 } })
  expect(table(test).get(created.id)?.dependencyWait).toEqual({ description: "Nico's review of PR 123" })
  // Renaming an ordinary reminder never adds a marker.
  const reminder = await test.service.create(sessionId, { prompt: 'Ordinary check', title: 'Ordinary check', every_seconds: 300 })
  expect(await test.service.update({ sessionId, id: reminder.id, expected: reminder, title: 'Renamed check' }))
    .toMatchObject({ updated: true })
  expect(table(test).get(reminder.id)).not.toHaveProperty('dependencyWait')
})

it('replaces every earlier active wait of the Session in one batch and leaves other tasks alone', async () => {
  const earlier = storedWait('earlier-wait', sessionId, 'active', "Nico's review of PR 123")
  const duplicate = storedWait('duplicate-wait', sessionId, 'active')
  const ended = storedWait('ended-wait', sessionId, 'inactive')
  const elsewhere = storedWait('elsewhere-wait', SessionId('other-owner'), 'active')
  const test = await setup({ beforeService: seed(earlier, duplicate, ended, elsewhere) })
  const reminder = await test.service.create(sessionId, { prompt: 'Ordinary check', title: 'Ordinary check', every_seconds: 300 })
  const tasks = table(test)
  const deleteMany = vi.spyOn(tasks, 'deleteMany')
  const put = vi.spyOn(tasks, 'put')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  const replacement = await test.service.wait({ sessionId, title: 'Dependency check' })
  await vi.advanceTimersByTimeAsync(0)
  expect(deleteMany).toHaveBeenCalledExactlyOnceWith([earlier.record.id, duplicate.record.id])
  expect(put).toHaveBeenNthCalledWith(1, replacement.id, {
    sessionId, record: replacement, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false },
    dependencyWait: {},
  })
  expect(new Set(Object.keys(Object.fromEntries(tasks.entries()))))
    .toEqual(new Set([ended.record.id, elsewhere.record.id, reminder.id, replacement.id]))
  expect(tasks.get(ended.record.id)).toEqual(ended)
  expect(tasks.get(elsewhere.record.id)).toEqual(elsewhere)
  const catalog = Object.fromEntries((await test.service.catalog()).map(entry => [entry.id, entry]))
  expect(catalog[replacement.id]?.dependencyWait).toEqual({})
  expect(catalog[ended.record.id]).toMatchObject({ status: 'inactive', dependencyWait: {} })
  expect(catalog[reminder.id]).not.toHaveProperty('dependencyWait')
  const followup = test.agentOf(sessionId).followup
  expect(followup).toHaveBeenCalledOnce()
  expect(followup.mock.calls[0]![0].content).toEqual([{ type: 'text', text: batch(replacement.id, CREATED_AT, SETUP_PROMPT) }])
  // Removing the earlier waits, storing the new one, and its setup delivery each announce their own commit.
  expect(changed).toHaveBeenCalledTimes(3)
})

it('keeps the earlier wait and stores nothing when removing it fails', async () => {
  const earlier = storedWait('earlier-wait', sessionId, 'active', "Nico's review of PR 123")
  const test = await setup({ beforeService: seed(earlier) })
  const tasks = table(test)
  const failure = new Error('injected delete failure')
  vi.spyOn(tasks, 'deleteMany').mockRejectedValueOnce(failure)
  const put = vi.spyOn(tasks, 'put')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  await expect(test.service.wait({ sessionId, title: 'Dependency check' })).rejects.toBe(failure)
  expect(Object.fromEntries(tasks.entries())).toEqual({ [earlier.record.id]: earlier })
  expect(put).not.toHaveBeenCalled()
  // A rejected removal does not establish which rows landed, so clients are told to re-read.
  expect(changed).toHaveBeenCalledTimes(1)
})

it('leaves the Session without a wait when storing the replacement fails after the removal', async () => {
  const earlier = storedWait('earlier-wait', sessionId, 'active', "Nico's review of PR 123")
  const test = await setup({ beforeService: seed(earlier) })
  const tasks = table(test)
  const failure = new Error('injected put failure')
  vi.spyOn(tasks, 'put').mockRejectedValueOnce(failure)
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  await expect(test.service.wait({ sessionId, title: 'Dependency check' })).rejects.toBe(failure)
  await vi.advanceTimersByTimeAsync(0)
  expect([...tasks.entries()]).toEqual([])
  expect(await test.service.catalog()).toEqual([])
  expect(changed).toHaveBeenCalledTimes(1)
  expect(test.resolve).not.toHaveBeenCalled()
})

it('refuses a Session a delegated child owns without touching its stored wait', async () => {
  const child = SessionId('subagent-child')
  const stored = storedWait('child-wait', child, 'active')
  const test = await setup({ beforeService: seed(stored) })
  const agent = agentFor(test.ctx, child, { origin: 'subagent', parentSession: SessionId('top-level-parent'), delegationDepth: 1 })
  await test.ctx.agents.register(agent)
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  await expect(test.service.wait({ sessionId: child, title: 'Dependency check' })).rejects.toMatchObject({
    code: 'subagent_session',
    message: 'This Session belongs to subagent routing, which never receives reminder delivery.',
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(Object.fromEntries(table(test).entries())).toEqual({ [stored.record.id]: stored })
  expect(changed).not.toHaveBeenCalled()
  expect(test.resolve).not.toHaveBeenCalled()
})

it.each<[string, string, string]>([
  ['blank', ' \n ', REQUIRED_TITLE_MESSAGE],
  ['over-long', 'x'.repeat(121), 'title must be at most 120 characters.'],
])('rejects a %s title without replacing the current wait', async (_label, title, message) => {
  const test = await setup()
  await test.service.wait({ sessionId, title: 'Dependency check' })
  await vi.advanceTimersByTimeAsync(0)
  const tasks = table(test)
  const before = Object.fromEntries(tasks.entries())
  const put = vi.spyOn(tasks, 'put')
  const deleteMany = vi.spyOn(tasks, 'deleteMany')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  await expect(test.service.wait({ sessionId, title })).rejects.toMatchObject({ code: 'invalid_prompt', message })
  await vi.advanceTimersByTimeAsync(0)
  expect(Object.fromEntries(tasks.entries())).toEqual(before)
  expect(put).not.toHaveBeenCalled()
  expect(deleteMany).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
})

it.each(['before', 'queued'] as const)('writes nothing when cancelled %s its queue slot runs', async (when) => {
  const test = await setup()
  const current = await test.service.wait({ sessionId, title: 'Dependency check' })
  await vi.advanceTimersByTimeAsync(0)
  const tasks = table(test)
  const deleteMany = vi.spyOn(tasks, 'deleteMany')
  const controller = new AbortController()
  const reason = new Error('Cancel wait')
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  if (when === 'before') {
    controller.abort(reason)
    const put = vi.spyOn(tasks, 'put')
    await expect(test.service.wait({ sessionId, title: 'Replacement' }, controller.signal)).rejects.toBe(reason)
    expect(put).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
  } else {
    const gate = gatePut(test)
    const ahead = test.service.create(sessionId, { prompt: 'Blocks queue', title: 'Blocks queue', after_seconds: 3600 })
    await gate.entered
    const outcome = test.service.wait({ sessionId, title: 'Replacement' }, controller.signal)
      .then(value => ({ value }), (error: unknown) => ({ error }))
    controller.abort(reason)
    gate.release()
    await ahead
    expect(await outcome).toEqual({ error: reason })
    // Only the creation ahead of the cancelled wait reached storage.
    expect(gate.spy).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledTimes(1)
  }
  expect(deleteMany).not.toHaveBeenCalled()
  expect((await test.service.catalog()).filter(entry => entry.dependencyWait !== undefined).map(entry => entry.id))
    .toEqual([current.id])
  expect(test.agentOf(sessionId).followup).toHaveBeenCalledOnce()
})

it('reopens waits with their markers after a Host restart', async () => {
  const first = await setup()
  const named = await first.service.wait({ sessionId, title: 'Dependency check' })
  const unnamed = await first.service.wait({ sessionId: SessionId('quiet-owner'), title: 'Dependency check' })
  await vi.advanceTimersByTimeAsync(0)
  const delivered = table(first).get(named.id)!.record
  expect(await first.service.update({ sessionId, id: named.id, expected: delivered, title: "Nico's review of PR 123" }))
    .toMatchObject({ updated: true })
  const catalog = await first.service.catalog()
  await first.ctx.fiber.dispose()
  const second = await setup({ pool: first.pool })
  await vi.advanceTimersByTimeAsync(0)
  expect(await second.service.catalog()).toEqual(catalog)
  expect(Object.fromEntries(catalog.map(entry => [entry.id, entry.dependencyWait]))).toEqual({
    [named.id]: { description: "Nico's review of PR 123" }, [unnamed.id]: {},
  })
  expect(second.resolve).not.toHaveBeenCalled()
})

it('delivers a setup prompt that could not reach its Session once the restarted Host can restore it', async () => {
  const first = await harness({ sessionController: false, onContext: ctx => contexts.push(ctx) })
  const warn = vi.spyOn(first.ctx.logger, 'warn').mockImplementation(() => {})
  const record = await first.service.wait({ sessionId, title: 'Dependency check' })
  await vi.advanceTimersByTimeAsync(0)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('no Session activation provider'))
  expect(table(first).get(record.id)?.record.scheduledAt).toBe(CREATED_AT)
  await first.ctx.fiber.dispose()
  vi.setSystemTime(new Date('2026-09-16T00:10:00.000Z'))
  let restored: HarnessAgent | undefined
  const second = await harness({ pool: first.pool, onContext: ctx => contexts.push(ctx), beforeService: async (ctx) => {
    restored = agentFor(ctx, sessionId)
    vi.spyOn(ctx.sessionController, 'resolveAgent').mockResolvedValue({ agent: restored })
  } })
  await vi.advanceTimersByTimeAsync(0)
  if (restored === undefined) throw new Error('Expected a restored Agent')
  expect(restored.followup).toHaveBeenCalledOnce()
  expect(restored.followup.mock.calls[0]![0].content).toEqual([{ type: 'text', text: batch(record.id, CREATED_AT, SETUP_PROMPT) }])
  expect(table(second).get(record.id)?.record.scheduledAt).toBe(ONE_HOUR_LATER)
  await vi.advanceTimersByTimeAsync(3_000_000)
  expect(restored.followup).toHaveBeenCalledTimes(2)
})

it('round-trips both marker forms through the JSON backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-wait-')); roots.push(root)
  const tasks = [storedWait('named', sessionId, 'active', "Nico's review of PR 123"), storedWait('unnamed', sessionId, 'inactive')]
  const first = await openJson(root)
  for (const task of tasks) await first.domain.table('tasks').put(task.record.id, task)
  await first.ctx.fiber.dispose()
  const second = await openJson(root)
  for (const task of tasks) expect(second.domain.table('tasks').get(task.record.id)).toEqual(task)
})

it('ends the wait through deletion and through an archiving stop', async () => {
  const test = await setup()
  const first = await test.service.wait({ sessionId, title: 'Dependency check' })
  await vi.advanceTimersByTimeAsync(0)
  expect(await test.service.delete({ sessionId, id: first.id })).toEqual({ id: first.id, deleted: true })
  expect(await test.service.catalog()).toEqual([])
  const second = await test.service.wait({ sessionId, title: 'Dependency check' })
  await vi.advanceTimersByTimeAsync(0)
  expect(await test.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([])))
    .toEqual([{ kind: 'schedule', items: [{ id: second.id, label: 'Dependency check' }] }])
  await test.ctx.parallel('workspace/session-stop', { sessionId })
  expect(await test.service.catalog()).toEqual([])
  await vi.advanceTimersByTimeAsync(7_200_000)
  expect(test.agentOf(sessionId).followup).toHaveBeenCalledTimes(2)
})

const decodedRecord = createEveryScheduleRecord(
  ScheduleId('decoded-wait'), renderDependencyWaitSetupPrompt(), 3600, Date.parse(CREATED_AT), 'Decoded wait',
)

it('decodes a stored marker with or without a description', () => {
  for (const dependencyWait of [{}, { description: "Nico's review of PR 123" }]) {
    expect(scheduleTaskSchema.parse({ sessionId: 'cold', record: decodedRecord, dependencyWait }))
      .toEqual({ sessionId: 'cold', record: decodedRecord, status: 'active', dependencyWait })
  }
})

it.each([
  { description: "Nico's review of PR 123", reviewer: 'Nico' }, { description: '' }, { description: 42 }, null,
  "Nico's review of PR 123",
])('rejects a malformed stored marker %#', (dependencyWait) => {
  expect(scheduleTaskSchema.safeParse({ sessionId: 'cold', record: decodedRecord, dependencyWait }).success).toBe(false)
})

it('refuses to open a domain holding a malformed marker', async () => {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const first = await new DomainFacility(ctx, { backend: 'memory' }).open(scheduleDomain)
  await first.close()
  pool.media.get('schedule')!.tables.set('tasks', new Map([[decodedRecord.id, {
    sessionId: 'cold', record: decodedRecord, dependencyWait: { description: '' },
  }]]))
  await expect(new DomainFacility(ctx, { backend: 'memory' }).open(scheduleDomain)).rejects.toThrow()
})

// The sidebar dependency wait through the shipped composition: the row menu
// stores a wait on the Host, which delivers the setup prompt at once; the row
// shows the blue blocked status, takes the name the agent gives the wait, and
// Stop waiting deletes it. The model stub never calls tools, so the test
// renames the task the way the agent's schedule_update would.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderDependencyWaitSetupPrompt } from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/dependency-wait', import.meta.url))
const WAITING_EXPECTED = join(SNAPSHOT_DIR, 'waiting-row.expected.md')
const MODE = webSnapshotMode()
const STOP_PROVIDER = 'web-test-stop'

/** Model stub that ends every turn without output. */
class StopAdapter extends LlmAdapter {
  override async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function openRowMenu(row: Locator): Promise<void> {
  await row.hover()
  await row.locator('button[aria-label^="Session actions for "]').click()
}

describe('web e2e: sidebar dependency wait', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let handle: AgentHandle
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([STOP_PROVIDER], new StopAdapter()),
      'dependency wait stop adapter',
    )
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(cwd)
    handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('dependency-wait-owner'),
      meta: { cwd },
      agentOptions: { provider: STOP_PROVIDER, model: 'stop' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Publish the release.' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('connected Web workspace was not registered')
    await workspace.attachSession(handle.agent.session.id)
  }, 60_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await handle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'dependency wait teardown failed')
  })

  it('stores a wait from the row menu, shows the row blue under the agent\'s name, and ends it with Stop waiting', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-dependency-wait'))
    const sessionId = handle.agent.session.id
    const waits = async () => (await scaffold.ctx.schedule.catalog()).filter(task => task.sessionId === sessionId)
    const sidebar = page.getByRole('tree', { name: 'Sessions' })
    const row = sidebar.getByRole('treeitem', { name: /Publish the release/ })
    await row.waitFor({ timeout: 10_000 })

    await openRowMenu(row)
    await page.getByRole('menuitem', { name: 'Wait on dependency', exact: true }).click()
    expect(await page.getByRole('dialog').count()).toBe(0)
    await expect.poll(async () => (await waits()).length).toBe(1)
    const [created] = await waits()
    expect(created).toMatchObject({
      kind: 'every',
      everySeconds: 3600,
      status: 'active',
      title: 'Dependency check',
      prompt: renderDependencyWaitSetupPrompt(),
      dependencyWait: {},
    })
    // The setup prompt is due at creation, so the Session receives it at once.
    await expect.poll(async () => {
      const history = await scaffold.ctx.schedule.history({ sessionId, id: created!.id, limit: 5 })
      return 'records' in history ? history.records.map(record => record.prompt) : []
    }).toEqual([renderDependencyWaitSetupPrompt()])
    await row.locator('[data-state="blocked"]').waitFor({ timeout: 10_000 })
    await row.getByText('Waiting on a dependency').waitFor({ state: 'attached' })

    const [delivered] = await waits()
    if (delivered?.kind !== 'every') throw new Error('a dependency wait is an every task')
    const named = await scaffold.ctx.schedule.update({
      sessionId,
      id: delivered.id,
      expected: {
        id: delivered.id, kind: delivered.kind, title: delivered.title, prompt: delivered.prompt,
        everySeconds: delivered.everySeconds, scheduledAt: delivered.scheduledAt,
      },
      title: 'Nico\'s review of the release',
      prompt: 'Check whether Nico approved the release.',
    })
    expect(named).toMatchObject({ updated: true })
    expect((await waits())[0]?.dependencyWait).toEqual({ description: 'Nico\'s review of the release' })
    await row.getByText('Waiting on Nico\'s review of the release').waitFor({ state: 'attached', timeout: 10_000 })
    await compareOrRefreshGolden(
      WAITING_EXPECTED,
      await captureStableAria(page, '[role="tree"][aria-label="Sessions"]', scaffold.workspaceCwd),
      MODE,
    )

    await openRowMenu(row)
    await page.getByRole('menuitem', { name: 'Stop waiting', exact: true }).click()
    await expect.poll(waits).toEqual([])
    await expect.poll(() => row.locator('[data-state="blocked"]').count()).toBe(0)
    await openRowMenu(row)
    await page.getByRole('menuitem', { name: 'Wait on dependency', exact: true }).waitFor()
    await page.keyboard.press('Escape')

    await assertFixtureInventory(SNAPSHOT_DIR, ['waiting-row.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})

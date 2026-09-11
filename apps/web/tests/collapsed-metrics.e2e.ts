/** Live and paged summaries of the same recorded file write use the same result data. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFinalWorkspaceSnapshot, assertFixtureInventory, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/collapsed-metrics', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/session/fs-write/session.v3.jsonl', import.meta.url))

async function figures(row: Locator): Promise<Record<string, string | null>> {
  return {
    steps: await row.getByText(/^\d+ steps$/).textContent(),
    calls: await row.getByText(/^\d+ calls$/).textContent(),
    added: await row.getByText(/^\+\d+$/).textContent(),
    removed: await row.getByText(/^-\d+ lines$/).textContent(),
    files: await row.getByText(/^\d+ files$/).textContent(),
  }
}

describe.skipIf(MODE === 'record')('web e2e: settled file metrics across live, reload, and expansion', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, compareReplaySession: false })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Compact', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Collapsed steps', exact: true }).click()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: /^Access mode, current:/ }).click()
    await page.getByRole('menuitem', { name: 'Workspace Write', exact: true }).click()
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  it('keeps create-file counts equal and verifies the written file independently', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-collapsed-file-metrics'))
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    const settled = scaffold.whenTurnSettled(30_000)
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompts[0] as string)
    await input.press('Enter')
    await settled
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 30_000 })
    const row = page.locator('[data-collapsed-turn="1"]')
    await row.waitFor({ timeout: 15_000 })
    const live = await figures(row)
    expect(live).toEqual({ steps: '1 steps', calls: '1 calls', added: '+1', removed: '-0 lines', files: '1 files' })
    const contents = await readFile(join(scaffold.workspaceCwd, 'workspace', 'notes.txt'), 'utf8')
    expect(contents).toBe('hello world')

    await page.reload({ waitUntil: 'load' })
    await row.waitFor({ timeout: 30_000 })
    expect(await page.locator('[data-chat-call-id]').count()).toBe(0)
    const reloaded = await figures(row)
    expect(reloaded).toEqual(live)
    await row.locator('button[aria-expanded]').click()
    await expect.poll(() => page.locator('[data-chat-call-id]').count(), { timeout: 15_000 }).toBe(1)
    const expanded = await figures(row)
    expect(expanded).toEqual(live)
    await compareOrRefreshGolden(
      join(SNAPSHOT_DIR, 'metrics.expected.json'),
      JSON.stringify({ live, reloaded, expanded, file: contents }, null, 2),
      MODE,
    )
    await assertFinalWorkspaceSnapshot(SNAPSHOT_DIR, join(scaffold.workspaceCwd, 'workspace'))
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['metrics.expected.json', 'workspace.expected'])
  }, 90_000)
})

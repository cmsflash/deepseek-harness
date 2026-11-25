/** Sessions nested under Sessions in the sidebar, through the shipped Web composition and the Host's parent links. */

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const EXPECTED_DIR = fileURLToPath(new URL('./expected/thread-nesting', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/message-feedback-protocol/session.v3.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const SESSION_COUNT = 8
const ROW_KEY_PREFIX = 'session:'

describe('web e2e: Sessions nested under Sessions', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  const sidebar = (): Locator => page.getByRole('tree', { name: 'Sessions' })
  const row = (sessionId: SessionId): Locator => sidebar().locator(`[data-row-key="${ROW_KEY_PREFIX}${sessionId}"]`)
  const indent = (sessionId: SessionId): Promise<string> =>
    row(sessionId).evaluate(element => (element as HTMLElement).style.getPropertyValue('--dsh-session-indent'))
  const expandWorkspace = async (sessionRows: number): Promise<void> => {
    const workspaceRow = page.getByText(basename(scaffold.workspaceCwd), { exact: true }).first()
      .locator('xpath=ancestor::*[@role="treeitem"][1]')
    await workspaceRow.waitFor({ timeout: 15_000 })
    // Startup may expand the group holding the selected Session while this runs, so one click can also fold it.
    await expect.poll(async () => {
      if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
      return sidebar().getByText('Untitled', { exact: true }).count()
    }, { timeout: 15_000 }).toBe(sessionRows)
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const fixture = await readFile(SEED, 'utf8')
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    for (let index = 1; index <= SESSION_COUNT; index += 1) {
      await workspace.attachSession(await seedSession(scaffold, fixture, `thread-nesting-${String(index)}`))
    }

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('nests rows as the Host links them, remembers a collapse, and follows a cleared link', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-thread-nesting'))
    const registry = scaffold.ctx.workspaceRegistry
    // Five top-level rows show before any link exists; the other three wait behind Show more.
    await expandWorkspace(5)
    // The seeded Sessions share one title and timestamp, so the tree is built on the order the list shows.
    const listed = await sidebar().locator(`[data-row-key^="${ROW_KEY_PREFIX}"]`).filter({ hasText: 'Untitled' })
      .evaluateAll(rows => rows.map(element => element.getAttribute('data-row-key') ?? ''))
    const [top, mid, sibling, leaf] = listed.map(key => key.slice(ROW_KEY_PREFIX.length) as SessionId)
    if (top === undefined || mid === undefined || sibling === undefined || leaf === undefined) {
      throw new Error(`expected five Session rows, found ${String(listed.length)}`)
    }

    await registry.setSessionParent(mid, top)
    await registry.setSessionParent(sibling, top)
    await registry.setSessionParent(leaf, mid)
    await registry.setSessionAttachment(mid, top, 'detached')
    await registry.setSessionAttachment(sibling, top, 'detached')
    await expect.poll(() => row(mid).getByRole('img', { name: 'Detached: reports to you' }).count()).toBe(1)
    await expect.poll(() => indent(leaf), { timeout: 15_000 }).toBe('24px')
    // Three rows left the top level, so the five-row watermark now reaches every top-level row.
    await expect.poll(() => sidebar().getByText('Untitled', { exact: true }).count()).toBe(SESSION_COUNT)
    expect(await Promise.all([top, mid, sibling].map(indent))).toEqual(['', '12px', '12px'])
    expect(await row(top).getAttribute('aria-expanded')).toBe('true')
    expect(await row(leaf).getAttribute('aria-expanded')).toBeNull()
    // The arrow follows the title in the markup and is drawn before it.
    const arrow = await row(top).getByRole('button', { name: 'Hide sessions under Untitled' }).boundingBox()
    const title = await row(top).getByText('Untitled', { exact: true }).boundingBox()
    expect((arrow?.x ?? Infinity) + (arrow?.width ?? 0)).toBeLessThanOrEqual(title?.x ?? -Infinity)
    const marker = await row(mid).getByRole('img', { name: 'Detached: reports to you' }).boundingBox()
    const reportTitle = await row(mid).getByText('Untitled', { exact: true }).boundingBox()
    const reportArrow = await row(mid).getByRole('button', { name: 'Hide sessions under Untitled' }).boundingBox()
    expect((reportArrow?.x ?? Infinity) + (reportArrow?.width ?? 0)).toBeLessThanOrEqual(marker?.x ?? -Infinity)
    expect((marker?.x ?? Infinity) + (marker?.width ?? 0)).toBeLessThanOrEqual(reportTitle?.x ?? -Infinity)
    await sidebar().getByRole('treeitem').first().hover()
    await compareOrRefreshGolden(
      join(EXPECTED_DIR, 'sidebar.expected.md'),
      await captureStableAria(page, '[role="tree"][aria-label="Sessions"]', scaffold.workspaceCwd),
      MODE,
    )

    await row(mid).getByRole('button', { name: 'Hide sessions under Untitled' }).click()
    await expect.poll(() => row(leaf).count()).toBe(0)
    expect(await row(mid).getAttribute('aria-expanded')).toBe('false')
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expandWorkspace(SESSION_COUNT - 1)
    await expect.poll(() => row(mid).getAttribute('aria-expanded'), { timeout: 15_000 }).toBe('false')
    expect(await row(leaf).count()).toBe(0)
    expect(await row(top).getAttribute('aria-expanded')).toBe('true')

    await registry.setSessionParent(sibling, undefined)
    await expect.poll(() => indent(sibling), { timeout: 15_000 }).toBe('')
    expect(await indent(mid)).toBe('12px')
    await expect.poll(() => row(sibling).getByRole('img', { name: 'Detached: reports to you' }).count()).toBe(0)
    expect(await row(mid).getByRole('img', { name: 'Detached: reports to you' }).count()).toBe(1)

    await assertFixtureInventory(EXPECTED_DIR, ['sidebar.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})

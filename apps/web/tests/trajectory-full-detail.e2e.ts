/** Recorded history must provide every tool event when its Trajectory is opened. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, parseSeedFixture, realizeSeedFixture, renderSeedFixture, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/trajectory-full-detail', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const SESSION_ID = 'trajectory-full-detail-e2e'

/** A resumed prompt replacement references the first turn's initially elided system node. */
function withResumedHeader(raw: string): string {
  const seed = parseSeedFixture(raw)
  const system = seed.events.find(event => event.type === 'system/message')
  const header = seed.events.find(event => event.type === 'request/header')
  if (system === undefined || header === undefined) throw new Error('recorded history lacks its initial request')
  const first = seed.events.length
  const time = seed.events.at(-1)?.time ?? 0
  const extra: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(first), time: time + 1, data: { turn: 2 } },
    { type: 'step/start', seq: SessionSeq(first + 1), time: time + 2, data: { turn: 2, step: 1 } },
    { type: 'user/message', seq: SessionSeq(first + 2), time: time + 3, surfaceOp: 'append', data: createUserMessage({
      content: [{ type: 'text', text: 'Resume with the updated prompt, then cancel.' }], source: { kind: 'user' },
    }) },
    { type: 'system/message', seq: SessionSeq(first + 3), time: time + 4,
      surfaceOp: { op: 'replace', startSeq: system.seq, endSeq: system.seq }, sourceEventSeqs: [system.seq],
      data: { turn: 2, step: 1, message: createSystemMessage('Updated full-history fixture prompt.', 'full-history-fixture') },
    },
    { type: 'request/header', seq: SessionSeq(first + 4), time: time + 5,
      data: { reason: 'resume', header: { config: header.data.header.config } },
    },
    { type: 'step/end', seq: SessionSeq(first + 5), time: time + 6, data: { turn: 2, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(first + 6), time: time + 7,
      data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    },
  ]
  return renderSeedFixture(seed.headerLine, [...seed.events, ...extra])
}

async function selectCollapsedPreference(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Compact', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Collapsed steps', exact: true }).click()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
}

async function waitForTools(page: Page): Promise<void> {
  await page.locator('[data-trajectory-scroll] table[data-scroll-ready="true"]').waitFor({ timeout: 30_000 })
  await expect.poll(() => page.locator('[data-trajectory-scroll] tr[aria-label^="TOOL,"]').count(), {
    timeout: 30_000,
  }).toBe(2)
}

describe('web e2e: full Trajectory detail after collapsed history', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const raw = await readFile(SEED, 'utf8')
    await seedSession(scaffold, withResumedHeader(realizeSeedFixture(scaffold, raw, SESSION_ID)), SESSION_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 30_000 })
    await selectCollapsedPreference(page)
    await page.getByRole('button', { name: 'Search sessions', exact: true }).click()
    await page.getByRole('textbox', { name: 'Search sessions...', exact: true }).fill('Use the read tool twice')
    const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
    await results.first().waitFor({ timeout: 30_000 })
    expect(await results.count()).toBe(1)
    await results.click()
    await page.locator('[data-collapsed-turn="1"]').waitFor({ timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  it('retrieves omitted tools through the real server without expanding Chat first', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-trajectory-full-detail'))
    expect(await page.locator('[data-chat-call-id]').count()).toBe(0)
    expect(await page.locator('[data-collapsed-turn="1"] button[aria-expanded]').getAttribute('aria-expanded')).toBe('false')

    await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
    await waitForTools(page)
    expect(await page.locator('[data-trajectory-scroll] tr[aria-label*="compaction"]').count()).toBe(0)
    const calls = await page.locator('[data-trajectory-scroll] tr[aria-label^="TOOL,"]').allTextContents()
    expect(calls.join('\n')).toContain('a.txt')
    expect(calls.join('\n')).toContain('b.txt')
    await compareOrRefreshGolden(
      join(SNAPSHOT_DIR, 'trajectory.expected.md'),
      await captureStableAria(page, '[data-trajectory-scroll]', scaffold.workspaceCwd),
      MODE,
    )
  }, 60_000)

  it('restores full detail after a page reload with Trajectory selected', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-trajectory-full-detail-reload'))
    await page.reload({ waitUntil: 'load' })
    await waitForTools(page)
    expect(await page.locator('[data-trajectory-scroll] tr[aria-label*="compaction"]').count()).toBe(0)
  }, 60_000)

  it('returns to collapsed Chat with the complete tool data retained', async () => {
    await page.getByRole('tab', { name: 'Chat', exact: true }).click()
    const collapsed = page.locator('[data-collapsed-turn="1"] button[aria-expanded]')
    await collapsed.waitFor({ timeout: 15_000 })
    await collapsed.click()
    await expect.poll(() => page.locator('[data-chat-call-id]').count(), { timeout: 15_000 }).toBe(2)
    expect(await page.getByText('DONE', { exact: true }).count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['trajectory.expected.md'])
  }, 30_000)
})

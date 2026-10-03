// An authored steered turn exercises collapsed history pages, independent
// response disclosures, and reload through the assembled Web server without
// model requests.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionHistoryRecord } from '@deepseek-ai/dsh-api-session-controller'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/steered-replies', import.meta.url))
const SEED = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const COLLAPSED_EXPECTED = join(SNAPSHOT_DIR, 'collapsed.expected.md')
const FIRST_EXPANDED_EXPECTED = join(SNAPSHOT_DIR, 'first-expanded.expected.md')
const SEED_ID = 'steered-replies-web-e2e'

const PROMPT = 'Inspect the fixture workspace and report what the two probe files contain.'
const STEER = 'Steer: now count the lines instead and reply with the total.'
const FIRST_ANSWER = 'FIRST_ANSWER: probe-a.txt holds alpha and probe-b.txt holds beta.'
const SECOND_ANSWER = 'SECOND_ANSWER: the two probe files hold 2 lines in total.'

/**
 * The seed's single backend turn has six steps. Each response is two
 * tool-only model requests, which render no assistant row, followed by one
 * answer step; step 4 claims the steer, so the second response starts there.
 * Step N records `100N` input and `10N` output tokens.
 */
const HIDDEN_STEPS = [1, 2, 4, 5]
const FIRST_GROUP = '1:1'
const SECOND_GROUP = '1:4'
const callId = (step: number): string => `call_steered_${String(step)}`

const FIRST_GROUP_FIGURES = ['2 steps', '2 calls', '330 tokens (300 in / 30 out)']
const SECOND_GROUP_FIGURES = ['2 steps', '2 calls', '990 tokens (900 in / 90 out)']

const COLLAPSED_FLOW = [
  'user', `collapsed:${FIRST_GROUP}`, 'assistant-step',
  'steering', `collapsed:${SECOND_GROUP}`, 'assistant-step',
  'turn-tail',
]
const FIRST_EXPANDED_FLOW = [
  'user', `collapsed:${FIRST_GROUP}`, `tool-call:${callId(1)}`, `tool-call:${callId(2)}`, 'assistant-step',
  'steering', `collapsed:${SECOND_GROUP}`, 'assistant-step',
  'turn-tail',
]
const SECOND_EXPANDED_FLOW = [
  'user', `collapsed:${FIRST_GROUP}`, 'assistant-step',
  'steering', `collapsed:${SECOND_GROUP}`, `tool-call:${callId(4)}`, `tool-call:${callId(5)}`, 'assistant-step',
  'turn-tail',
]

/**
 * The rendered flow, top to bottom: `collapsed:<group>` for a disclosure row,
 * otherwise the node kind, suffixed by the call id for tool rows. The
 * compact-mode process control renders nothing here and is omitted.
 * @param page - the page under test.
 * @returns one label per rendered row.
 */
function flowLabels(page: Page): Promise<string[]> {
  return page.locator('[data-chat-flow-kind], [data-collapsed-group]').evaluateAll(rows => rows.flatMap((row) => {
    const element = row as HTMLElement
    const group = element.dataset.collapsedGroup
    if (group !== undefined) return [`collapsed:${group}`]
    const kind = String(element.dataset.chatFlowKind)
    if (kind === 'turn-process') return []
    const call = element.querySelector<HTMLElement>('[data-chat-call-id]')?.dataset.chatCallId
    return [call === undefined ? kind : `${kind}:${call}`]
  }))
}

/** The built-in figures one disclosure reports, excluding its locale-formatted duration. */
async function figures(group: Locator): Promise<string[]> {
  const texts = await group.locator('button [class*="metric"]:not([class*="metrics"])').allTextContents()
  return texts.filter(text => /steps|calls|tokens/.test(text))
}

describe.skipIf(MODE === 'record')('web e2e: steered replies stay visible and collapse per human input', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let firstGroup: Locator
  let secondGroup: Locator

  async function expectCollapsedState(): Promise<void> {
    await expect.poll(() => page.getByText(SECOND_ANSWER, { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => flowLabels(page), { timeout: 10_000 }).toEqual(COLLAPSED_FLOW)
    await expect.poll(() => figures(firstGroup), { timeout: 10_000 }).toEqual(FIRST_GROUP_FIGURES)
    expect(await figures(secondGroup)).toEqual(SECOND_GROUP_FIGURES)
    expect(await firstGroup.getAttribute('data-collapsed-turn')).toBe('1')
    expect(await secondGroup.getAttribute('data-collapsed-turn')).toBe('1')
    expect(await firstGroup.locator('button').getAttribute('aria-expanded')).toBe('false')
    expect(await secondGroup.locator('button').getAttribute('aria-expanded')).toBe('false')
    expect(await page.getByText(PROMPT, { exact: true }).count()).toBe(1)
    expect(await page.getByText(FIRST_ANSWER, { exact: true }).count()).toBe(1)
    expect(await page.getByText(STEER, { exact: true }).count()).toBe(1)
    expect(await page.locator('[data-chat-call-id]').count()).toBe(0)
  }

  async function stableSnapshot(): Promise<string> {
    return (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
  }

  beforeAll(async () => {
    const seed = await readFile(SEED, 'utf8')
    expect(fixtureUserPrompts(seed)).toEqual([PROMPT, STEER])
    scaffold = await launchWebScaffold({})
    await scaffold.ctx.settings.mutate('ui-chat', [{ op: 'set', path: ['transcriptView'], value: 'collapsed' }])
    await seedSession(scaffold, seed, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    firstGroup = page.locator(`[data-collapsed-group="${FIRST_GROUP}"]`)
    secondGroup = page.locator(`[data-collapsed-group="${SECOND_GROUP}"]`)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  it('serves a collapsed page that keeps the answer before the steer whole', async () => {
    const address = { kind: 'session', sessionId: SessionId(SEED_ID) } as const
    const signal = AbortSignal.timeout(10_000)
    const throughSeq = parseSessionLog(await readFile(SEED, 'utf8')).length - 1
    const steps = (records: readonly SessionHistoryRecord[], type: string): number[] => records
      .filter(record => record.event.type === type).map(record => (record.event.data as { step: number }).step)
    const collapsed = await scaffold.ctx.sessionController.page({ address, throughSeq, stepDetail: 'collapsed' }, signal)
    expect(steps(collapsed.records, 'assistant/message')).toEqual([3, 6])
    expect(collapsed.records.filter(record => record.event.type === 'user/message')).toHaveLength(2)
    expect(collapsed.records.filter(record => record.event.type.startsWith('tool/'))).toHaveLength(0)
    expect(collapsed.digests?.map(({ turn, step, steps, calls }) => ({ turn, step, steps, calls })))
      .toEqual(HIDDEN_STEPS.map(step => ({ turn: 1, step, steps: 1, calls: 1 })))
    // Expansion is addressed by backend turn and returns exactly the withheld interiors.
    const expanded = await scaffold.ctx.sessionController.expandSteps({ address, throughSeq, turn: 1 }, signal)
    expect(steps(expanded.records, 'assistant/message')).toEqual(HIDDEN_STEPS)
    expect(expanded.records.filter(record => record.event.type === 'user/message')).toHaveLength(0)
  })

  it('renders one closed disclosure per human input with the first answer between them', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-steered-replies'))
    // The sidebar collapses workspace groups by default: open the group, then its session.
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expectCollapsedState()
    await compareOrRefreshGolden(COLLAPSED_EXPECTED, await stableSnapshot(), MODE)
  }, 60_000)

  it('expands each group alone, in place, without changing either figure', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-steered-replies-expand'))
    const firstButton = firstGroup.locator('button')
    const secondButton = secondGroup.locator('button')
    await firstButton.click()
    await expect.poll(() => firstButton.getAttribute('aria-expanded'), { timeout: 10_000 }).toBe('true')
    // Expansion loads the whole backend turn; only the opened group reveals rows.
    await expect.poll(() => flowLabels(page), { timeout: 15_000 }).toEqual(FIRST_EXPANDED_FLOW)
    expect(await secondButton.getAttribute('aria-expanded')).toBe('false')
    await expect.poll(() => figures(firstGroup), { timeout: 10_000 }).toEqual(FIRST_GROUP_FIGURES)
    expect(await figures(secondGroup)).toEqual(SECOND_GROUP_FIGURES)
    await compareOrRefreshGolden(FIRST_EXPANDED_EXPECTED, await stableSnapshot(), MODE)

    await firstButton.click()
    await expect.poll(() => flowLabels(page), { timeout: 10_000 }).toEqual(COLLAPSED_FLOW)
    await secondButton.click()
    await expect.poll(() => flowLabels(page), { timeout: 15_000 }).toEqual(SECOND_EXPANDED_FLOW)
    expect(await firstButton.getAttribute('aria-expanded')).toBe('false')
    expect(await figures(firstGroup)).toEqual(FIRST_GROUP_FIGURES)
    expect(await figures(secondGroup)).toEqual(SECOND_GROUP_FIGURES)
    await secondButton.click()
    await expect.poll(() => flowLabels(page), { timeout: 10_000 }).toEqual(COLLAPSED_FLOW)
  }, 90_000)

  it('rebuilds the same rows, figures, and marker positions after a reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-steered-replies-reload'))
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expectCollapsedState()
    await compareOrRefreshGolden(COLLAPSED_EXPECTED, await stableSnapshot(), MODE)
  }, 90_000)

  it('issued no model calls and stayed clean', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'collapsed.expected.md', 'first-expanded.expected.md', 'session.v3.jsonl',
    ])
  })
})

/**
 * The local thread copy keeps a complete copy current while its thread is closed:
 * a turn the Host appends while no follow is open reaches the copy through the
 * background refresh, so the thread shows it from the copy while offline.
 */
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const GROWN = createChatScrollFixture({ markerPrefix: 'GROWN', title: 'GROWN refreshed session', turns: 6 })
const OTHER = createChatScrollFixture({ markerPrefix: 'OTHER', title: 'OTHER refreshed session', turns: 6 })
const LATE_PROMPT = 'REFRESH_LATE_PROMPT asked while the thread was closed'
const LATE_ANSWER = 'REFRESH_LATE_ANSWER written while the thread was closed'

/** The thread's record in this tab's IndexedDB copy, or undefined before one exists. */
function copyRecord(page: Page, sessionId: SessionId): Promise<{ readonly head?: number; readonly state?: string } | undefined> {
  return page.evaluate((id: string) => new Promise<{ readonly head?: number; readonly state?: string } | undefined>((resolve) => {
    const request = indexedDB.open('dsh-local-copy')
    request.onerror = () => { resolve(undefined) }
    request.onsuccess = () => {
      const db = request.result
      const read = db.transaction('threads', 'readonly').objectStore('threads').get(id)
      read.onsuccess = () => { db.close(); resolve(read.result as { head?: number; state?: string } | undefined) }
      read.onerror = () => { db.close(); resolve(undefined) }
    }
  }), sessionId)
}

async function openBySearch(page: Page, marker: string, assistantMarker: string): Promise<void> {
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  await page.getByRole('textbox', { name: 'Search session names', exact: true }).fill(marker)
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
  await results.click()
  await page.getByText(assistantMarker, { exact: false }).last().waitFor({ timeout: 30_000 })
}

describe('web e2e: local copy background refresh', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let grownId: SessionId
  /** Follow streams of the grown thread the page holds open. */
  const grownFollows = new Set<string>()
  let grownFollowOpens = 0
  let linesRequests = 0

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    grownId = await seedSession(scaffold, GROWN.log, 'local-copy-refresh-grown')
    await seedSession(scaffold, OTHER.log, 'local-copy-refresh-other')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    // A left thread stops following at once, so only the background refresh can bring its copy forward.
    await page.addInitScript(() => { localStorage.setItem('dsh.localCopy', JSON.stringify({ warmFollowGraceMs: 1 })) })
    await page.routeWebSocket('**/api/remote.mux', (client) => {
      const server = client.connectToServer()
      client.onMessage((message) => {
        if (typeof message === 'string') {
          const frame = JSON.parse(message) as {
            readonly type?: string
            readonly streamId?: string
            readonly endpoint?: string
            readonly payload?: { readonly args?: { readonly request?: { readonly address?: { readonly sessionId?: string } } } }
          }
          if (frame.type === 'open' && frame.endpoint === 'session/follow' && frame.streamId !== undefined
            && frame.payload?.args?.request?.address?.sessionId === grownId) {
            grownFollows.add(frame.streamId)
            grownFollowOpens += 1
          }
          if ((frame.type === 'cancel' || frame.type === 'end') && frame.streamId !== undefined) grownFollows.delete(frame.streamId)
        }
        server.send(message)
      })
      server.onMessage((message) => {
        if (typeof message === 'string') {
          const frame = JSON.parse(message) as { readonly type?: string; readonly streamId?: string }
          if ((frame.type === 'end' || frame.type === 'error') && frame.streamId !== undefined) grownFollows.delete(frame.streamId)
        }
        client.send(message)
      })
    })
    await page.route('**/api/session/lines*', (route) => {
      linesRequests += 1
      void route.continue()
    })
    await page.goto(scaffold.authenticatedUrl)
  })

  afterAll(async () => {
    if (page !== undefined) {
      await saveFailureShot(page, 'local-copy-refresh')
      expect(tripwire.pageErrors).toEqual([])
    }
    await browser?.close()
    await scaffold?.close()
  })

  it('shows a turn appended while the thread was closed from the copy while offline', { retry: 0, timeout: 180_000 }, async () => {
    await openBySearch(page, GROWN.markers.user(1), GROWN.markers.assistant(GROWN.turns))
    await expect.poll(() => copyRecord(page, grownId), { timeout: 60_000 }).toMatchObject({ state: 'complete' })
    await openBySearch(page, OTHER.markers.user(1), OTHER.markers.assistant(OTHER.turns))
    await expect.poll(() => grownFollows.size, { timeout: 30_000 }).toBe(0)
    const head = (await copyRecord(page, grownId))?.head
    const opens = grownFollowOpens
    const lines = linesRequests

    const session = scaffold.ctx.sessions.get(grownId)
    if (session === undefined) throw new Error('the opened thread has no live Session on the Host')
    const turn = GROWN.turns + 1
    const source = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: LATE_PROMPT }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      stream: [], turn, step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: LATE_ANSWER }], source }),
      usage: { inputTokens: 2_100, outputTokens: 40 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(session)
    const hostHead = session.snapshotEvents().at(-1)?.seq
    expect(hostHead).toBeGreaterThan(head ?? Number.MAX_SAFE_INTEGER)

    // The list reports the prompt, the worker fetches the new lines, and no follow of the thread opened meanwhile.
    await expect.poll(() => copyRecord(page, grownId), { timeout: 60_000 }).toMatchObject({ state: 'complete', head: hostHead })
    expect(linesRequests).toBeGreaterThan(lines)
    expect(grownFollowOpens).toBe(opens)

    // One load registers the offline shell and the next fills its cache, as the offline copy case does.
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true })
    })
    await page.reload({ waitUntil: 'load' })
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 10_000 }).toBe(true)
    await page.context().setOffline(true)
    try {
      await page.reload()
      await page.getByText(OTHER.markers.assistant(OTHER.turns), { exact: false }).last().waitFor({ timeout: 30_000 })
      // Titles are not projected offline, so the grown thread is the listed row that is not selected.
      await page.getByRole('treeitem', { selected: false }).filter({ hasNotText: 'Ungrouped' }).first().click()
      await page.getByText(LATE_ANSWER, { exact: false }).last().waitFor({ timeout: 30_000 })
      await page.getByText('Offline. Showing the saved copy', { exact: false }).waitFor({ timeout: 10_000 })
    } finally {
      await page.context().setOffline(false)
    }
  })
})

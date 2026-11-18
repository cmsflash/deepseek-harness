/** Running state shown while the Host is unreachable, over a real WebSocket and real HTTP failures. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Page, type WebSocketRoute } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const REPLAY = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v3.jsonl', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const TITLE = 'Unreachable Host session'
const ANSWER_END = 'event-driven architectures.'
const UNKNOWN_NOTICE = 'Offline. Whether this is still running is unknown until the page reconnects.'
/** Replay pacing that keeps the Turn running through one outage and the 5-second probe that ends it. */
const PACE_MS = 300
const STEP_TIMEOUT_MS = 30_000

/** The page's link to the Host: every socket and `/api` request passes through it. */
class HostLink {
  /** While true the Host is unreachable: sockets close and requests fail. */
  down = false
  /** Assistant stream items the page received. */
  streamed = 0
  /** Thread-list requests that failed in transit. */
  listFailures = 0
  /** Thread-list requests the Host answered after the first failure. */
  listAnswersAfterFailure = 0
  private failNextList = false
  private readonly sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []

  async install(page: Page): Promise<void> {
    await page.routeWebSocket('**/api/remote.mux', (client) => {
      if (this.down) {
        void client.close({ code: 1006, reason: 'test Host unreachable' })
        return
      }
      const server = client.connectToServer()
      this.sockets.push({ client, server })
      client.onMessage((message) => { server.send(message) })
      server.onMessage((message) => {
        const frame = JSON.parse(String(message)) as { type?: string; value?: { type?: string } }
        if (frame.type === 'item' && frame.value?.type === 'assistant-stream') this.streamed++
        client.send(message)
      })
    })
    await page.route('**/api/**', async (route) => {
      if (this.down) {
        await route.abort('internetdisconnected')
        return
      }
      if (new URL(route.request().url()).pathname.endsWith('/session/list')) {
        if (this.failNextList) {
          this.failNextList = false
          this.listFailures++
          await route.abort('connectionreset')
          return
        }
        if (this.listFailures > 0) this.listAnswersAfterFailure++
      }
      await route.continue()
    })
  }

  /** Close every open socket; frames in flight are lost. */
  dropSockets(): void {
    for (const pair of this.sockets.splice(0)) {
      void pair.client.close({ code: 1006, reason: 'test connection loss' }).catch(() => undefined)
      void pair.server.close({ code: 1001, reason: 'test connection loss' }).catch(() => undefined)
    }
  }

  /** Fail the next thread-list request in transit while the Host stays reachable. */
  failOneList(): void {
    this.failNextList = true
  }
}

/** Open a seeded thread and submit a prompt whose paced reply is still streaming on return. */
async function openRunningTurn() {
  const scaffold = await launchWebScaffold({ replayFixture: REPLAY, compareReplaySession: false, paceMs: PACE_MS })
  onTestFinished(() => scaffold.close())
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  const sessionId = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'offline-running-state')
  await workspace.attachSession(sessionId)
  await scaffold.ctx.sessionController.rename({ sessionId, title: TITLE })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-offline-running-state'))
  const link = new HostLink()
  await link.install(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('treeitem').filter({ has: page.getByText(TITLE, { exact: true }) }).click({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Send message', exact: true }).waitFor()
  const settled = scaffold.whenTurnSettled(120_000)
  void settled.catch(() => undefined)
  const input = page.locator('[data-composer-input]').first()
  await input.fill('Describe event sourcing in one sentence.')
  await input.press('Enter')
  const stop = page.getByRole('button', { name: 'Stop generating', exact: true })
  await stop.waitFor({ timeout: STEP_TIMEOUT_MS })
  await expect.poll(() => link.streamed, { timeout: STEP_TIMEOUT_MS }).toBeGreaterThanOrEqual(6)
  return { page, link, stop, settled, tripwire }
}

it('shows no running state while the Host is unreachable and restores it on return', async () => {
  const { page, link, stop, settled, tripwire } = await openRunningTurn()
  const unknown = page.locator('[data-chat-running][data-unknown]')

  link.down = true
  link.dropSockets()
  await unknown.waitFor({ timeout: STEP_TIMEOUT_MS })
  expect(await unknown.textContent()).toBe(UNKNOWN_NOTICE)
  await page.getByText('Offline. Showing the saved copy', { exact: false }).waitFor()
  expect(await stop.count()).toBe(0)

  // The Turn is still running on the Host; the page learns that from the Host's own listing.
  link.down = false
  await stop.waitFor({ timeout: STEP_TIMEOUT_MS })
  expect(await unknown.count()).toBe(0)

  await settled
  await page.getByText(ANSWER_END, { exact: false }).first().waitFor({ timeout: STEP_TIMEOUT_MS })
  await stop.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS })
  expect(await page.locator('[data-chat-running]').count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
})

it('keeps the running state when a thread-list request fails while the Host still answers', async () => {
  const { page, link, stop, settled, tripwire } = await openRunningTurn()
  await page.evaluate(() => {
    const seen = { stopMissing: false }
    Object.assign(window, { __offlineRunningState: seen })
    setInterval(() => {
      if (document.querySelector('button[aria-label="Stop generating"]') === null) seen.stopMissing = true
    }, 25)
  })

  // The reconnect asks for the thread list again; its recorded answer says the thread is idle.
  link.failOneList()
  link.dropSockets()
  await expect.poll(() => link.listFailures, { timeout: STEP_TIMEOUT_MS }).toBe(1)
  await expect.poll(() => link.listAnswersAfterFailure, { timeout: STEP_TIMEOUT_MS }).toBeGreaterThan(0)
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
  }))
  expect(await stop.count()).toBe(1)
  expect(await page.evaluate(() => (
    window as unknown as { __offlineRunningState: { stopMissing: boolean } }
  ).__offlineRunningState.stopMissing)).toBe(false)
  expect(await page.locator('[data-chat-running][data-unknown]').count()).toBe(0)

  await settled
  await page.getByText(ANSWER_END, { exact: false }).first().waitFor({ timeout: STEP_TIMEOUT_MS })
  expect(tripwire.pageErrors).toEqual([])
})

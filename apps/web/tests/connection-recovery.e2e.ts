/** Real WebSocket loss without replacing Client plugins or navigating the page. */
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { chromium, type WebSocketRoute } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

it.each([false, true])('retains the mounted application across WebSocket recovery with an active Session: %s', async (activeSession) => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  onTestFinished(() => scaffold.close())
  const title = 'Connection recovery session'
  const draft = 'Unsent draft retained across connection recovery'
  if (activeSession) {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const seed = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
    const sessionId = await seedSession(scaffold, await readFile(seed, 'utf8'), 'connection-recovery-session')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title })
  }
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-connection-recovery'))
  const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
  let readyFrames = 0
  let sessionBaselines = 0
  // Every `session/control` opening with the checkpoints it named; a recovery
  // must add exactly one, so live projections keep arriving on the new socket.
  const controlOpens: { readonly known: readonly unknown[] | null }[] = []
  let controlBaselines = 0
  await page.routeWebSocket('**/api/remote.mux', (client) => {
    const server = client.connectToServer()
    sockets.push({ client, server })
    const endpoints = new Map<string, string>()
    client.onMessage((message) => {
      if (typeof message === 'string') {
        const frame = JSON.parse(message) as {
          type?: string
          streamId: string
          endpoint: string
          payload?: { args?: { request?: { known?: readonly unknown[] } } }
        }
        if (frame.type === 'open') {
          endpoints.set(frame.streamId, frame.endpoint)
          if (frame.endpoint === 'session/control') controlOpens.push({ known: frame.payload?.args?.request?.known ?? null })
        }
      }
      server.send(message)
    })
    server.onMessage((message) => {
      if (typeof message === 'string') {
        const frame = JSON.parse(message) as { type?: string; streamId: string; value?: { type?: string } }
        if (frame.type === 'item' && frame.value?.type === 'ready') readyFrames++
        if (frame.type === 'item' && endpoints.get(frame.streamId) === 'session/control' && frame.value?.type === 'baseline') controlBaselines++
        if (frame.type === 'item' && endpoints.get(frame.streamId) === 'session/follow'
          && (frame.value?.type === 'snapshot' || frame.value?.type === 'resumed')) sessionBaselines++
      }
      client.send(message)
    })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const composer = page.locator('[data-composer-input][contenteditable="true"]')
  if (activeSession) {
    await page.getByRole('treeitem').filter({ has: page.getByText(title, { exact: true }) }).click({ timeout: 20_000 })
    await writeComposerDraft(page, composer, draft)
    await expect.poll(() => sessionBaselines).toBeGreaterThan(0)
  } else {
    await page.getByText('Into the Unknown', { exact: true }).waitFor({ timeout: 20_000 })
  }
  await expect.poll(() => readyFrames).toBeGreaterThan(0)
  const root = await page.locator('[data-slot="root"]').elementHandle()
  expect(root).not.toBeNull()
  let navigations = 0
  page.on('framenavigated', () => { navigations++ })
  /**
   * Wait until every control opening has delivered its baseline, after which
   * the stream holds an accepted generation and opens nothing more on its own.
   * @param expected - control openings the recovery should have made in total.
   */
  const settleControl = async (expected: number): Promise<void> => {
    await expect.poll(() => controlOpens.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(expected)
    await expect.poll(() => controlBaselines, { timeout: 20_000 }).toBe(controlOpens.length)
    expect(controlOpens.length).toBe(expected)
  }
  await settleControl(1)

  for (let attempt = 0; attempt < 3; attempt++) {
    const previousReady = readyFrames
    const previousBaseline = sessionBaselines
    const previousControls = controlOpens.length
    const active = sockets.at(-1)!
    await Promise.all([
      active.client.close({ code: 1012, reason: 'test connection loss' }),
      active.server.close({ code: 1012, reason: 'test connection loss' }),
    ])
    await expect.poll(() => readyFrames, { timeout: 20_000 }).toBeGreaterThan(previousReady)
    if (activeSession) {
      await expect.poll(() => sessionBaselines, { timeout: 20_000 }).toBeGreaterThan(previousBaseline)
    }
    await settleControl(previousControls + 1)
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    }))
    expect(await root!.evaluate(element => element.isConnected)).toBe(true)
    expect(console.pageErrors).toEqual([])
    if (activeSession) expect(await composer.textContent()).toBe(draft)
  }

  // An offline episode answers the control opening from the offline record, so
  // the socket sees no opening until the Host is reachable again. An empty record
  // holds the replayed opening without a baseline until then, so it ends as a
  // carrier failure before the stream accepted it; the stream must still reopen
  // on the live Host.
  const beforeOffline = controlOpens.length
  const baselinesBeforeOffline = controlBaselines
  await expect.poll(() => page.evaluate(async () => {
    // Opening the database by name would create it empty when absent.
    if (!(await indexedDB.databases()).some(database => database.name === 'dsh-offline-replay')) return 0
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('dsh-offline-replay')
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(new Error('offline replay database open failed')) }
    })
    try {
      const records = db.transaction('records', 'readwrite').objectStore('records')
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = records.getAllKeys()
        request.onsuccess = () => { resolve(request.result) }
        request.onerror = () => { reject(new Error('offline replay keys read failed')) }
      })
      const control = keys.filter(key => typeof key === 'string' && key.startsWith('stream session/control '))
      for (const key of control) records.put([], key)
      return control.length
    } finally {
      db.close()
    }
  }), { timeout: 10_000 }).toBeGreaterThan(0)
  const offlinePill = page.getByText('Offline', { exact: true })
  await page.context().setOffline(true)
  try {
    await offlinePill.waitFor({ timeout: 20_000 })
    if (activeSession) {
      await page.getByText('Offline. Showing the saved copy', { exact: false }).waitFor({ timeout: 10_000 })
    }
    expect(controlOpens.length).toBe(beforeOffline)
  } finally {
    await page.context().setOffline(false)
  }
  await offlinePill.waitFor({ state: 'detached', timeout: 20_000 })
  await expect.poll(() => controlBaselines, { timeout: 20_000 }).toBeGreaterThan(baselinesBeforeOffline)
  expect(controlOpens.length).toBeGreaterThan(beforeOffline)
  expect(await root!.evaluate(element => element.isConnected)).toBe(true)
  expect(console.pageErrors).toEqual([])
  if (activeSession) expect(await composer.textContent()).toBe(draft)

  expect(navigations).toBe(0)
  // The opening names the checkpoints the Client holds, so a reconnect sends a
  // baseline of what changed instead of the whole projection state.
  expect(controlOpens.every(entry => entry.known !== null)).toBe(true)
  if (!activeSession) expect(await page.getByText('Into the Unknown', { exact: true }).isVisible()).toBe(true)
})

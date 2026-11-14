/**
 * The local thread copy, end to end: a thread opens from its verified IndexedDB
 * copy, its history reads never reach the Host, and an offline reload keeps
 * rendering the thread from the copy. Each case opens its own browser context,
 * so it downloads its own copy and depends on no other case.
 */
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

/** One follow request the page sent, as the copy contract shapes it. */
interface FollowRequest {
  readonly lines?: boolean
  readonly resume?: { readonly afterSeq: number; readonly link: string }
}

/** One follow opening the page received. */
interface FollowOpening {
  readonly type?: string
  readonly records?: readonly unknown[]
}

const FIXTURE = createChatScrollFixture({ markerPrefix: 'COPY', title: 'COPY local session' })
const SWITCH_FIXTURE = createChatScrollFixture({ markerPrefix: 'SWITCH', title: 'SWITCH local session' })
const GOAL_FIXTURE = goalFixture(260)

/**
 * A long thread whose later turns open without a human message, as goal continuations do, so
 * each of those turns starts with its process control, a row positioned between event seqs.
 * @param turns - closed turns to generate; enough of them need more than one history page.
 * @returns the JSONL log and the markers of its first prompt and last answer.
 */
function goalFixture(turns: number): { readonly log: string; readonly firstPrompt: string; readonly lastAnswer: string } {
  const session = Session.create(SessionId('local-copy-goal-template'))
  const source = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const firstPrompt = 'GOAL_FIRST_PROMPT keep working on the goal'
  const answer = (turn: number): string => `GOAL_ANSWER_${String(turn).padStart(3, '0')} progress recorded.`
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      const prompt = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: firstPrompt }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('session/title', { title: 'GOAL local session', messageSeqs: [prompt.seq], source: { kind: 'fallback' } })
    }
    session.append('request/header', { header: { config: source }, reason: turn === 1 ? 'initial' : 'change' })
    const callId = ToolCallId(`goal-${String(turn)}`)
    const args = JSON.stringify({ command: `echo ${String(turn)}`, description: `step ${String(turn)}` })
    session.append('assistant/message', {
      stream: [], turn, step: 1,
      message: createAssistantMessage({ content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: args }], source }),
      usage: { inputTokens: 1_000, outputTokens: 50 },
    }, { surfaceOp: 'append' })
    const call = session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: args })
    session.append('tool/result', {
      turn, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: String(turn) }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    session.append('step/end', { turn, step: 1 })
    session.append('step/start', { turn, step: 2 })
    session.append('assistant/message', {
      stream: [], turn, step: 2,
      message: createAssistantMessage({ content: [{ type: 'text', text: answer(turn) }], source }),
      usage: { inputTokens: 1_100, outputTokens: 60 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 2 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const log = [
    JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: Date.now() - 60_000,
      cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)),
    '',
  ].join('\n')
  return { log, firstPrompt, lastAnswer: answer(turns) }
}

/** Long enough that its opening window leaves several older pages to load. */
const LONG_FIXTURE = createChatScrollFixture({ markerPrefix: 'LONG', title: 'LONG local session', turns: 600 })
/** Opened only by the offline-totals case, so the Host loads it after that page's control stream opened. */
const LATE_FIXTURE = createChatScrollFixture({ markerPrefix: 'LATE', title: 'LATE local session', turns: 200 })
/** The offline notice's sentence for a window opened from a partial copy. */
const INCOMPLETE_COPY = 'The saved copy of this thread is incomplete.'
/** Scrollport geometry for the anchor checks. */
interface ScrollState {
  readonly top: number
  readonly height: number
  readonly client: number
}

/** What the collapsed transcript shows: each step-group disclosure with its figures, and the session totals pill. */
interface CollapsedView {
  readonly groups: readonly { readonly group: string; readonly text: string }[]
  readonly activity: string | null
}

function collapsedView(page: Page): Promise<CollapsedView> {
  return page.evaluate(() => ({
    groups: [...document.querySelectorAll<HTMLElement>('[data-collapsed-group]')].map(row => ({
      group: row.dataset.collapsedGroup ?? '',
      text: row.querySelector('button')?.textContent ?? '',
    })),
    activity: document.querySelector('[data-composer-stat="activity"]')?.textContent ?? null,
  }))
}

/** Read scrollport geometry for the anchor checks. */
function readScrollState(port: { evaluate<T>(run: (element: HTMLElement) => T): Promise<T> }): Promise<ScrollState> {
  return port.evaluate((element) => {
    const scroller = element as HTMLElement & { scrollHeight: number; clientHeight: number }
    return { top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight }
  })
}

/** The thread's record in this tab's IndexedDB copy, or undefined before one exists. */
function copyState(page: Page, sessionId: SessionId): Promise<unknown> {
  return page.evaluate((id: string) => {
    const open = (database: string): Promise<IDBDatabase> => new Promise((resolve, reject) => {
      const request = indexedDB.open(database)
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(new Error('indexedDB open failed')) }
    })
    return open('dsh-local-copy').then((db: IDBDatabase) => {
      const value = new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction('threads', 'readonly')
        const read = tx.objectStore('threads').get(id)
        read.onsuccess = () => { resolve(read.result) }
        read.onerror = () => { reject(new Error('threads read failed')) }
      })
      return value.finally(() => { db.close() })
    }).catch(() => undefined)
  }, sessionId)
}

async function openSession(page: Page, marker: string, assistantMarker: string): Promise<void> {
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  await page.getByRole('textbox', { name: 'Search session names', exact: true }).fill(marker)
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
  await results.click()
  await page.getByText(assistantMarker, { exact: false }).last().waitFor({ timeout: 30_000 })
}

/** One case's page in its own browser context, so its IndexedDB copy, records and init scripts belong to that case. */
interface CopyPage {
  readonly page: Page
  readonly tripwire: ReturnType<typeof watchConsole>
  readonly memoryLines: string[]
  readonly followRequests: FollowRequest[]
  readonly openings: FollowOpening[]
  readonly counts: { history: number; lines: number }
  readonly close: () => Promise<void>
}

/**
 * Open the scaffold in a fresh browser context that records follow traffic, history and lines requests, and budget lines.
 * @param scaffold - running Web scaffold.
 * @param browser - browser owning the new context.
 * @param name - failure screenshot name.
 * @param init - init scripts installed before the first navigation.
 * @returns the loaded page and its collectors.
 */
async function openCopyPage(
  scaffold: WebScaffold,
  browser: Browser,
  name: string,
  init?: (page: Page) => Promise<void>,
): Promise<CopyPage> {
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  const memoryLines: string[] = []
  const followRequests: FollowRequest[] = []
  const openings: FollowOpening[] = []
  const counts = { history: 0, lines: 0 }
  onTestFailed(async () => { await saveFailureShot(page, `local-copy-${name}`) })
  page.on('console', (message) => {
    if (message.text().startsWith('[local-copy] memory')) memoryLines.push(message.text())
  })
  await page.routeWebSocket('**/api/remote.mux', (client) => {
    const server = client.connectToServer()
    const follows = new Set<string>()
    client.onMessage((message) => {
      if (typeof message === 'string') {
        const frame = JSON.parse(message) as {
          readonly type?: string
          readonly streamId?: string
          readonly endpoint?: string
          readonly payload?: { readonly args?: { readonly request?: FollowRequest } }
        }
        if (frame.type === 'open' && frame.endpoint === 'session/follow') {
          if (frame.streamId !== undefined) follows.add(frame.streamId)
          const journalRequest = frame.payload?.args?.request
          followRequests.push({
            ...(typeof journalRequest?.lines === 'boolean' ? { lines: journalRequest.lines } : {}),
            ...(journalRequest?.resume === undefined ? {} : { resume: journalRequest.resume }),
          })
        }
      }
      server.send(message)
    })
    server.onMessage((message) => {
      if (typeof message === 'string') {
        const frame = JSON.parse(message) as {
          readonly type?: string
          readonly streamId?: string
          readonly value?: { readonly records?: readonly unknown[]; readonly type?: string }
        }
        const opening = frame.type === 'item' && frame.streamId !== undefined && follows.has(frame.streamId)
          ? frame.value
          : undefined
        if (opening?.type === 'snapshot' || opening?.type === 'resumed') {
          openings.push({
            type: opening.type,
            ...(opening.records === undefined ? {} : { records: opening.records }),
          })
        }
      }
      client.send(message)
    })
  })
  // Routes match newest first, so the broader pattern registers first and the
  // specific lines counter still sees what it names.
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (['session/page', 'session/events', 'session/expandSteps'].some(endpoint => path.endsWith(endpoint))) counts.history += 1
    void route.continue()
  })
  await page.route('**/api/session/lines*', (route) => {
    counts.lines += 1
    void route.continue()
  })
  await init?.(page)
  await page.goto(scaffold.authenticatedUrl)
  return {
    page, tripwire, memoryLines, followRequests, openings, counts,
    close: async () => {
      const errors = [...tripwire.pageErrors]
      await page.context().close()
      expect(errors).toEqual([])
    },
  }
}

/** Distance in pixels between the scrollport's bottom edge and its content's end. */
async function aboveFloor(page: Page): Promise<number> {
  const state = await readScrollState(page.locator('[data-conversation-scroll]'))
  return state.height - state.client - state.top
}

/** Longer than Chat's 500 ms reader sample interval, so a scroll position still for this long has been sampled. */
const READER_SAMPLED_MS = 600

/**
 * Wait until the scrollport stops moving for longer than Chat's reader sample
 * interval; Chat then holds the position it would restore.
 * @param page - page showing an opened thread.
 * @returns the settled scroll top.
 */
async function settledScrollTop(page: Page): Promise<number> {
  let last: number | undefined
  await expect.poll(async () => {
    const { top } = await readScrollState(page.locator('[data-conversation-scroll]'))
    const still = top === last
    last = top
    return still
  }, { timeout: 15_000, interval: READER_SAMPLED_MS }).toBe(true)
  return last!
}

/**
 * Wheel up until the reader is above the floor and Chat has sampled it there.
 * @param page - page showing an opened thread.
 * @param distance - minimum distance from the floor.
 * @returns the settled scroll top.
 */
async function parkAboveFloor(page: Page, distance: number): Promise<number> {
  const box = await page.locator('[data-conversation-scroll]').boundingBox()
  if (box === null) throw new Error('conversation scrollport has no layout box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await expect.poll(async () => {
    if (await aboveFloor(page) <= distance) await page.mouse.wheel(0, -900)
    return await aboveFloor(page)
  }, { timeout: 10_000 }).toBeGreaterThan(distance)
  const top = await settledScrollTop(page)
  expect(await page.locator('[data-chat-following-tail]').count()).toBe(0)
  await page.getByRole('button', { name: 'Back to bottom' }).waitFor({ timeout: 10_000 })
  return top
}

describe('web e2e: local thread copy', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let sessionId: SessionId
  let longSessionId: SessionId
  let lateSessionId: SessionId

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await scaffold.ctx.settings.mutate('ui-chat', [{ op: 'set', path: ['transcriptView'], value: 'collapsed' }])
    sessionId = await seedSession(scaffold, FIXTURE.log, 'local-copy-e2e')
    await seedSession(scaffold, SWITCH_FIXTURE.log, 'local-copy-e2e-switch')
    await seedSession(scaffold, GOAL_FIXTURE.log, 'local-copy-e2e-goal')
    longSessionId = await seedSession(scaffold, LONG_FIXTURE.log, 'local-copy-e2e-long')
    lateSessionId = await seedSession(scaffold, LATE_FIXTURE.log, 'local-copy-e2e-late')
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('downloads the thread and opens it again without Host history traffic', { retry: 0 }, async () => {
    const { page, followRequests, openings, counts, close } = await openCopyPage(scaffold, browser, 'download')
    onTestFailed(() => { console.error('steps before failure', counts) })
    try {
      await openSession(page, FIXTURE.markers.user(1), FIXTURE.markers.assistant(FIXTURE.turns))
      // This first opening has no copy yet, so the Host serves its collapsed window.
      await expect.poll(async () => (await collapsedView(page)).groups.length, { timeout: 30_000 }).toBeGreaterThan(0)
      await expect.poll(async () => (await collapsedView(page)).activity, { timeout: 30_000 }).not.toBeNull()
      const hostView = await collapsedView(page)
      // The copy reaches the complete state in this context's IndexedDB.
      await expect.poll(() => copyState(page, sessionId), { timeout: 60_000 }).toMatchObject({ state: 'complete' })
      expect(counts.lines).toBeGreaterThan(0)

      const history = counts.history
      const lines = counts.lines
      followRequests.length = 0
      openings.length = 0
      await page.reload()
      await openSession(page, FIXTURE.markers.user(1), FIXTURE.markers.assistant(FIXTURE.turns))
      expect(followRequests.some(request => request.lines === true && request.resume?.afterSeq !== undefined)).toBe(true)
      const resumedEmpty = openings.find(opening => opening.type === 'resumed' && (opening.records?.length ?? 0) === 0)
      expect(resumedEmpty).toBeDefined()
      expect(counts.history).toBe(history)
      expect(counts.lines).toBe(lines)

      // The copy-opened window shows the same step groups, figures and totals as the Host-opened one.
      await expect.poll(() => collapsedView(page), { timeout: 15_000 }).toEqual(hostView)
      expect(await page.locator('[data-chat-call-id]').count()).toBe(0)
      await page.locator('[data-collapsed-group]').last().locator('button').click()
      await expect.poll(() => page.locator('[data-chat-call-id]').count(), { timeout: 10_000 }).toBe(2)
      expect(counts.history).toBe(history)
    } finally {
      await close()
    }
  })

  it('loads a collapsed thread whose turns open with process controls to its first message', { retry: 0 }, async () => {
    const { page, close } = await openCopyPage(scaffold, browser, 'goal')
    try {
      await openSession(page, GOAL_FIXTURE.firstPrompt, GOAL_FIXTURE.lastAnswer)
      const scrollport = page.locator('[data-conversation-scroll]')
      const loadEarlier = page.getByRole('button', { name: 'Load earlier', exact: true })
      const firstRow = (): Promise<string | null> => page.locator('[data-chat-flow-key]').first().getAttribute('data-chat-flow-key')
      await loadEarlier.waitFor({ timeout: 10_000 })
      for (let pages = 0; pages < 20 && await page.getByText(GOAL_FIXTURE.firstPrompt, { exact: true }).count() === 0; pages++) {
        await scrollport.evaluate((host) => { host.scrollTop = 0 })
        if (await loadEarlier.count() === 0) continue
        const head = await firstRow()
        await loadEarlier.click()
        await expect.poll(firstRow, { timeout: 15_000 }).not.toBe(head)
      }
      await page.getByText(GOAL_FIXTURE.firstPrompt, { exact: true }).waitFor({ timeout: 10_000 })
      // Reader movement reports the visible rows, process controls included, to the Session at most once a second.
      const box = await scrollport.boundingBox()
      if (box === null) throw new Error('conversation scrollport has no layout box')
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      let top = await settledScrollTop(page)
      for (let tick = 0; tick < 6; tick += 1) {
        await page.mouse.wheel(0, 1_500)
        await expect.poll(async () => (await readScrollState(scrollport)).top, { timeout: 10_000 }).not.toBe(top)
        top = await settledScrollTop(page)
      }
      expect(await page.locator('[data-chat-anchor-key]').count()).toBeGreaterThan(0)
    } finally {
      await close()
    }
  })

  it('keeps the scroll anchor across a switch away and back with animation frames suspended', { retry: 0 }, async () => {
    // Hidden browser tabs never run requestAnimationFrame; this case replays that environment.
    const { page, close } = await openCopyPage(scaffold, browser, 'anchor-no-frames', async (page) => {
      await page.addInitScript(() => {
        const frames: ((time: number) => void)[] = []
        window.requestAnimationFrame = (callback: (time: number) => void): number => {
          frames.push(callback)
          return frames.length
        }
        window.cancelAnimationFrame = (handle: number): void => {
          frames[handle - 1] = () => {}
        }
      })
    })
    try {
      await openSession(page, SWITCH_FIXTURE.markers.user(1), SWITCH_FIXTURE.markers.assistant(SWITCH_FIXTURE.turns))
      await openSession(page, FIXTURE.markers.user(1), FIXTURE.markers.assistant(FIXTURE.turns))
      const before = await parkAboveFloor(page, 120)
      expect(before).toBeGreaterThan(0)

      await openSession(page, SWITCH_FIXTURE.markers.user(1), SWITCH_FIXTURE.markers.assistant(SWITCH_FIXTURE.turns))
      await openSession(page, FIXTURE.markers.user(1), FIXTURE.markers.assistant(FIXTURE.turns))
      const after = await settledScrollTop(page)
      expect(Math.abs(after - before)).toBeLessThan(200)
      expect(await aboveFloor(page)).toBeGreaterThan(120)
    } finally {
      await close()
    }
  })

  it('keeps the scroll anchor across a switch away and back', { retry: 0 }, async () => {
    const { page, close } = await openCopyPage(scaffold, browser, 'anchor')
    try {
      await openSession(page, SWITCH_FIXTURE.markers.user(1), SWITCH_FIXTURE.markers.assistant(SWITCH_FIXTURE.turns))
      await openSession(page, FIXTURE.markers.user(1), FIXTURE.markers.assistant(FIXTURE.turns))
      const before = await parkAboveFloor(page, 600)
      expect(before).toBeGreaterThan(0)

      // Switch away and back: the warm-revived Session keeps the anchor.
      await openSession(page, SWITCH_FIXTURE.markers.user(1), SWITCH_FIXTURE.markers.assistant(SWITCH_FIXTURE.turns))
      await openSession(page, FIXTURE.markers.user(1), FIXTURE.markers.assistant(FIXTURE.turns))
      const after = await settledScrollTop(page)
      // The semantic anchor survives the switch within one viewport height; the rAF-starved case pins it closely.
      expect(Math.abs(after - before)).toBeLessThan(924)
      if (await aboveFloor(page) < 120) {
        expect(await page.getByRole('button', { name: 'Back to bottom' }).count()).toBe(0)
      }
    } finally {
      await close()
    }
  })

  it('loads a thread to its first message under a memory budget it exceeds', { retry: 0, timeout: 300_000 }, async () => {
    const { page, memoryLines, close } = await openCopyPage(scaffold, browser, 'budget')
    try {
      await openSession(page, LONG_FIXTURE.markers.user(1), LONG_FIXTURE.markers.assistant(LONG_FIXTURE.turns))
      await expect.poll(() => copyState(page, longSessionId), { timeout: 120_000 }).toMatchObject({ state: 'complete' })
      await page.evaluate(() => { localStorage.setItem('dsh.localCopy', JSON.stringify({ memoryBudgetBytes: 1 })) })
      await page.reload()
      await openSession(page, LONG_FIXTURE.markers.user(1), LONG_FIXTURE.markers.assistant(LONG_FIXTURE.turns))
      const loadEarlier = page.getByRole('button', { name: 'Load earlier', exact: true })
      const rows = (): Promise<number> => page.locator('[data-chat-flow-key]').count()
      const firstRow = (): Promise<string | null> => page.locator('[data-chat-flow-key]').first().getAttribute('data-chat-flow-key')
      /** Click "Load earlier" without scrolling, so the reader stays at the newest turn and every loaded page lies before the viewport. */
      const clickLoadEarlier = async (): Promise<void> => {
        const head = await firstRow()
        await loadEarlier.evaluate((button) => { (button as HTMLButtonElement).click() })
        await expect.poll(firstRow, { timeout: 15_000 }).not.toBe(head)
      }
      await loadEarlier.waitFor({ timeout: 15_000 })
      const opened = await rows()
      let clicks = 0
      while (clicks < 20 && await loadEarlier.count() > 0) {
        await clickLoadEarlier()
        clicks += 1
      }
      expect(clicks).toBeGreaterThan(1)
      expect(await loadEarlier.count()).toBe(0)
      expect(await rows()).toBeGreaterThan(opened)
      expect(await page.getByText(LONG_FIXTURE.markers.user(1), { exact: false }).count()).toBeGreaterThan(0)

      // Once the loads' protection ends, the budget trims them, and loading earlier reads the trimmed pages again.
      memoryLines.length = 0
      await expect.poll(() => memoryLines.length, { timeout: 60_000 }).toBeGreaterThan(0)
      await loadEarlier.waitFor({ timeout: 10_000 })
      expect(await rows()).toBeLessThan(opened + 1)
      await clickLoadEarlier()
    } finally {
      await close()
    }
  })

  it('renders the thread from the copy while offline', { retry: 0 }, async () => {
    // The other cases run without the offline shell so request interception stays
    // visible; the offline shell needs a browser that does not report WebDriver.
    const { page, close } = await openCopyPage(scaffold, browser, 'offline', async (page) => {
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true })
      })
    })
    try {
      await openSession(page, FIXTURE.markers.user(1), FIXTURE.markers.assistant(FIXTURE.turns))
      await expect.poll(() => copyState(page, sessionId), { timeout: 60_000 }).toMatchObject({ state: 'complete' })
      // One load registers the offline shell, the next loads through it, which is
      // what fills its network-first cache for the offline navigation below.
      await page.evaluate(async () => { await navigator.serviceWorker.ready })
      await page.reload({ waitUntil: 'load' })
      await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 10_000 }).toBe(true)
      await page.getByText(FIXTURE.markers.assistant(FIXTURE.turns), { exact: false }).last().waitFor({ timeout: 30_000 })
      await page.context().setOffline(true)
      // The reload restores the open thread. Sidebar search is a Host content search, so it cannot find it offline.
      await page.reload()
      await page.getByText(FIXTURE.markers.assistant(FIXTURE.turns), { exact: false }).last().waitFor({ timeout: 30_000 })
      await page.getByText('Offline. Showing the saved copy', { exact: false }).waitFor({ timeout: 10_000 })
      expect(await page.getByText('Failed to load history', { exact: false }).count()).toBe(0)
      expect(await page.getByText(INCOMPLETE_COPY, { exact: true }).count()).toBe(0)
    } finally {
      await close()
    }
  })

  it('says the saved copy is incomplete when a partial copy opens offline', { retry: 0, timeout: 180_000 }, async () => {
    const { page, close } = await openCopyPage(scaffold, browser, 'offline-partial', async (page) => {
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true })
        // One smallest chunk per load, then a pause longer than the case, keeps the copy partial.
        localStorage.setItem('dsh.localCopy', JSON.stringify({ scope: 'opened', chunkBytes: 65_536, minPauseMs: 600_000 }))
      })
    })
    try {
      await openSession(page, LONG_FIXTURE.markers.user(1), LONG_FIXTURE.markers.assistant(LONG_FIXTURE.turns))
      const storedHead = async (): Promise<number> => {
        const copy = await copyState(page, longSessionId) as { readonly head?: number } | undefined
        return copy?.head ?? -1
      }
      await expect.poll(storedHead, { timeout: 60_000 }).toBeGreaterThanOrEqual(0)
      await page.evaluate(async () => { await navigator.serviceWorker.ready })
      await page.reload({ waitUntil: 'load' })
      await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 10_000 }).toBe(true)
      await page.getByText(LONG_FIXTURE.markers.assistant(LONG_FIXTURE.turns), { exact: false }).last().waitFor({ timeout: 30_000 })
      const copy = await copyState(page, longSessionId) as { readonly head: number; readonly complete: boolean }
      expect(copy.head).toBeGreaterThanOrEqual(0)
      expect(copy.complete).toBe(false)
      await page.context().setOffline(true)
      await page.reload()
      await page.getByText(INCOMPLETE_COPY, { exact: true }).waitFor({ timeout: 30_000 })
      await page.getByText('Offline. Showing the saved copy', { exact: false }).waitFor({ timeout: 10_000 })
      await page.getByText(/CHAT_SCROLL_LONG_ASSISTANT_/).first().waitFor({ timeout: 10_000 })
      expect(await page.getByText(LONG_FIXTURE.markers.assistant(LONG_FIXTURE.turns), { exact: false }).count()).toBe(0)
      expect(await page.getByText('Failed to load history', { exact: false }).count()).toBe(0)
    } finally {
      await close()
    }
  })

  it('keeps the totals of a thread the Host loaded after the control stream opened when reloaded offline', { retry: 0, timeout: 180_000 }, async () => {
    const { page, close } = await openCopyPage(scaffold, browser, 'offline-totals', async (page) => {
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true })
      })
    })
    const activity = (): Promise<string | null> => page.evaluate(() => document.querySelector('[data-composer-stat="activity"]')?.textContent ?? null)
    try {
      await openSession(page, FIXTURE.markers.user(1), FIXTURE.markers.assistant(FIXTURE.turns))
      await page.evaluate(async () => { await navigator.serviceWorker.ready })
      await page.reload({ waitUntil: 'load' })
      await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 10_000 }).toBe(true)
      await page.getByText(FIXTURE.markers.assistant(FIXTURE.turns), { exact: false }).last().waitFor({ timeout: 30_000 })
      await openSession(page, LATE_FIXTURE.markers.user(1), LATE_FIXTURE.markers.assistant(LATE_FIXTURE.turns))
      await expect.poll(() => copyState(page, lateSessionId), { timeout: 120_000 }).toMatchObject({ state: 'complete' })
      await expect.poll(activity, { timeout: 15_000 }).toContain(`${String(LATE_FIXTURE.turns)} turns`)
      const online = await activity()
      // The recorded control stream persists after a one-second delay.
      await page.waitForTimeout(1_500)
      await page.context().setOffline(true)
      await page.reload()
      await page.getByText(LATE_FIXTURE.markers.assistant(LATE_FIXTURE.turns), { exact: false }).last().waitFor({ timeout: 30_000 })
      await page.getByText('Offline. Showing the saved copy', { exact: false }).waitFor({ timeout: 10_000 })
      await expect.poll(activity, { timeout: 10_000 }).toBe(online)
    } finally {
      await close()
    }
  })
})

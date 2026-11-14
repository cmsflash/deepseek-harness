/** A reconnecting Session follow continues the window the browser holds instead of resending a snapshot. */
import { chromium, type Browser, type Page, type WebSocketRoute } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLogChain } from '@deepseek-ai/dsh-session-persistence'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

/** A Session log chain link as the wire carries it. */
const LINK = /^[0-9a-f]{64}$/

/** One followed record on the wire: a decoded event, or its stored line when the local copy asks follow for lines. */
interface WireRecord {
  readonly event?: { readonly seq: number; readonly type: string } | undefined
  readonly seq?: number | undefined
  readonly line?: string | undefined
  readonly link?: string | undefined
}

/** One followed record's durable seq and event type, from its event or its stored line. */
function recordSeqType(record: WireRecord): { readonly seq: number; readonly type: string | undefined } | undefined {
  if (record.event !== undefined) return { seq: record.event.seq, type: record.event.type }
  if (record.seq === undefined || record.line === undefined) return undefined
  const stored = JSON.parse(record.line) as { readonly type?: string }
  return { seq: record.seq, type: stored.type }
}

interface FollowOpening {
  readonly resume?: { readonly afterSeq: number; readonly link: string }
  type?: string | undefined
  records?: readonly WireRecord[] | undefined
  bytes?: number
}

interface MuxSocket {
  readonly client: WebSocketRoute
  readonly server: WebSocketRoute
  /** Drop every Host frame, as a connection that silently stopped delivering would. */
  hold: boolean
  dropped: number
}

const FIXTURE = createChatScrollFixture({ markerPrefix: 'RESUME', title: 'RESUME follow session' })

async function openSession(page: Page): Promise<void> {
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  await page.getByRole('textbox', { name: 'Search session names', exact: true }).fill(FIXTURE.markers.user(1))
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
  await results.click()
  await page.getByText(FIXTURE.markers.assistant(FIXTURE.turns), { exact: false }).last().waitFor({ timeout: 30_000 })
}

/** Scroll the transcript to its start as a reader would, then let it paint. */
async function showHistoryStart(page: Page): Promise<void> {
  await page.locator('[data-conversation-scroll]').evaluate(async (host) => {
    host.scrollTop = 0
    await new Promise<void>(resolve => requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }))
  })
}

describe('web e2e: resumable Session follow', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let sessionId: SessionId
  const sockets: MuxSocket[] = []
  const openings: FollowOpening[] = []
  let olderPages = 0

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    sessionId = await seedSession(scaffold, FIXTURE.log, 'session-follow-resume-e2e')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.routeWebSocket('**/api/remote.mux', (client) => {
      const server = client.connectToServer()
      const socket: MuxSocket = { client, server, hold: false, dropped: 0 }
      sockets.push(socket)
      const follows = new Map<string, FollowOpening>()
      client.onMessage((message) => {
        if (typeof message === 'string') {
          const frame = JSON.parse(message) as {
            readonly type?: string
            readonly streamId?: string
            readonly endpoint?: string
            readonly payload?: {
              readonly args?: {
                readonly request?: {
                  readonly resume?: { readonly afterSeq: number; readonly link: string }
                }
              }
            }
          }
          if (frame.type === 'open' && frame.endpoint === 'session/follow' && frame.streamId !== undefined) {
            const resume = frame.payload?.args?.request?.resume
            const opening: FollowOpening = resume === undefined ? {} : { resume }
            follows.set(frame.streamId, opening)
            openings.push(opening)
          }
        }
        server.send(message)
      })
      server.onMessage((message) => {
        if (socket.hold) {
          socket.dropped++
          return
        }
        if (typeof message === 'string') {
          const frame = JSON.parse(message) as {
            readonly type?: string
            readonly streamId?: string
            readonly value?: { readonly type?: string; readonly records?: readonly WireRecord[] }
          }
          const opening = frame.streamId === undefined ? undefined : follows.get(frame.streamId)
          if (frame.type === 'item' && opening !== undefined && opening.type === undefined) {
            opening.type = frame.value?.type
            opening.records = frame.value?.records
            opening.bytes = message.length
          }
        }
        client.send(message)
      })
    })
    page.on('request', (request) => {
      if (request.url().endsWith('/api/session/page')) olderPages++
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('carries only the events written while disconnected and keeps the pages loaded by scrolling up', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-follow-resume'))
    await openSession(page)
    const initial = openings.at(-1)
    expect(initial).toMatchObject({ type: 'snapshot' })
    expect(initial?.resume).toBeUndefined()
    for (const record of initial?.records ?? []) expect(record.link).toMatch(LINK)

    const loadEarlier = page.getByRole('button', { name: 'Load earlier', exact: true })
    for (let pages = 0; pages < 8; pages++) {
      await showHistoryStart(page)
      if (await loadEarlier.count() === 0) break
      const before = olderPages
      await loadEarlier.click()
      await expect.poll(() => olderPages).toBeGreaterThan(before)
      await expect.poll(() => page.getByRole('button', { name: 'Loading…', exact: true }).count()).toBe(0)
    }
    await showHistoryStart(page)
    await page.getByText(FIXTURE.markers.user(1), { exact: false }).first().waitFor({ state: 'attached', timeout: 30_000 })
    const pagesBeforeReconnect = olderPages
    expect(pagesBeforeReconnect).toBeGreaterThan(0)

    // The Host appends a durable event the browser never receives, then the connection drops.
    const active = sockets.at(-1)!
    active.hold = true
    const openingsBefore = openings.length
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'RESUME renamed while disconnected' })
    await expect.poll(() => active.dropped).toBeGreaterThan(0)
    await Promise.all([
      active.client.close({ code: 1012, reason: 'test connection loss' }),
      active.server.close({ code: 1012, reason: 'test connection loss' }),
    ])

    await expect.poll(() => openings.slice(openingsBefore).some(opening => opening.type !== undefined), { timeout: 20_000 }).toBe(true)
    const reconnect = openings.slice(openingsBefore).find(opening => opening.type !== undefined)!
    expect(reconnect.type).toBe('resumed')
    const records = reconnect.records ?? []
    const first = records[0] === undefined ? undefined : recordSeqType(records[0])
    const last = records.length === 0 ? undefined : recordSeqType(records.at(-1)!)
    expect(first?.seq).toBe((reconnect.resume?.afterSeq ?? Number.NaN) + 1)
    expect(last?.type).toBe('session/title')
    expect(records.length).toBeLessThan(initial?.records?.length ?? 0)
    expect(reconnect.bytes).toBeLessThan(initial?.bytes ?? 0)

    const resume = reconnect.resume!
    expect(resume.link).toMatch(LINK)
    await scaffold.ctx.sessionPersistence.flush()
    const handle = await scaffold.ctx.sessionPersistence.open(sessionId, 'read')
    let chain: SessionLogChain | undefined
    try {
      chain = (await handle.read()).chain
    } finally {
      await handle.close()
    }
    expect(chain?.linkAt(resume.afterSeq)).toBe(resume.link)
    for (const record of records) expect(record.link).toMatch(LINK)
    expect(records.at(-1)?.link).toBe(last !== undefined ? chain?.linkAt(last.seq) : undefined)

    await showHistoryStart(page)
    await page.getByText(FIXTURE.markers.user(1), { exact: false }).first().waitFor({ state: 'attached', timeout: 10_000 })
    await page.getByText(FIXTURE.markers.assistant(FIXTURE.turns), { exact: false }).last().waitFor({ state: 'attached' })
    expect(await loadEarlier.count()).toBe(0)
    expect(olderPages).toBe(pagesBeforeReconnect)
    expect(tripwire.pageErrors).toEqual([])
  }, 180_000)
})

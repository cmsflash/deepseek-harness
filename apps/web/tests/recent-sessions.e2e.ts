// Switching back to a recently left Session reuses its loaded history: the browser opens no second history stream.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot, WEB_FIXTURE_TIME } from './support.ts'

/** Build one closed session titled `title` whose reply repeats the title. */
function titledFixture(title: string): string {
  const session = Session.create(SessionId('recent-sessions-source'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Say ${title}.` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title, messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `${title} reply` }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const header = {
    type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
    cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
  }
  return [JSON.stringify(header), ...session.snapshotEvents().map(event => JSON.stringify({ ...event, time: WEB_FIXTURE_TIME + event.seq * 1_000 })), ''].join('\n')
}

describe('web e2e: recently left Sessions', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const follows = new Map<string, number>()

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, titledFixture('Alpha thread'), 'recent-sessions-alpha', undefined,
      { createdAt: WEB_FIXTURE_TIME - 120_000 })
    await seedSession(scaffold, titledFixture('Beta thread'), 'recent-sessions-beta', undefined,
      { createdAt: WEB_FIXTURE_TIME - 60_000 })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.routeWebSocket('**/api/remote.mux', (socket) => {
      const server = socket.connectToServer()
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message)) as {
          readonly type: string
          readonly endpoint?: string
          readonly payload?: { readonly args?: { readonly request?: { readonly address?: { readonly sessionId?: string } } } }
        }
        const sessionId = frame.payload?.args?.request?.address?.sessionId
        if (frame.type === 'open' && frame.endpoint === 'session/follow' && sessionId !== undefined) {
          follows.set(sessionId, (follows.get(sessionId) ?? 0) + 1)
        }
        server.send(message)
      })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens each Session once across switching away and back', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-recent-sessions'))
    // Seeded Sessions list newest first under the collapsed Ungrouped section.
    const rows = { 'Alpha thread': 2, 'Beta thread': 1 }
    const open = async (title: keyof typeof rows): Promise<void> => {
      await page.getByRole('treeitem').nth(rows[title]).click()
      await page.getByText(`${title} reply`, { exact: true }).last().waitFor()
    }

    await page.getByRole('treeitem', { name: /Ungrouped/ }).click()
    await open('Alpha thread')
    await open('Beta thread')
    await open('Alpha thread')
    await open('Beta thread')

    expect(follows.get('recent-sessions-alpha')).toBe(1)
    expect(follows.get('recent-sessions-beta')).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})

/** Offline application shell (`apps/web/public/sw.js`) under the shipped Web profile. */
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

it('opens the plugin event stream from a page the offline shell controls', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-offline-shell-event-stream'))

  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.reload({ waitUntil: 'load' })
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)

  const state = await page.evaluate(() => new Promise<string>((resolve) => {
    const source = new EventSource(new URL('plugins/events', document.baseURI))
    const timer = setTimeout(() => { source.close(); resolve('still connecting') }, 5_000)
    source.addEventListener('open', () => {
      clearTimeout(timer)
      source.close()
      resolve('open')
    })
  }))
  expect(state).toBe('open')
})

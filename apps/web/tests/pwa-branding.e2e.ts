/** Deployment branding in the shipped Web composition: one SVG replaces every declared icon; the names reach the manifest and iOS. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

/** A green field with a white centre block, so every render can be sampled at both. */
const BRAND_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
  + '<rect width="64" height="64" fill="#0a8f5a"/><rect x="20" y="20" width="24" height="24" fill="#ffffff"/></svg>'

function expectColor(actual: readonly number[], expected: readonly number[], what: string): void {
  for (const [channel, value] of expected.entries()) expect(Math.abs(actual[channel]! - value), what).toBeLessThanOrEqual(2)
}

it('brands every declared icon and the installed app names from one deployment SVG', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pwa-branding-'))
  try {
    const icon = join(home, 'brand.svg')
    await writeFile(icon, BRAND_SVG)
    const overlay = join(home, 'branding.overlay.yml')
    await writeFile(overlay, [
      '- id: web-runtime',
      '  config:',
      `    icon: '${icon}'`,
      "    appName: 'DSH VM'",
      "    appShortName: 'VM'",
      '',
    ].join('\n'))
    const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    try {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({ locale: 'en-US' })
        const consoleWatch = watchConsole(page)
        await page.goto(scaffold.authenticatedUrl)
        const declared = await page.evaluate(async () => {
          const manifestHref = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href
          if (manifestHref === undefined) throw new Error('the page links no manifest')
          const manifest = await (await fetch(manifestHref)).json() as { name: string; short_name: string; icons: { src: string }[] }
          return {
            titles: [...document.querySelectorAll<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]')].map(meta => meta.content),
            name: manifest.name,
            shortName: manifest.short_name,
            icons: [...new Set([
              ...[...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel~="apple-touch-icon"]')].map(link => link.href),
              ...manifest.icons.map(entry => new URL(entry.src, manifestHref).href),
            ])],
          }
        })
        expect({ titles: declared.titles, name: declared.name, shortName: declared.shortName })
          .toEqual({ titles: ['VM'], name: 'DSH VM', shortName: 'VM' })
        const paths = declared.icons.map(href => new URL(href).pathname).sort()
        expect(paths).toEqual([
          '/apple-touch-icon.png', '/favicon-dark.svg', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png',
        ])
        for (const href of declared.icons) {
          const path = new URL(href).pathname
          const response = await page.request.get(href)
          expect(response.status(), path).toBe(200)
          const body = await response.body()
          if (path.endsWith('.svg')) {
            expect(response.headers()['content-type'], path).toBe('image/svg+xml')
            expect(body.toString('utf8'), path).toBe(BRAND_SVG)
            continue
          }
          expect(response.headers()['content-type'], path).toBe('image/png')
          const shipped = await sharp(join(DIST_ROOT, path)).metadata()
          const { data, info } = await sharp(body).removeAlpha().raw().toBuffer({ resolveWithObject: true })
          expect([info.width, info.height], path).toEqual([shipped.width, shipped.height])
          const rgb = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)]
          expectColor(rgb(2, 2), [0x0a, 0x8f, 0x5a], `${path} edge`)
          expectColor(rgb(info.width / 2, info.height / 2), [255, 255, 255], `${path} centre`)
        }
        expect(consoleWatch.pageErrors).toEqual([])
      } finally {
        await browser.close()
      }
    } finally {
      await scaffold.close()
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

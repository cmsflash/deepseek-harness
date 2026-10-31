/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver and frontend-static rows, and every
 * assertion observes the served HTTP surface — asset serving, explicit index
 * entry points with index taps, 404 misses, traversal rejection, 405 on non-
 * GET/HEAD, deployment branding, and seat release on fiber disposal (HMR safety).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as FrontendStatic from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Changes to the default dist fixture and frontend row. */
interface Fixture {
  /** Body of `dist/index.html`. */
  readonly index?: string
  /** Files written relative to the fixture root, overriding the defaults; `dist/` holds the dist. */
  readonly files?: Readonly<Record<string, string | Uint8Array>>
  /** Extra frontend config lines; `{root}` names the fixture root. */
  readonly config?: readonly string[]
}

/** Write a dist fixture and the authenticated Web rows, then boot them through the real Loader. */
async function loadComposition(fixture: Fixture = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-frontend-static-'))
  const dist = join(root, 'dist')
  await mkdir(dist)
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, fixture.index ?? '<head></head><body>shell</body>')
  await writeFile(join(dist, 'app.js'), 'export {}')
  await writeFile(join(dist, 'preview.html'), '<body>preview</body>')
  await writeFile(join(dist, 'blob.bin'), 'BLOB')
  await writeFile(join(dist, 'manifest.webmanifest'), '{}')
  await writeFile(join(dist, 'icon-192.png'), 'PNG')
  await mkdir(join(dist, 'empty'))
  for (const [path, body] of Object.entries(fixture.files ?? {})) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), body)
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: '${join(root, '.credentials.yaml')}'`,
    '    watch: false',
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-client-connection'",
    '- id: frontend',
    "  name: '@deepseek-ai/dsh-host-frontend-static'",
    '  config:',
    `    distIndex: '${distIndex}'`,
    ...(fixture.config ?? []).map(line => `    ${line.replaceAll('{root}', root!)}`),
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', LocalCredentials],
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** GET (by default) one path against the running server; returns status, content-type, and the body. */
async function request(
  port: number | undefined,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; type: string | null; body: string }> {
  if (port === undefined) throw new Error('frontend-static test: the listener has not bound a port')
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    body: await response.text(),
  }
}

describe('real Loader composition', () => {
  it('serves explicit index entries and files while preserving HTTP error semantics', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const server = loaded.webServer
    const port = server.port
    const launchUrl = loaded.connection.authenticatedUrl(`http://127.0.0.1:${String(port)}`)

    // A browser that cannot receive the tokenized URL — a home-screen PWA
    // with its own cookie jar — lands on the sign-in page, whose form
    // submits the pasted token through the same root exchange.
    const signIn = await request(port, '/')
    expect(signIn.status).toBe(401)
    expect(signIn.type).toBe('text/html; charset=utf-8')
    expect(signIn.body).toContain('<form method="GET" action="./">')
    expect(signIn.body).toContain('name="token"')
    expect(signIn.body).not.toContain('role="alert"')
    expect((await request(port, '/?token=wrong')).body).toContain('role="alert"')

    const exchange = await fetch(launchUrl, { redirect: 'manual' })
    expect(exchange.status).toBe(303)
    expect(exchange.headers.get('location')).toBe('./')
    const setCookie = exchange.headers.get('set-cookie')
    if (setCookie === null) throw new Error('authenticated frontend did not set a cookie')
    const cookie = setCookie.split(';', 1)[0]!
    const authenticated = (init?: RequestInit): RequestInit => {
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      return { ...init, headers }
    }

    // Real assets with their MIME types; a live rebuild is served on the next read.
    expect(await request(port, '/app.js')).toMatchObject({ status: 200, type: 'text/javascript; charset=utf-8', body: 'export {}' })
    expect(await request(port, '/manifest.webmanifest')).toMatchObject({
      status: 200,
      type: 'application/manifest+json',
      body: '{}',
    })
    // The install icons are images; a launcher must not receive them as octet-stream.
    expect(await request(port, '/icon-192.png')).toMatchObject({ status: 200, type: 'image/png', body: 'PNG' })
    expect(await request(port, '/app.js', { method: 'HEAD' })).toEqual({
      status: 200,
      type: 'text/javascript; charset=utf-8',
      body: '',
    })
    await writeFile(join(root!, 'dist', 'app.js'), 'export const rebuilt = true')
    expect(await request(port, '/app.js')).toMatchObject({ status: 200, body: 'export const rebuilt = true' })

    // Unknown extension ships as octet-stream.
    expect(await request(port, '/blob.bin')).toMatchObject({ status: 200, type: 'application/octet-stream', body: 'BLOB' })

    // Only the root and index path render index.html through registered taps.
    const untap = server.tapIndex(html => html.replace('<head>', '<head><script>window.__T__=1</script>'))
    // A plugin row stands in for the Host's plugin-resource rows: the base the
    // shell inserts must precede it, not merely exist.
    const renderedFor: Connection.PeerScope[] = []
    const offRows = loaded.on('webserver/index-inject', (rows, peer) => {
      renderedFor.push(peer)
      rows.push({ kind: 'script-preload', src: 'plugins/boot.js' })
    })
    for (const path of ['/', '/index.html', '/?view=test']) {
      const got = await request(port, path, authenticated())
      expect(got.status).toBe(200)
      expect(got.type).toBe('text/html; charset=utf-8')
      expect(got.body).toContain('__T__')
      expect(got.body).toContain('shell')
      // The served document carries the entry-directory base exactly once, and
      // it precedes every injected row and tap markup, so the shell's
      // app-owned routes and the Host's resource rows resolve under one mount.
      expect(got.body.match(/<base\b/g)).toHaveLength(1)
      const base = got.body.indexOf('<base href="./">')
      expect(base).toBeLessThan(got.body.indexOf('<link rel="preload" as="script" href="plugins/boot.js">'))
      expect(base).toBeLessThan(got.body.indexOf('<script>window.__T__=1</script>'))
    }
    // An authenticated browser renders for the owner's shared browser Peer.
    expect(renderedFor).toEqual([loaded.connection.browserPeer, loaded.connection.browserPeer, loaded.connection.browserPeer])
    offRows()
    expect(await request(port, '/', authenticated({ method: 'HEAD' }))).toEqual({
      status: 200,
      type: 'text/html; charset=utf-8',
      body: '',
    })
    untap()
    expect((await request(port, '/', authenticated())).body).not.toContain('__T__')

    // A missing configured index follows the same empty-404 contract for both
    // of its public entry paths and for both supported methods.
    await rm(join(root!, 'dist', 'index.html'))
    for (const path of ['/', '/index.html']) {
      const get = await request(port, path, authenticated())
      const head = await request(port, path, authenticated({ method: 'HEAD' }))
      expect(get).toEqual({ status: 404, type: null, body: '' })
      expect(head).toEqual(get)
    }

    // Ordinary unknown paths and static-resource misses are empty 404s for
    // both GET and HEAD; neither class can be mistaken for the HTML shell.
    const ordinaryMisses = ['/no/such/route', '/empty', '/app.js/child']
    const assetMisses = [
      '/missing.js',
      '/missing.css',
      '/missing.mjs',
      '/missing.js.map',
      '/missing.webmanifest',
      '/missing.manifest',
    ]
    for (const path of [...ordinaryMisses, ...assetMisses]) {
      const get = await request(port, path)
      const head = await request(port, path, { method: 'HEAD' })
      expect(get).toEqual({ status: 404, type: null, body: '' })
      expect(head).toEqual(get)
    }
    expect(await request(port, '/api/no/such/route', authenticated())).toEqual({
      status: 404,
      type: 'text/plain;charset=UTF-8',
      body: 'not found',
    })

    // Traversal outside the dist root is 403, non-GET/HEAD is 405, and a
    // malformed filesystem target still reaches the webserver's 400 guard.
    expect((await request(port, '/..%2f..%2fetc%2fpasswd')).status).toBe(403)
    expect((await request(port, '/app.js', { method: 'POST' })).status).toBe(405)
    expect((await request(port, '/bad%00path')).status).toBe(400)

    // HMR safety: disposing the frontend row releases the fallback seat (the
    // unclaimed webserver answers 404) and the seat is claimable again.
    const frontendEntry = [...loaded.loader.entries()].find(e => e.options.id === 'frontend')
    expect(frontendEntry).toBeDefined()
    await frontendEntry!.fiber?.dispose()
    expect((await request(port, '/no/such/route')).status).toBe(404)
    expect(() => server.registerFallback(() => {})).not.toThrow()
  })

  it('answers in-process reads for the given Peer without browser authentication', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const server = loaded.webServer
    const reader = { principal: { kind: 'owner' } } as Connection.PeerScope
    const read = (path: string, init?: RequestInit) => server.readResource(new Request(`http://reader.invalid${path}`, init), reader)
    const renderedFor: Connection.PeerScope[] = []
    loaded.on('webserver/index-inject', (rows, peer) => {
      renderedFor.push(peer)
      rows.push({ kind: 'global', name: '__READER__', value: peer === reader })
    })

    // The index renders for the reader's Peer with no cookie or token, and
    // keeps the entry-directory base ahead of the injected rows.
    for (const path of ['/', '/index.html']) {
      const index = await read(path)
      expect(index.status).toBe(200)
      expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8')
      const html = await index.text()
      expect(html).toContain('globalThis["__READER__"] = true')
      expect(html.indexOf('<base href="./">')).toBeLessThan(html.indexOf('__READER__'))
      expect(html).toContain('shell')
    }
    expect(renderedFor).toEqual([reader, reader])
    const head = await read('/', { method: 'HEAD' })
    expect({ status: head.status, type: head.headers.get('content-type'), body: await head.text() })
      .toEqual({ status: 200, type: 'text/html; charset=utf-8', body: '' })

    // Assets, misses, traversal, and methods keep the HTTP semantics.
    const asset = await read('/app.js')
    expect({ status: asset.status, type: asset.headers.get('content-type'), body: await asset.text() })
      .toEqual({ status: 200, type: 'text/javascript; charset=utf-8', body: 'export {}' })
    expect((await read('/missing.js')).status).toBe(404)
    expect((await read('/..%2f..%2fetc%2fpasswd')).status).toBe(403)
    expect((await read('/app.js', { method: 'POST', body: 'x' })).status).toBe(405)
    await expect(read('/bad%00path')).rejects.toThrow()
    await rm(join(root!, 'dist', 'index.html'))
    expect((await read('/')).status).toBe(404)
  })

  it('lets browsers revalidate every file except the index', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const base = `http://127.0.0.1:${String(loaded.webServer.port)}`
    const first = await fetch(`${base}/app.js`)
    const etag = first.headers.get('etag')
    if (etag === null) throw new Error('a dist file carried no ETag')
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/)
    expect(first.headers.get('cache-control')).toBe('no-cache')
    expect(await first.text()).toBe('export {}')

    const revalidated = await fetch(`${base}/app.js`, { headers: { 'if-none-match': etag } })
    expect([revalidated.status, revalidated.headers.get('etag'), revalidated.headers.get('cache-control')]).toEqual([304, etag, 'no-cache'])
    expect(await revalidated.text()).toBe('')
    // An in-process read revalidates the same way.
    const reader = { principal: { kind: 'owner' } } as Connection.PeerScope
    const read = await loaded.webServer.readResource(new Request(`${base}/app.js`, { headers: { 'if-none-match': etag } }), reader)
    expect(read.status).toBe(304)

    // New content under the same name changes the ETag, so the stale copy is replaced.
    await writeFile(join(root!, 'dist', 'app.js'), 'export const rebuilt = true')
    const rebuilt = await fetch(`${base}/app.js`, { headers: { 'if-none-match': etag } })
    expect(rebuilt.status).toBe(200)
    expect(rebuilt.headers.get('etag')).not.toBe(etag)
    expect(await rebuilt.text()).toBe('export const rebuilt = true')

    // Only the rendered index carries no cache headers; another HTML file revalidates.
    const html = await fetch(`${base}/preview.html`)
    expect([html.status, html.headers.get('cache-control')]).toEqual([200, 'no-cache'])
    expect(html.headers.get('etag')).toMatch(/^W\//)
    expect(await html.text()).toBe('<body>preview</body>')
    const index = await loaded.webServer.readResource(new Request(`${base}/`), reader)
    expect([index.status, index.headers.get('cache-control'), index.headers.get('etag')]).toEqual([200, null, null])
  })
})

/** A square SVG: a green field with a white centre block, so renders can be sampled. */
const BRAND_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">'
  + '<rect width="16" height="16" fill="#0a8f5a"/><rect x="5" y="5" width="6" height="6" fill="#ffffff"/></svg>'

/** A 1×1 PNG, for an icon file that is not SVG. */
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** An index declaring a home-screen title, both icon link kinds, a manifest, and links branding ignores. */
const BRANDED_INDEX = [
  '<head>',
  '<meta name="apple-mobile-web-app-title" content="DSH">',
  '<link rel="manifest" href="./site.webmanifest">',
  '<link rel="apple-touch-icon" href="./touch.png">',
  '<link rel="icon" type="image/svg+xml" href="/favicon.svg" media="(prefers-color-scheme: light)">',
  '<link rel="stylesheet" href="./app.css">',
  '<link href="./orphan.css">',
  '<link rel="preconnect">',
  '</head><body>shell</body>',
].join('')

/** An opaque white PNG standing in for a committed install icon. */
async function whitePng(edge: number): Promise<Buffer> {
  return sharp({ create: { width: edge, height: edge, channels: 4, background: '#ffffff' } }).png().toBuffer()
}

/** The dist icons {@link BRANDED_INDEX} and its manifest declare, plus the deployment SVG. */
async function brandedFiles(): Promise<Record<string, string | Uint8Array>> {
  return {
    'dist/site.webmanifest': JSON.stringify({
      name: 'DeepSeek Harness',
      short_name: 'DSH',
      display: 'standalone',
      icons: [{ src: 'icons/any.png', sizes: '48x48' }, { src: 'touch.png' }],
    }),
    'dist/touch.png': await whitePng(30),
    'dist/icons/any.png': await whitePng(48),
    'dist/favicon.svg': '<svg id="dist"/>',
    'brand.svg': BRAND_SVG,
  }
}

/** Expect one PNG pixel to be `rgb` within resampling error. */
async function expectPixel(png: Uint8Array, x: number, y: number, rgb: readonly number[]): Promise<void> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const at = (y * info.width + x) * info.channels
  for (const [channel, value] of rgb.entries()) expect(Math.abs(data[at + channel]! - value)).toBeLessThanOrEqual(2)
}

describe('deployment branding', () => {
  it('replaces every declared icon from one SVG and renames the installed app', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition({
      index: BRANDED_INDEX,
      files: await brandedFiles(),
      config: ["icon: '{root}/brand.svg'", "appName: 'DSH VM'", "appShortName: 'VM & \"Lab\"'"],
    })
    const port = loaded.webServer.port
    const base = `http://127.0.0.1:${String(port)}`

    // SVG icons are the configured file itself; PNG icons are renders of it at the dist file's size.
    expect(await request(port, '/favicon.svg')).toEqual({ status: 200, type: 'image/svg+xml', body: BRAND_SVG })
    expect(await request(port, '/favicon.svg', { method: 'HEAD' })).toEqual({ status: 200, type: 'image/svg+xml', body: '' })
    for (const [path, edge] of [['/touch.png', 30], ['/icons/any.png', 48]] as const) {
      const response = await fetch(`${base}${path}`)
      expect([response.status, response.headers.get('content-type')]).toEqual([200, 'image/png'])
      const png = new Uint8Array(await response.arrayBuffer())
      expect(await sharp(png).metadata()).toMatchObject({ format: 'png', width: edge, height: edge })
      await expectPixel(png, 2, 2, [0x0a, 0x8f, 0x5a])
      await expectPixel(png, edge / 2, edge / 2, [255, 255, 255])
      const etag = response.headers.get('etag')
      if (etag === null) throw new Error(`${path} carried no ETag`)
      expect((await fetch(`${base}${path}`, { headers: { 'if-none-match': etag } })).status).toBe(304)
    }

    // Every served manifest carries the names; its other members are the dist's.
    const manifest = await request(port, '/site.webmanifest')
    expect(manifest.type).toBe('application/manifest+json')
    expect(JSON.parse(manifest.body)).toEqual({
      name: 'DSH VM',
      short_name: 'VM & "Lab"',
      display: 'standalone',
      icons: [{ src: 'icons/any.png', sizes: '48x48' }, { src: 'touch.png' }],
    })
    expect(JSON.parse((await request(port, '/manifest.webmanifest')).body)).toEqual({ name: 'DSH VM', short_name: 'VM & "Lab"' })
    expect(await request(port, '/app.js')).toMatchObject({ status: 200, body: 'export {}' })

    // The index declares the short name as its only iOS home-screen title.
    const reader = { principal: { kind: 'owner' } } as Connection.PeerScope
    const html = await (await loaded.webServer.readResource(new Request(`${base}/`), reader)).text()
    expect(html.match(/apple-mobile-web-app-title/g)).toHaveLength(1)
    expect(html).toContain('<head><base href="./"><meta name="apple-mobile-web-app-title" content="VM &amp; &quot;Lab&quot;">')
  })

  it('renames the installed app without an icon, leaving the icons and the index title alone', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition({ index: BRANDED_INDEX, files: await brandedFiles(), config: ["appName: 'Solo'"] })
    const port = loaded.webServer.port
    expect(JSON.parse((await request(port, '/site.webmanifest')).body)).toMatchObject({ name: 'Solo', short_name: 'DSH' })
    expect(await request(port, '/favicon.svg')).toMatchObject({ status: 200, body: '<svg id="dist"/>' })
    expect(await readFile(join(root!, 'dist', 'touch.png'))).toEqual(Buffer.from(await (await fetch(`http://127.0.0.1:${String(port)}/touch.png`)).arrayBuffer()))
    const reader = { principal: { kind: 'owner' } } as Connection.PeerScope
    const html = await (await loaded.webServer.readResource(new Request('http://reader.invalid/'), reader)).text()
    expect(html.match(/apple-mobile-web-app-title/g)).toHaveLength(1)
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="DSH">')
  })

  it('renames only the short name and refuses a manifest that is not a JSON object', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition({
      files: { 'dist/manifest.webmanifest': '[]', 'dist/site.webmanifest': '{"name":"DeepSeek Harness"}' },
      config: ["appShortName: 'VM'"],
    })
    const port = loaded.webServer.port
    expect(JSON.parse((await request(port, '/site.webmanifest')).body)).toEqual({ name: 'DeepSeek Harness', short_name: 'VM' })
    const reader = { principal: { kind: 'owner' } } as Connection.PeerScope
    await expect(loaded.webServer.readResource(new Request('http://reader.invalid/manifest.webmanifest'), reader))
      .rejects.toThrow(/the manifest .*manifest\.webmanifest is not a JSON object/)
  })

  it.each<[string, Fixture, RegExp]>([
    ['a missing SVG', {}, /ENOENT/],
    ['an undecodable SVG', { files: { 'brand.svg': 'not an image' } }, /cannot decode the icon/],
    ['a PNG in place of the SVG', { files: { 'brand.svg': TINY_PNG } }, /is png, not SVG/],
    ['a dist that declares no icon', {
      index: '<head><link rel="manifest" href="./manifest.webmanifest"></head>',
      files: { 'brand.svg': BRAND_SVG },
    }, /declares no icon/],
    ['a manifest that is not a JSON object', {
      index: '<head><link rel="manifest" href="./site.webmanifest"></head>',
      files: { 'brand.svg': BRAND_SVG, 'dist/site.webmanifest': 'null' },
    }, /the manifest \.\/site\.webmanifest is not a JSON object/],
    ['an icon outside the dist', {
      index: '<head><link rel="icon" href="..%2fbrand.svg"></head>',
      files: { 'brand.svg': BRAND_SVG },
    }, /is outside the dist/],
    ['an icon on another origin', {
      index: '<head><link rel="icon" href="https://cdn.example/icon.svg"></head>',
      files: { 'brand.svg': BRAND_SVG },
    }, /is outside the dist/],
    ['an icon that is neither SVG nor PNG', {
      index: '<head><link rel="icon" href="./favicon.ico"></head>',
      files: { 'brand.svg': BRAND_SVG, 'dist/favicon.ico': 'ICO' },
    }, /is neither SVG nor PNG/],
    ['manifest icons without a src', {
      index: '<head><link rel="manifest" href="./site.webmanifest"></head>',
      files: { 'brand.svg': BRAND_SVG, 'dist/site.webmanifest': '{"icons":[{"sizes":"1x1"}]}' },
    }, /declares icons that are not objects with a string src/],
  ])('fails its start for %s and leaves the seat unclaimed', { timeout: 60_000 }, async (_case, fixture, error) => {
    const loaded = await loadComposition({ ...fixture, config: ["icon: '{root}/brand.svg'"] })
    const frontend = [...loaded.loader.entries()].find(entry => entry.options.id === 'frontend')
    expect(frontend?.fiber?.state).toBe(FiberState.FAILED)
    await expect(frontend?.fiber?.await()).rejects.toThrow(error)
    expect((await request(loaded.webServer.port, '/app.js')).status).toBe(404)
  })
})

/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: a webserver resource serving the built frontend directory
 * with explicit index entry points. A readable index renders at the dist root
 * and configured index path; missing paths return 404, traversal outside the
 * dist root is 403, unknown extensions ship as octet-stream, and non-GET/HEAD
 * is 405. An HTTP index request first passes Connection's browser
 * authentication and renders for the browser Peer; an in-process read renders
 * for the Peer its caller admitted. Both renders go through the webserver's
 * index render (structured injection rows, then raw taps). Non-index assets
 * stay public; every file other than the index carries a weak ETag with
 * `cache-control: no-cache` and answers a matching `If-None-Match` with 304,
 * while the index carries no cache headers. The dist location is workspace
 * knowledge of the composing application, so `distIndex` is typically
 * supplied through a `!!js` expression, never hardcoded by a deployment.
 * Optional `icon`, `appName`, and `appShortName` brand one deployment's
 * installed Web app without rebuilding the dist.
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'frontend-static'

/** Services required before the authenticated fallback seat can be claimed. */
export const inject = ['webServer', 'connection']

/** Plugin config: the dist anchor and optional deployment branding. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
  /**
   * Absolute path of a square SVG that replaces every icon the index declares
   * through `icon` and `apple-touch-icon` links and every icon of the Web app
   * manifest it links: SVG icons are served as this file and PNG icons as
   * renders of it at their dist pixel size. The plugin reads and renders it
   * when it starts; an unreadable or undecodable file fails the start.
   */
  icon?: string
  /** Replaces `name` in every served Web app manifest. */
  appName?: string
  /** Replaces `short_name` in every served Web app manifest and the iOS home-screen title of the index. */
  appShortName?: string
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
  icon: z.string(),
  appName: z.string(),
  appShortName: z.string(),
})

const HTML_MIME = 'text/html; charset=utf-8'
const PNG_MIME = 'image/png'
const SVG_MIME = 'image/svg+xml'

const MIME: Record<string, string> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // Launchers require an image Content-Type for the install icons.
  '.png': PNG_MIME,
  '.svg': SVG_MIME,
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  // The packed VFS image. Served as its own bytes, never as a Content-Encoding:
  // the worker inflates the body itself, and a transport-level encoding would
  // leave it inflating an already-decoded archive.
  '.gz': 'application/gzip',
}

const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
])

/** A Response body that is `bytes` itself, without the copy a buffer body gets. */
function bytesBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** Bytes and Content-Type of one served dist file other than the index. */
interface Asset {
  readonly body: Uint8Array<ArrayBuffer>
  readonly type: string
}

/** Replacement manifest names; an absent name keeps the dist value. */
interface ManifestNames {
  readonly name: string | undefined
  readonly shortName: string | undefined
}

/** Base that index and manifest references resolve against: both files sit at the dist root. */
const DIST_BASE = new URL('https://dist.invalid/')

/** Density at which an SVG renders at its own 1:1 scale. */
const SOURCE_DENSITY = 72

/** Samples per output pixel along each axis before reduction, as the committed install icons use. */
const RENDER_SCALE = 4

/** The iOS home-screen title the index declares. */
const HOME_SCREEN_TITLE = /<meta\s[^>]*\bname="apple-mobile-web-app-title"[^>]*>/giu

function isJsonObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIconWithSource(icon: unknown): icon is { src: string } {
  return isJsonObject(icon) && 'src' in icon && typeof icon.src === 'string'
}

/**
 * The `src` of every icon a parsed Web app manifest declares.
 * @throws when the manifest is not a JSON object or declares `icons` that are
 * not objects with a string `src`.
 */
function manifestIconSources(manifest: unknown, href: string): string[] {
  if (!isJsonObject(manifest)) throw new Error(`frontend-static: the manifest ${href} is not a JSON object`)
  const icons = 'icons' in manifest ? manifest.icons : []
  if (Array.isArray(icons) && icons.every(isIconWithSource)) return icons.map(icon => icon.src)
  throw new Error(`frontend-static: the manifest ${href} declares icons that are not objects with a string src`)
}

async function readDistAsset(target: string): Promise<Asset> {
  return { body: await readFile(target), type: MIME[extname(target)] ?? 'application/octet-stream' }
}

/** Escape a value for a double-quoted HTML attribute. */
function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** The `href` of every index `<link>` whose `rel` holds one of `types`. */
function linkHrefs(html: string, types: readonly string[]): string[] {
  const hrefs: string[] = []
  for (const [tag] of html.matchAll(/<link\s[^>]*>/giu)) {
    const [, rel] = /\brel="([^"]*)"/iu.exec(tag) ?? []
    const [, href] = /\bhref="([^"]*)"/iu.exec(tag) ?? []
    if (rel !== undefined && href !== undefined && rel.toLowerCase().split(/\s+/u).some(type => types.includes(type))) hrefs.push(href)
  }
  return hrefs
}

/**
 * Resolve one index or manifest reference to its dist file.
 * @throws when the reference leaves the dist.
 */
function distTarget(distRoot: string, href: string, base: URL): string {
  const url = new URL(href, base)
  const target = resolve(normalize(join(distRoot, decodeURIComponent(url.pathname))))
  if (url.origin !== DIST_BASE.origin || (target !== distRoot && !target.startsWith(distRoot + sep))) {
    throw new Error(`frontend-static: ${href} is outside the dist ${distRoot}`)
  }
  return target
}

/** Render an SVG to PNG at the pixel size of the dist PNG it replaces. */
async function renderIcon(svg: Uint8Array<ArrayBuffer>, svgEdge: number, png: string): Promise<Uint8Array<ArrayBuffer>> {
  const { default: sharp } = await import('sharp')
  const { width, height } = await sharp(png).metadata()
  // A separate raster keeps the SVG's filters at full resolution before the
  // reduction, so SVG resize optimizations cannot skip the downsampling.
  const raster = await sharp(svg, { density: SOURCE_DENSITY * RENDER_SCALE * Math.max(width, height) / svgEdge }).png().toBuffer()
  return new Uint8Array(await sharp(raster).resize(width, height, { kernel: 'lanczos3' }).png().toBuffer())
}

/**
 * Read the configured SVG and build a replacement for every icon the dist declares.
 * @throws when the SVG cannot be read or decoded, the dist declares no icon,
 * an icon lies outside the dist, or an icon is neither SVG nor PNG.
 */
async function loadIcons(iconPath: string, distRoot: string, distIndex: string): Promise<ReadonlyMap<string, Asset>> {
  const { default: sharp } = await import('sharp')
  const svg = await readFile(iconPath)
  const source = await sharp(svg).metadata().catch((error: unknown) => {
    throw new Error(`frontend-static: cannot decode the icon ${iconPath}`, { cause: error })
  })
  if (source.format !== 'svg') throw new Error(`frontend-static: the icon ${iconPath} is ${source.format}, not SVG`)
  const html = await readFile(distIndex, 'utf8')
  const declared = new Map<string, string>()
  for (const href of linkHrefs(html, ['icon', 'apple-touch-icon'])) declared.set(distTarget(distRoot, href, DIST_BASE), href)
  for (const href of linkHrefs(html, ['manifest'])) {
    const manifest: unknown = JSON.parse(await readFile(distTarget(distRoot, href, DIST_BASE), 'utf8'))
    for (const src of manifestIconSources(manifest, href)) declared.set(distTarget(distRoot, src, new URL(href, DIST_BASE)), src)
  }
  if (declared.size === 0) throw new Error(`frontend-static: ${distIndex} declares no icon for ${iconPath} to replace`)
  const svgEdge = Math.max(source.width, source.height)
  return new Map(await Promise.all([...declared].map(async ([target, href]): Promise<[string, Asset]> => {
    switch (extname(target)) {
      case '.svg': return [target, { body: svg, type: SVG_MIME }]
      case '.png': return [target, { body: await renderIcon(svg, svgEdge, target), type: PNG_MIME }]
      default: throw new Error(`frontend-static: the icon ${href} is neither SVG nor PNG, so ${iconPath} cannot replace it`)
    }
  })))
}

/**
 * Read one dist file other than the index: its branded icon, a manifest with
 * the replacement names, or the file itself.
 * @throws when a renamed manifest is not a JSON object.
 */
async function readBrandedAsset(target: string, icons: ReadonlyMap<string, Asset>, names: ManifestNames): Promise<Asset> {
  const icon = icons.get(target)
  if (icon !== undefined) return icon
  const asset = await readDistAsset(target)
  if (extname(target) !== '.webmanifest' || (names.name === undefined && names.shortName === undefined)) return asset
  const manifest: unknown = JSON.parse(new TextDecoder().decode(asset.body))
  if (!isJsonObject(manifest)) throw new Error(`frontend-static: the manifest ${target} is not a JSON object`)
  return {
    body: Buffer.from(JSON.stringify({
      ...manifest,
      ...names.name === undefined ? {} : { name: names.name },
      ...names.shortName === undefined ? {} : { short_name: names.shortName },
    })),
    type: asset.type,
  }
}

/**
 * Answer one GET or HEAD dist request; the webserver answers any other method
 * with 405 before a resource runs. A malformed percent-escape or a filesystem
 * failure other than a missing or non-file target rejects.
 * @param request - the request; only its method and URL path are read.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param authorizeIndex - answers an index request before its bytes are read:
 * the response to send instead of the index, or undefined to serve it.
 * @param renderIndex - turns the raw index.html body into the served document
 * for the dist root and configured index path.
 * @param readAsset - reads the bytes and Content-Type of any other dist file.
 * @returns the dist response; a HEAD response carries the GET status and
 * headers without a body. A file other than the index carries
 * `cache-control: no-cache` and a weak ETag from a SHA-1 of its served bytes,
 * and a request whose `If-None-Match` equals that ETag receives an empty 304.
 */
async function serveStatic(
  request: Request, distRoot: string, distIndex: string,
  authorizeIndex: () => Response | undefined,
  renderIndex: (html: string) => string,
  readAsset: (target: string) => Promise<Asset>,
): Promise<Response> {
  const target = resolve(normalize(join(distRoot, decodeURIComponent(new URL(request.url).pathname))))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay under
  // it. `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) return new Response(null, { status: 403 })
  let body: string | Uint8Array<ArrayBuffer>
  let headers: Record<string, string>
  try {
    if (target === distRoot || target === distIndex) {
      const refusal = authorizeIndex()
      if (refusal !== undefined) return refusal
      body = renderIndex(await readFile(distIndex, 'utf8'))
      headers = { 'content-type': HTML_MIME }
    } else {
      const asset = await readAsset(target)
      body = asset.body
      // Weak: gzip changes the transferred bytes.
      const cache = { 'cache-control': 'no-cache', etag: `W/"${createHash('sha1').update(body).digest('base64url')}"` }
      if (request.headers.get('if-none-match') === cache.etag) return new Response(null, { status: 304, headers: cache })
      headers = { 'content-type': asset.type, ...cache }
    }
  } catch (error) {
    // Only absent or non-file targets are 404; other filesystem failures reach
    // the caller, which the webserver answers with 400 over HTTP.
    if (!STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
    return new Response(null, { status: 404 })
  }
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(typeof body === 'string' ? body : bytesBody(body), { status: 200, headers })
}

/**
 * Claim the webserver fallback seat with a resource serving the dist.
 * @param ctx - plugin context carrying the webServer and connection services.
 * @param config - validated {@link Config}.
 * @returns a promise that settles once the seat is claimed; without `icon` the
 * seat is claimed before this function returns.
 * @throws when `icon` is set and its icons cannot be built (see {@link Config}).
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const distIndex = config.distIndex
  const distRoot = dirname(distIndex)
  const icons = config.icon === undefined ? new Map<string, Asset>() : await loadIcons(config.icon, distRoot, distIndex)
  const names: ManifestNames = { name: config.appName, shortName: config.appShortName }
  const head = config.appShortName === undefined
    ? '<base href="./">'
    : `<base href="./"><meta name="apple-mobile-web-app-title" content="${escapeAttribute(config.appShortName)}">`
  // Connection's browser authentication writes the token exchange's 303 or
  // the 401 through a writeHead/end response; capture it as a Fetch response.
  // The answer stays a 401 unless Connection writes another one.
  const authorizeIndex = (request: Request): Response | undefined => {
    let status = 401
    let headers = new Headers()
    let body: string | undefined
    const admitted = ctx.connection.authorizeIndex(request, {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus
        headers = new Headers(nextHeaders)
      },
      end(text) { body = text },
    })
    return admitted ? undefined : new Response(body, { status, headers })
  }
  ctx.effect(() => ctx.webServer.registerFallback({
    resource: (request, peer) => serveStatic(
      request,
      distRoot,
      distIndex,
      // A read with a Peer was admitted by its caller; an HTTP request carries
      // none and passes Connection's browser authentication instead.
      () => peer === undefined ? authorizeIndex(request) : undefined,
      // The browser authentication admits the owner's shared browser Peer. The
      // base goes in after all index transforms, so it precedes every resource
      // reference they insert.
      (html) => {
        const rendered = ctx.webServer.renderIndex(html, peer ?? ctx.connection.browserPeer)
        return (config.appShortName === undefined ? rendered : rendered.replace(HOME_SCREEN_TITLE, ''))
          .replace(/<head(?:\s[^>]*)?>/i, open => `${open}${head}`)
      },
      target => readBrandedAsset(target, icons, names),
    ),
  }), 'frontend-static: fallback seat')
}

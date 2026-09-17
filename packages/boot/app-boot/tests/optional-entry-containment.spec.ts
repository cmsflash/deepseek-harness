/**
 * REAL-composition coverage of startup containment: a Loader-booted cordis.yml
 * whose optional entries fail the way external bundles did in production
 * (a strict-inject read of an undeclared service, an async apply rejection,
 * and a missing import) leaves the required webserver and its routes serving.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '../src/index.ts'

/**
 * A real listening HTTP server standing in the required `webserver` seat.
 * Written as a sibling module so the composition exercises the same
 * `./name.mjs` import path production profiles use for their entries; the
 * production webserver plugin lives in another package app-boot must not
 * depend on.
 */
const WEBSERVER_SOURCE = [
  "import { createServer } from 'node:http'",
  'export function apply(ctx) {',
  '  const routes = new Map()',
  '  const server = createServer((req, res) => {',
  '    const route = routes.get(new URL(req.url, "http://127.0.0.1").pathname)',
  '    if (route === undefined) { res.writeHead(404); res.end(); return }',
  '    route.handler(req, res)',
  '  })',
  '  ctx.provide("webServer", {',
  '    register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },',
  '    get port() { return server.address().port },',
  '  })',
  '  ctx.effect(() => { server.listen(0, "127.0.0.1"); return () => server.close() })',
  '  return new Promise(resolve => server.once("listening", resolve))',
  '}',
  '',
].join('\n')

const NAME = 'dsh-containment-test'
let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('optional entry failures in a real Loader composition', () => {
  it('keeps the required webserver and its routes serving when optional entries fail', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-containment-'))
    // The production failure class: the plugin's `inject` names only a service
    // it has, then reads one it never declared through the strict-inject proxy.
    await writeFile(join(root, 'undeclared-read.mjs'), [
      'export const inject = ["webServer"]',
      'export function apply(ctx) { ctx.effect(() => ctx.credentials.readRecord()) }',
      '',
    ].join('\n'))
    await writeFile(join(root, 'async-reject.mjs'), [
      'export async function apply() { await Promise.resolve(); throw new Error("provider unavailable") }',
      '',
    ].join('\n'))
    await writeFile(join(root, 'route-owner.mjs'), [
      'export const inject = ["webServer"]',
      'export function apply(ctx) {',
      '  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/alive", handler: (_req, res) => { res.writeHead(200); res.end("alive") } }))',
      '}',
      '',
    ].join('\n'))
    await writeFile(join(root, 'webserver.mjs'), WEBSERVER_SOURCE)
    await writeFile(join(root, 'cordis.yml'), [
      '- id: webserver',
      '  name: ./webserver.mjs',
      '- id: route-owner',
      '  name: ./route-owner.mjs',
      '- id: external-undeclared-read',
      '  name: ./undeclared-read.mjs',
      '- id: external-async-reject',
      '  name: ./async-reject.mjs',
      '- id: external-missing',
      '  name: ./missing.mjs',
      '',
    ].join('\n'))

    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      ctx = await boot(NAME, join(root, 'cordis.yml'))
      const port = ctx.webServer.port
      const alive = await fetch(`http://127.0.0.1:${String(port)}/alive`)
      expect(alive.status).toBe(200)
      expect(await alive.text()).toBe('alive')

      const warning = write.mock.calls.map(call => String(call[0])).join('')
      expect(warning).toContain(`${NAME}: warning: 3 entries did not activate`)
      expect(warning).toContain('external-undeclared-read (./undeclared-read.mjs)')
      expect(warning).toContain('cannot get property "credentials" without inject')
      expect(warning).toContain('external-async-reject (./async-reject.mjs)')
      expect(warning).toContain('provider unavailable')
      expect(warning).toContain('external-missing (./missing.mjs): failed to import')
      expect(warning).not.toContain('fatal load failure')

      const states = new Map([...ctx.loader.entries()].map(entry => [entry.options.id, entry.fiber?.state]))
      expect(states.get('webserver')).toBe(2)
      expect(states.get('route-owner')).toBe(2)
      expect(states.get('external-undeclared-read')).toBe(3)
      expect(states.get('external-async-reject')).toBe(3)
      expect(states.get('external-missing')).toBeUndefined()
    } finally {
      write.mockRestore()
    }
  })
})

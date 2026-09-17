/**
 * REAL-composition coverage: a test-only cordis.yml booted through the vendored
 * Loader mounts webserver, credentials, Connection, and a plugin whose `inject`
 * names only `connection`. The plugin registers a dedicated RPC channel the way
 * external plugins do, and every assertion observes the running HTTP server.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '../src/index.ts'
import type { HostConnectionHandle } from '../src/index.ts'

const CHANNEL_PLUGIN = 'test:connection-only-plugin'
let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** The registrant under test: it reads `ctx.connection` and nothing else. */
const channelPlugin = {
  name: 'connection-only-plugin',
  inject: ['connection'],
  apply(ctx: Context): void {
    ctx.connection.rpc.handle('/plugin-rpc', async (endpoint, payload) => ({
      ok: true, value: { endpoint, echoed: payload },
    }))
  },
}

async function loadComposition(): Promise<{ ctx: Context; port: number; connection: HostConnectionHandle }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-connection-channel-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    dshHome: ${JSON.stringify(root)}`,
    '    watch: false',
    "- name: '@deepseek-ai/dsh-client-connection'",
    `- name: '${CHANNEL_PLUGIN}'`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentials],
    ['@deepseek-ai/dsh-client-connection', Connection],
    [CHANNEL_PLUGIN, channelPlugin],
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
  return {
    ctx: context,
    port: context.webServer.port,
    connection: context.get('connection') as HostConnectionHandle,
  }
}

/** Exchange the process token for the authority-bound browser cookie over the real server. */
function signIn(port: number, connection: HostConnectionHandle): string {
  const url = new URL(connection.authenticatedUrl(`http://127.0.0.1:${String(port)}`))
  const recorded: Record<string, string> = {}
  const recorder = {
    writeHead(_status: number, headers?: Record<string, string>) {
      Object.assign(recorded, headers)
      return recorder
    },
    end() { return recorder },
  }
  connection.authorizeIndex(
    { url: `${url.pathname}${url.search}`, method: 'GET', headers: { host: `127.0.0.1:${String(port)}` } },
    recorder,
  )
  const setCookie = recorded['set-cookie']
  if (setCookie === undefined) throw new Error('browser token exchange did not set a cookie')
  return setCookie.split(';', 1)[0]!
}

describe('dedicated RPC channel through the real Loader composition', () => {
  it('serves a channel registered by a plugin injecting only connection', { timeout: 60_000 }, async () => {
    const { ctx, port, connection } = await loadComposition()
    // The registrant loaded without a webServer injection: its fiber is active, not failed.
    const registrant = [...ctx.loader.entries()].find(entry => entry.options.name === CHANNEL_PLUGIN)
    expect(registrant?.fiber?.state).toBe(FiberState.ACTIVE)
    const cookie = signIn(port, connection)

    const unauthenticated = await fetch(`http://127.0.0.1:${String(port)}/plugin-rpc/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'speak', payload: {} }),
    })
    expect(unauthenticated.status).toBe(401)

    const response = await fetch(`http://127.0.0.1:${String(port)}/plugin-rpc/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'speak', payload: { text: 'hi' } }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      type: 'server-response',
      rpcId: 'r2',
      result: { ok: true, value: { endpoint: 'speak', echoed: { text: 'hi' } } },
    })

    // The shared /api route the same Connection mounts keeps working beside the channel.
    const api = await fetch(`http://127.0.0.1:${String(port)}/api/nothing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r3', method: 'nothing', payload: {} }),
    })
    expect(api.status).toBe(404)
  })

  it('removes the channel with the registrant and keeps the shared route serving', { timeout: 60_000 }, async () => {
    const { ctx, port, connection } = await loadComposition()
    const cookie = signIn(port, connection)
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === CHANNEL_PLUGIN)
    if (entry === undefined) throw new Error('registrant entry not loaded')
    entry.parent.remove(entry.options.id)
    await ctx.loader.await()

    const gone = await fetch(`http://127.0.0.1:${String(port)}/plugin-rpc/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r4', method: 'speak', payload: {} }),
    })
    expect(gone.status).toBe(404)
    const api = await fetch(`http://127.0.0.1:${String(port)}/api/nothing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r5', method: 'nothing', payload: {} }),
    })
    expect(api.status).toBe(404)
    expect(api.headers.get('content-type')).not.toBeNull()
  })
})

/**
 * The plugin body over a real cordis Context: one provider per configured
 * route, config wins over the launch environment, the environment supplies the
 * fallback, and the registration rides the plugin fiber.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import SpeechRuntime, { type SpeechProvider } from '@deepseek-ai/dsh-speech'
import * as speechRoutesPlugin from '@deepseek-ai/dsh-speech-openai-compatible'
import { OPENAI_DEFAULT_BASE_URL, apply, inject, name } from '@deepseek-ai/dsh-speech-openai-compatible'

const savedKey = process.env.LITELLM_API_KEY
const savedBase = process.env.LITELLM_BASE_URL

afterEach(() => {
  if (savedKey === undefined) delete process.env.LITELLM_API_KEY
  else process.env.LITELLM_API_KEY = savedKey
  if (savedBase === undefined) delete process.env.LITELLM_BASE_URL
  else process.env.LITELLM_BASE_URL = savedBase
})

/** A speech seam stand-in that records what the plugin registers. */
async function bench() {
  const ctx = new Context()
  const registered: SpeechProvider[] = []
  class SpeechService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'speech') }
    registerProvider(provider: SpeechProvider): () => void {
      registered.push(provider)
      return () => { registered.splice(registered.indexOf(provider), 1) }
    }
  }
  new SpeechService(ctx)
  return { ctx, registered }
}

describe('speech-openai-compatible plugin', () => {
  it('declares its loader identity and the seam it needs', () => {
    expect(name).toBe('speech-openai-compatible')
    expect(inject).toEqual(['speech'])
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in speechRoutesPlugin).toBe(false)
  })

  it('registers one provider per configured route, under the map key', async () => {
    const b = await bench()
    apply(b.ctx, {
      providers: {
        litellm: { apiKey: 'a', baseURL: 'https://gateway.example/v1' },
        openai: { apiKey: 'b' },
      },
    })
    expect(b.registered.map(p => p.id)).toEqual(['litellm', 'openai'])
    expect(b.registered.every(p => p.available())).toBe(true)
  })

  it('defaults a route that names no base URL to the public OpenAI API', async () => {
    const b = await bench()
    apply(b.ctx, { providers: { openai: { apiKey: 'b' } } })
    expect(OPENAI_DEFAULT_BASE_URL).toBe('https://api.openai.com/v1')
    expect(b.registered[0]?.available()).toBe(true)
  })

  it('reads the key and base URL from the launch environment by reference', async () => {
    process.env.LITELLM_API_KEY = 'from-env'
    process.env.LITELLM_BASE_URL = 'https://env.example'
    const b = await bench()
    apply(b.ctx, {
      providers: { litellm: { apiKeyEnv: 'LITELLM_API_KEY', baseURLEnv: 'LITELLM_BASE_URL' } },
    })
    expect(b.registered[0]?.available()).toBe(true)
  })

  it('registers an unavailable route when its referenced credential is absent', async () => {
    delete process.env.LITELLM_API_KEY
    const b = await bench()
    apply(b.ctx, { providers: { litellm: { apiKeyEnv: 'LITELLM_API_KEY' } } })
    // Registered but unusable, so pinning it reports CONFIGURED_UNAVAILABLE
    // rather than CONFIGURED_MISSING.
    expect(b.registered).toHaveLength(1)
    expect(b.registered[0]?.available()).toBe(false)
  })

  it('prefers a literal key over the environment reference', async () => {
    process.env.LITELLM_API_KEY = ''
    const b = await bench()
    apply(b.ctx, { providers: { litellm: { apiKey: 'literal', apiKeyEnv: 'LITELLM_API_KEY' } } })
    expect(b.registered[0]?.available()).toBe(true)
  })

  it('removes every contribution when the registering fiber unloads', async () => {
    // The real seam owns disposal through ctx.effect, so HMR safety is only
    // observable against it rather than against a recording stand-in.
    const ctx = new Context()
    await ctx.plugin(SpeechRuntime, {
      provider: 'litellm', model: 'm', voice: 'alloy', bitrate: 64_000, maxChars: 100,
    })
    const fiber = await ctx.plugin(speechRoutesPlugin, {
      providers: { litellm: { apiKey: 'k' }, openai: { apiKey: 'k' } },
    })
    await expect(ctx.speech.synthesize({ text: 'hi' })).rejects.toMatchObject({
      code: 'SPEECH_REQUEST_FAILED',
    })
    await fiber.dispose()
    await expect(ctx.speech.synthesize({ text: 'hi' })).rejects.toMatchObject({
      code: 'SPEECH_PROVIDER_CONFIGURED_MISSING',
    })
  })
})

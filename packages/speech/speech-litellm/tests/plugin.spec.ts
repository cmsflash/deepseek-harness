/**
 * The plugin body over a real cordis Context: config wins over the launch
 * environment, the environment supplies the fallback, and the registration
 * rides the plugin fiber.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import SpeechRuntime, { type SpeechProvider } from '@deepseek-ai/dsh-speech'
import * as speechLitellmPlugin from '@deepseek-ai/dsh-speech-litellm'
import { LITELLM_DEFAULT_BASE_URL, apply, inject, name } from '@deepseek-ai/dsh-speech-litellm'

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

describe('speech-litellm plugin', () => {
  it('declares its loader identity and the seam it needs', () => {
    expect(name).toBe('speech-litellm')
    expect(inject).toEqual(['speech'])
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in speechLitellmPlugin).toBe(false)
  })

  it('registers a provider that is usable with a configured key', async () => {
    const b = await bench()
    apply(b.ctx, { apiKey: 'from-config' })
    expect(b.registered).toHaveLength(1)
    expect(b.registered[0]?.id).toBe('litellm')
    expect(b.registered[0]?.available()).toBe(true)
  })

  it('falls back to the launch environment for the key and base URL', async () => {
    process.env.LITELLM_API_KEY = 'from-env'
    process.env.LITELLM_BASE_URL = 'https://env.example'
    const b = await bench()
    apply(b.ctx, {})
    expect(b.registered[0]?.available()).toBe(true)
  })

  it('is unavailable when neither config nor environment names a key', async () => {
    delete process.env.LITELLM_API_KEY
    const b = await bench()
    apply(b.ctx, {})
    expect(b.registered[0]?.available()).toBe(false)
  })

  it('accepts explicit overrides for every field', async () => {
    const b = await bench()
    apply(b.ctx, { apiKey: 'k', baseURL: LITELLM_DEFAULT_BASE_URL, timeoutMs: 1_000 })
    expect(b.registered[0]?.available()).toBe(true)
  })

  it('removes its contribution when the registering fiber unloads', async () => {
    // The real seam owns disposal through ctx.effect, so HMR safety is only
    // observable against it rather than against a recording stand-in.
    const ctx = new Context()
    await ctx.plugin(SpeechRuntime, { model: 'm', bitrate: 64_000, maxChars: 100 })
    const fiber = await ctx.plugin(speechLitellmPlugin, { apiKey: 'k' })
    await expect(ctx.speech.synthesize({ text: 'hi' })).rejects.toMatchObject({
      code: 'SPEECH_REQUEST_FAILED',
    })
    await fiber.dispose()
    await expect(ctx.speech.synthesize({ text: 'hi' })).rejects.toMatchObject({
      code: 'SPEECH_PROVIDER_UNAVAILABLE',
    })
  })
})

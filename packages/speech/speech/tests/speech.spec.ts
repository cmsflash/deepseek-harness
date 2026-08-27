import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SpeechRuntime, {
  SpeechError,
  type SpeechAudio,
  type SpeechProvider,
  type SpeechRuntimeConfig,
  type SpeechSpec,
} from '@deepseek-ai/dsh-speech'

const BASE: SpeechRuntimeConfig = {
  model: 'vendor/voice-hd',
  bitrate: 64_000,
  maxChars: 20,
  voice: 'narrator',
}

function audio(marker: string): SpeechAudio {
  return { data: new TextEncoder().encode(marker), mediaType: 'audio/mpeg' }
}

function provider(
  id: string,
  available: boolean,
  synthesize: (spec: SpeechSpec) => Promise<SpeechAudio> = () => Promise.resolve(audio(id)),
): SpeechProvider {
  return { id, available: () => available, synthesize: spec => synthesize(spec) }
}

async function mount(config: Partial<SpeechRuntimeConfig> = {}): Promise<SpeechRuntime> {
  const ctx = new Context()
  await ctx.plugin(SpeechRuntime, { ...BASE, ...config })
  return ctx.speech
}

describe('SpeechRuntime.resolve', () => {
  it('applies deployment policy so a provider receives a complete spec', async () => {
    const speech = await mount()
    expect(speech.resolve({ text: '  hello  ' })).toEqual({
      text: 'hello',
      model: 'vendor/voice-hd',
      bitrate: 64_000,
      voice: 'narrator',
      truncated: false,
    })
  })

  it('lets a request override the configured voice', async () => {
    const speech = await mount()
    expect(speech.resolve({ text: 'hi', voice: 'other' }).voice).toBe('other')
  })

  it('always resolves a voice, which an OpenAI-shaped route requires', async () => {
    const speech = await mount({ voice: 'configured' })
    expect(speech.resolve({ text: 'hi' }).voice).toBe('configured')
  })

  it('truncates past maxChars rather than splitting the request', async () => {
    const speech = await mount({ maxChars: 5 })
    const spec = speech.resolve({ text: 'abcdefghij' })
    expect(spec.text).toBe('abcde')
    expect(spec.truncated).toBe(true)
  })

  it('rejects blank text instead of billing for silence', async () => {
    const speech = await mount()
    expect(() => speech.resolve({ text: '   ' })).toThrow(SpeechError)
    expect(() => speech.resolve({ text: '' })).toThrow(/non-blank/)
  })
})

describe('SpeechRuntime provider selection', () => {
  it('auto-selects the single usable provider', async () => {
    const speech = await mount()
    speech.registerProvider(provider('only', true))
    await expect(speech.synthesize({ text: 'hi' })).resolves.toEqual(audio('only'))
  })

  it('refuses when several providers are usable', async () => {
    const speech = await mount()
    speech.registerProvider(provider('a', true))
    speech.registerProvider(provider('b', true))
    await expect(speech.synthesize({ text: 'hi' })).rejects.toThrow(/multiple usable/)
  })

  it('ignores an unavailable provider when auto-selecting', async () => {
    const speech = await mount()
    speech.registerProvider(provider('down', false))
    speech.registerProvider(provider('up', true))
    await expect(speech.synthesize({ text: 'hi' })).resolves.toEqual(audio('up'))
  })

  it('reports no usable provider distinctly from a missing configured one', async () => {
    const speech = await mount()
    speech.registerProvider(provider('down', false))
    await expect(speech.synthesize({ text: 'hi' })).rejects.toMatchObject({
      code: 'SPEECH_PROVIDER_UNAVAILABLE',
    })
  })

  it('honors a configured id over registration order', async () => {
    const speech = await mount({ provider: 'second' })
    speech.registerProvider(provider('first', true))
    speech.registerProvider(provider('second', true))
    await expect(speech.synthesize({ text: 'hi' })).resolves.toEqual(audio('second'))
  })

  it('distinguishes a configured provider that is missing from one that is down', async () => {
    const missing = await mount({ provider: 'absent' })
    await expect(missing.synthesize({ text: 'hi' })).rejects.toMatchObject({
      code: 'SPEECH_PROVIDER_CONFIGURED_MISSING',
    })
    const down = await mount({ provider: 'down' })
    down.registerProvider(provider('down', false))
    await expect(down.synthesize({ text: 'hi' })).rejects.toMatchObject({
      code: 'SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE',
    })
  })

  it('rejects a duplicate provider id', async () => {
    const speech = await mount()
    speech.registerProvider(provider('dup', true))
    expect(() => speech.registerProvider(provider('dup', true))).toThrow(/already registered/)
  })

  it('unregisters through the returned disposer', async () => {
    const speech = await mount()
    const dispose = speech.registerProvider(provider('gone', true))
    dispose()
    await expect(speech.synthesize({ text: 'hi' })).rejects.toMatchObject({
      code: 'SPEECH_PROVIDER_UNAVAILABLE',
    })
  })

  it('removes a contribution when the registering fiber unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechRuntime, BASE)
    const fiber = await ctx.plugin({
      inject: ['speech'],
      apply: (inner: Context) => { inner.speech.registerProvider(provider('scoped', true)) },
    })
    await expect(ctx.speech.synthesize({ text: 'hi' })).resolves.toEqual(audio('scoped'))
    await fiber.dispose()
    await expect(ctx.speech.synthesize({ text: 'hi' })).rejects.toMatchObject({
      code: 'SPEECH_PROVIDER_UNAVAILABLE',
    })
  })

  it('forwards the resolved spec and cancellation to the provider', async () => {
    const speech = await mount({ maxChars: 4 })
    const synthesize = vi.fn(() => Promise.resolve(audio('x')))
    speech.registerProvider({ id: 'spy', available: () => true, synthesize })
    const controller = new AbortController()
    await speech.synthesize({ text: 'abcdefg' }, controller.signal)
    expect(synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'abcd', truncated: true, bitrate: 64_000 }),
      controller.signal,
    )
  })
})

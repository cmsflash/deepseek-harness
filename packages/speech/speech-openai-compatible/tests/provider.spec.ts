import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiCompatibleSpeechProvider } from '@deepseek-ai/dsh-speech-openai-compatible'
import type { SpeechSpec } from '@deepseek-ai/dsh-speech'

const SPEC: SpeechSpec = {
  text: 'hello',
  model: 'minimax/speech-2.6-hd',
  bitrate: 64_000,
  voice: 'alloy',
  truncated: false,
}

function provider(overrides: Partial<ConstructorParameters<typeof OpenAiCompatibleSpeechProvider>[0]> = {}) {
  return new OpenAiCompatibleSpeechProvider({
    id: 'litellm', apiKey: 'k', baseURL: 'https://gateway.example', timeoutMs: 5_000, ...overrides,
  })
}

/**
 * Install a fetch stub and return the recorded calls. A fresh Response is
 * built per call because a body may be consumed only once.
 */
function stubFetch(make: () => Response) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const signals: (AbortSignal | undefined)[] = []
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const body = typeof init.body === 'string' ? init.body : ''
    calls.push({ url, body: JSON.parse(body) as Record<string, unknown> })
    signals.push(init.signal ?? undefined)
    return Promise.resolve(make())
  })
  return { calls, signals }
}

/** A 200 reply carrying the given audio bytes. */
const audioReply = (...bytes: number[]) => () => new Response(new Uint8Array(bytes), { status: 200 })

afterEach(() => { vi.unstubAllGlobals() })

describe('OpenAiCompatibleSpeechProvider', () => {
  it('is unavailable without a credential', () => {
    expect(provider({ apiKey: '' }).available()).toBe(false)
    expect(provider().available()).toBe(true)
  })

  it('registers under the id its route was configured with', () => {
    expect(provider().id).toBe('litellm')
    expect(provider({ id: 'openai' }).id).toBe('openai')
  })

  it('posts the resolved spec to the route speech endpoint', async () => {
    const { calls } = stubFetch(audioReply(1, 2, 3))
    await provider().synthesize(SPEC)
    expect(calls[0]?.url).toBe('https://gateway.example/audio/speech')
    expect(calls[0]?.body).toMatchObject({
      model: 'minimax/speech-2.6-hd',
      input: 'hello',
      response_format: 'mp3',
      extra_body: { bitrate: 64_000 },
    })
  })

  it('always sends a voice, which the route rejects a request without', async () => {
    const { calls } = stubFetch(audioReply(1))
    await provider().synthesize(SPEC)
    expect(calls[0]?.body['voice']).toBe('alloy')
    await provider().synthesize({ ...SPEC, voice: 'narrator' })
    expect(calls[1]?.body['voice']).toBe('narrator')
  })

  it('normalizes a base URL with a trailing slash', async () => {
    const { calls } = stubFetch(audioReply(1))
    await provider({ baseURL: 'https://gateway.example/' }).synthesize(SPEC)
    expect(calls[0]?.url).toBe('https://gateway.example/audio/speech')
  })

  it('returns the audio bytes it received', async () => {
    stubFetch(audioReply(9, 8, 7))
    const audio = await provider().synthesize(SPEC)
    expect(audio.data).toEqual(new Uint8Array([9, 8, 7]))
    expect(audio.mediaType).toBe('audio/mpeg')
  })

  it('reports a route error with its status and detail', async () => {
    stubFetch(() => new Response('model not found', { status: 404 }))
    const error = await provider().synthesize(SPEC).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'SPEECH_REQUEST_FAILED' })
    expect(String(error)).toContain('404')
  })

  it('reports a route error whose body cannot be read', async () => {
    const unreadable = () => {
      const response = new Response('ignored', { status: 500 })
      // A body that rejects stands in for a truncated or aborted error payload.
      Object.defineProperty(response, 'text', {
        value: () => Promise.reject(new Error('stream closed')),
      })
      return response
    }
    stubFetch(unreadable)
    const error = await provider().synthesize(SPEC).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'SPEECH_REQUEST_FAILED' })
    // No detail is appended when the body could not be read.
    expect(error).toMatchObject({ message: 'speech route returned 500' })
  })

  it('rejects an empty audio body rather than caching silence', async () => {
    stubFetch(audioReply())
    await expect(provider().synthesize(SPEC)).rejects.toMatchObject({ code: 'SPEECH_REQUEST_FAILED' })
  })

  it('reports a transport failure as a speech error', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')))
    await expect(provider().synthesize(SPEC)).rejects.toMatchObject({ code: 'SPEECH_REQUEST_FAILED' })
  })

  it('forwards caller cancellation alongside its own deadline', async () => {
    const { signals } = stubFetch(audioReply(1))
    const controller = new AbortController()
    await provider().synthesize(SPEC, controller.signal)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
  })
})

/**
 * Real-route synthesis against a live OpenAI-compatible gateway.
 *
 * A local stub cannot replace this: a stub accepts any body, so it proves the
 * seam's wiring while hiding the request fields only a vendor rejects. The
 * omitted-`voice` request that this suite pins as a failure passed every
 * package test and every stub exercise, and failed on every real route.
 *
 * Self-skips without `LITELLM_API_KEY`, per the e2e key policy in
 * docs/testing.md.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TtsRuntime from '@deepseek-ai/dsh-tts'
import * as speechRoutes from '@deepseek-ai/dsh-openai-tts'

const apiKey = process.env.LITELLM_API_KEY
const baseURL = process.env.LITELLM_BASE_URL

/** mp3 begins with an ID3 tag or an MPEG frame sync; both appear across vendors. */
function isMp3(data: Uint8Array): boolean {
  const [b0, b1, b2] = data
  if (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) return true
  return b0 === 0xff && b1 !== undefined && (b1 & 0xe0) === 0xe0
}

async function speechWith(config: { model: string; voice: string }): Promise<TtsRuntime> {
  const ctx = new Context()
  await ctx.plugin(TtsRuntime, {
    provider: 'litellm',
    bitrate: 64_000,
    maxChars: 10_000,
    ...config,
  })
  await ctx.plugin(speechRoutes, {
    providers: {
      litellm: {
        apiKeyEnv: 'LITELLM_API_KEY',
        ...baseURL !== undefined ? { baseURLEnv: 'LITELLM_BASE_URL' } : {},
      },
    },
  })
  return ctx.tts
}

describe.skipIf(apiKey === undefined || apiKey.length === 0)('OpenAI-compatible speech route', () => {
  // Both vendor families, because they disagree on which optional fields they
  // honor and only agree that `voice` is mandatory.
  it.each([
    { model: 'minimax/speech-2.6-hd', voice: 'alloy' },
    { model: 'openai/tts-1', voice: 'alloy' },
  ])('synthesizes playable audio through $model', async (config) => {
    const speech = await speechWith(config)
    const audio = await speech.synthesize({ text: 'Read aloud works end to end.' })
    expect(audio.mediaType).toBe('audio/mpeg')
    expect(audio.data.byteLength).toBeGreaterThan(1_000)
    expect(isMp3(audio.data)).toBe(true)
  }, 60_000)

  it('reports an unroutable model rather than caching a non-audio body', async () => {
    // The gateway advertises models its account cannot route, and answers them
    // with the same opaque 500 a malformed request gets.
    const speech = await speechWith({ model: 'mistral/voxtral-mini-tts-2603', voice: 'alloy' })
    await expect(
      speech.synthesize({ text: 'Read aloud works end to end.' }),
    ).rejects.toMatchObject({ code: 'SPEECH_REQUEST_FAILED' })
  }, 60_000)
})

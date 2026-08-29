// @vitest-environment jsdom
/**
 * SpeechPlayer behavior: one active stream per Session, snapshot stability,
 * and the supersession rule that keeps a slow load from resurrecting playback
 * the user already moved on from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import { SpeechPlayer } from '../src/client/player.ts'

const A = 'm-a' as MessageId
const B = 'm-b' as MessageId

const played: HTMLAudioElement[] = []
let revoke: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  played.length = 0
  // jsdom implements no media pipeline; record calls instead.
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLAudioElement) {
    played.push(this)
    return Promise.resolve()
  })
  vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:audio')
  revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

const audio = () => Promise.resolve({ data: 'AAAA', mediaType: 'audio/mpeg' })

describe('SpeechPlayer', () => {
  it('starts idle with a reference-stable snapshot', () => {
    const player = new SpeechPlayer(audio)
    expect(player.getSnapshot()).toEqual({ activeMessageId: undefined, status: 'idle' })
    expect(player.getSnapshot()).toBe(player.getSnapshot())
  })

  it('plays a message and reports it active', async () => {
    const player = new SpeechPlayer(audio)
    await player.toggle(A)
    expect(player.getSnapshot()).toEqual({ activeMessageId: A, status: 'playing' })
    expect(played).toHaveLength(1)
  })

  it('stops when the playing message is toggled again', async () => {
    const player = new SpeechPlayer(audio)
    await player.toggle(A)
    await player.toggle(A)
    expect(player.getSnapshot().activeMessageId).toBeUndefined()
  })

  it('never plays two messages at once', async () => {
    const player = new SpeechPlayer(audio)
    await player.toggle(A)
    await player.toggle(B)
    expect(player.getSnapshot()).toEqual({ activeMessageId: B, status: 'playing' })
  })

  it('notifies subscribers and stops after unsubscribe', async () => {
    const player = new SpeechPlayer(audio)
    const seen = vi.fn()
    const off = player.subscribe(seen)
    await player.toggle(A)
    expect(seen).toHaveBeenCalled()
    off()
    const before = seen.mock.calls.length
    await player.toggle(B)
    expect(seen.mock.calls.length).toBe(before)
  })

  it('reports an error when audio cannot be produced', async () => {
    const player = new SpeechPlayer(() => Promise.resolve(undefined))
    await player.toggle(A)
    expect(player.getSnapshot()).toEqual({ activeMessageId: A, status: 'error' })
  })

  it('reports an error when the loader rejects', async () => {
    const player = new SpeechPlayer(() => Promise.reject(new Error('offline')))
    await player.toggle(A)
    expect(player.getSnapshot().status).toBe('error')
  })

  it('retries a failed message instead of treating the click as a stop', async () => {
    let fail = true
    const player = new SpeechPlayer(() => (fail ? Promise.resolve(undefined) : audio()))
    await player.toggle(A)
    expect(player.getSnapshot().status).toBe('error')
    fail = false
    await player.toggle(A)
    expect(player.getSnapshot()).toEqual({ activeMessageId: A, status: 'playing' })
  })

  it('discards a slow load superseded by a later request', async () => {
    let release: (value: { data: string; mediaType: string }) => void = () => {}
    const slow = new Promise<{ data: string; mediaType: string }>((resolve) => { release = resolve })
    let first = true
    const player = new SpeechPlayer(() => {
      if (first) { first = false; return slow }
      return audio()
    })
    const pending = player.toggle(A)
    await player.toggle(B)
    release({ data: 'AAAA', mediaType: 'audio/mpeg' })
    await pending
    expect(player.getSnapshot().activeMessageId).toBe(B)
  })

  it('releases the object URL when playback stops', async () => {
    const player = new SpeechPlayer(audio)
    await player.toggle(A)
    player.stop()
    expect(revoke).toHaveBeenCalledWith('blob:audio')
  })

  it('returns to idle when the element reports playback ended', async () => {
    const player = new SpeechPlayer(audio)
    await player.toggle(A)
    played[0]!.dispatchEvent(new Event('ended'))
    expect(player.getSnapshot().activeMessageId).toBeUndefined()
  })

  it('reports an element error as a failed message', async () => {
    const player = new SpeechPlayer(audio)
    await player.toggle(A)
    played[0]!.dispatchEvent(new Event('error'))
    expect(player.getSnapshot()).toEqual({ activeMessageId: A, status: 'error' })
  })

  it('ignores element events from a superseded playback', async () => {
    const player = new SpeechPlayer(audio)
    await player.toggle(A)
    const stale = played[0]!
    await player.toggle(B)
    stale.dispatchEvent(new Event('ended'))
    stale.dispatchEvent(new Event('error'))
    expect(player.getSnapshot()).toEqual({ activeMessageId: B, status: 'playing' })
  })

  it('drops subscribers on dispose', async () => {
    const player = new SpeechPlayer(audio)
    const seen = vi.fn()
    player.subscribe(seen)
    player.dispose()
    const before = seen.mock.calls.length
    await player.toggle(A)
    expect(seen.mock.calls.length).toBe(before)
  })

  it('treats a promise-less play() as started', async () => {
    vi.spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => undefined as unknown as Promise<void>)
    const player = new SpeechPlayer(audio)
    await player.toggle(A)
    expect(player.getSnapshot().status).toBe('playing')
  })

  it('reports a rejected play() as an error', async () => {
    vi.spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => Promise.reject(new Error('blocked')))
    const player = new SpeechPlayer(audio)
    await player.toggle(A)
    expect(player.getSnapshot().status).toBe('error')
  })
})

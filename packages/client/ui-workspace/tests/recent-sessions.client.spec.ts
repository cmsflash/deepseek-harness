import { describe, expect, it, vi } from 'vitest'
import type { ISessions, SessionReference, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { RecentSessions } from '../src/client/recent-sessions.ts'

const sid = (id: string): SessionId => SessionId(id)

interface Issued {
  readonly target: SessionTarget
  readonly reference: SessionReference
  readonly release: ReturnType<typeof vi.fn<() => void>>
}

function controller() {
  const issued: Issued[] = []
  const retain = vi.fn<ISessions['retain']>((target) => {
    const sessionId = typeof target === 'string' ? target : target.childSessionId
    const release = vi.fn<() => void>()
    const binding = { sessionId } as SessionReference['binding']
    const reference: SessionReference = {
      sessionId, binding, ready: Promise.resolve(binding), release, [Symbol.dispose]: release,
    }
    issued.push({ target, reference, release })
    return reference
  })
  const held = (): SessionId[] => issued
    .filter(item => item.release.mock.calls.length === 0)
    .map(item => item.reference.sessionId)
  return { retain, issued, held }
}

describe('RecentSessions', () => {
  it('retains each left Session as recentView and releases the least recently left beyond capacity', () => {
    const sessions = controller()
    const recent = new RecentSessions(sessions, 2)

    recent.keep(sid('a'))
    recent.keep(sid('b'))
    expect(sessions.held()).toEqual([sid('a'), sid('b')])
    recent.keep(sid('c'))

    expect(sessions.retain.mock.calls.map(([target, options]) => [target, options.source])).toEqual([
      [sid('a'), 'recentView'], [sid('b'), 'recentView'], [sid('c'), 'recentView'],
    ])
    expect(sessions.held()).toEqual([sid('b'), sid('c')])
  })

  it('keeps nothing at capacity 0', () => {
    const sessions = controller()
    new RecentSessions(sessions, 0).keep(sid('a'))

    expect(sessions.retain).not.toHaveBeenCalled()
  })

  it('replaces an earlier reference to the same Session after retaining the new one', () => {
    const sessions = controller()
    const recent = new RecentSessions(sessions, 2)
    recent.keep(sid('a'))
    recent.keep(sid('b'))

    recent.keep(sid('a'))

    const [first, , second] = sessions.issued
    expect(first!.release.mock.invocationCallOrder[0]).toBeGreaterThan(sessions.retain.mock.invocationCallOrder[2]!)
    expect(second!.release).not.toHaveBeenCalled()
    expect(sessions.held()).toEqual([sid('b'), sid('a')])
    recent.keep(sid('c'))
    expect(sessions.held()).toEqual([sid('a'), sid('c')])
  })

  it('releases one Session, matching Sessions, or all of them', () => {
    const sessions = controller()
    const recent = new RecentSessions(sessions, 4)
    for (const id of ['a', 'b', 'c', 'd']) recent.keep(sid(id))

    recent.release(sid('x'))
    expect(sessions.held()).toEqual([sid('a'), sid('b'), sid('c'), sid('d')])
    recent.release(sid('b'))
    expect(sessions.held()).toEqual([sid('a'), sid('c'), sid('d')])
    recent.releaseWhere(id => id === sid('a') || id === sid('d'))
    expect(sessions.held()).toEqual([sid('c')])
    recent.clear()
    expect(sessions.held()).toEqual([])
    recent.clear()
    expect(sessions.issued.every(item => item.release.mock.calls.length === 1)).toBe(true)
  })

  it('retains a subagent by the address it was displayed under', () => {
    const sessions = controller()
    const address: SubagentAddress = { parentSessionId: sid('parent'), childSessionId: sid('child'), mode: 'continuable' }

    new RecentSessions(sessions, 1).keep(address)

    expect(sessions.retain).toHaveBeenCalledExactlyOnceWith(address, { source: 'recentView' })
    expect(sessions.held()).toEqual([sid('child')])
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import {
  ComposerSubmissionPolicy, DEFAULT_BUSY_ENTER_BEHAVIOR, ENTER_KEY_STORAGE_KEY, resolveSubmitMode,
} from '../src/client/input/submission-policy.ts'
import type { ConversationSettings } from '../src/submission-settings.ts'

describe('resolveSubmitMode', () => {
  it('queues outside steer-capable busy state and applies the preference to the enter gesture', () => {
    expect(resolveSubmitMode('queue', false, 'enter', true)).toBe('queue')
    expect(resolveSubmitMode('queue', false, 'accelerated', true)).toBe('queue')
    expect(resolveSubmitMode('queue', true, 'enter', true)).toBe('queue')
    expect(resolveSubmitMode('queue', true, 'accelerated', true)).toBe('steer')
    expect(resolveSubmitMode('queue', true, 'enter', false)).toBe('queue')
    expect(resolveSubmitMode('queue', true, 'accelerated', false)).toBe('queue')

    expect(resolveSubmitMode('steer', true, 'enter', true)).toBe('steer')
    expect(resolveSubmitMode('steer', true, 'accelerated', true)).toBe('queue')
    expect(resolveSubmitMode('steer', false, 'enter', true)).toBe('queue')
    expect(resolveSubmitMode('steer', false, 'accelerated', true)).toBe('queue')
    expect(resolveSubmitMode('steer', true, 'enter', false)).toBe('queue')
  })
})

describe('ComposerSubmissionPolicy', () => {
  it('defaults to Queue and publishes preference changes', () => {
    const policy = new ComposerSubmissionPolicy()
    expect(policy.busyEnter.getSnapshot()).toBe(DEFAULT_BUSY_ENTER_BEHAVIOR)

    const changed = vi.fn()
    policy.busyEnter.subscribe(changed)
    policy.setBusyEnter('steer')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(policy.busyEnter.getSnapshot()).toBe('steer')
  })

  it('writes an explicit change through the scope after publishing it locally', () => {
    const host = stubConfigForm<ConversationSettings>()
    const observed: string[] = []
    let liveBehavior = (): string => 'unconstructed'
    const scope: typeof host.scope = {
      ...host.scope,
      set: (field, value) => {
        observed.push(`${field}=${String(value)}:${liveBehavior()}`)
        return host.scope.set(field, value)
      },
    }
    const policy = new ComposerSubmissionPolicy(scope)
    liveBehavior = () => policy.busyEnter.getSnapshot()
    policy.setBusyEnter('steer')
    expect(observed).toEqual(['busyEnter=steer:steer'])
    expect(host.set).toHaveBeenCalledWith('busyEnter', 'steer')
    expect(host.set).toHaveBeenCalledOnce()
  })

  it('adopts a Host preference without writing it back and leaves an identical write untouched', () => {
    const host = stubConfigForm<ConversationSettings>()
    const policy = new ComposerSubmissionPolicy(host.scope)
    host.publish({ status: 'ready', value: { busyEnter: 'steer' }, revision: 1, writable: true })
    expect(policy.busyEnter.getSnapshot()).toBe('steer')
    policy.setBusyEnter('steer')
    expect(host.set).not.toHaveBeenCalled()
    host.publish({ value: { busyEnter: 'steer' }, revision: 2 })
    expect(policy.busyEnter.getSnapshot()).toBe('steer')
  })

  it('adopts a section already standing at construction', () => {
    const host = stubConfigForm<ConversationSettings>()
    host.publish({ status: 'ready', value: { busyEnter: 'steer' }, revision: 1, writable: true })
    const policy = new ComposerSubmissionPolicy(host.scope)
    expect(policy.busyEnter.getSnapshot()).toBe('steer')
  })
})

describe('ComposerSubmissionPolicy Enter key', () => {
  afterEach(() => { localStorage.clear() })

  it('defaults to Send and keeps a change in this browser only', () => {
    const host = stubConfigForm<ConversationSettings>()
    const policy = new ComposerSubmissionPolicy(host.scope)
    expect(policy.enterKey.getSnapshot()).toBe('send')

    const changed = vi.fn()
    policy.enterKey.subscribe(changed)
    policy.setEnterKey('newline')
    policy.setEnterKey('newline')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(ENTER_KEY_STORAGE_KEY)).toBe('"newline"')
    expect(host.set).not.toHaveBeenCalled()
    expect(new ComposerSubmissionPolicy().enterKey.getSnapshot()).toBe('newline')
  })

  it('replaces an unrecognized stored value with Send', () => {
    localStorage.setItem(ENTER_KEY_STORAGE_KEY, '"ctrl-enter"')
    expect(new ComposerSubmissionPolicy().enterKey.getSnapshot()).toBe('send')
    expect(localStorage.getItem(ENTER_KEY_STORAGE_KEY)).toBe('"send"')
  })
})

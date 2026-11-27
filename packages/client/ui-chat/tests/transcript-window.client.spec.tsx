// @vitest-environment jsdom
import { useRef, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as common } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { ChatConversationViewNode } from '../src/client/contract/chat-nodes.ts'
import { en } from '../src/client/locale.ts'
import { ChatNodeSeat } from '../src/client/chat/ChatNodeSeat.tsx'
import { TranscriptWindow, useChatBodyHeight } from '../src/client/chat/transcript-window.ts'
import { createChatStore } from '../src/client/stores.ts'
import { presentationPolicyFor } from '../src/client/presentation-policy.ts'
import { bindKeyedSnapshotSelector, chatNode, chatNodeStore, settledAssistant } from './step-collapse-fixtures.client.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

function intersections() {
  const callbacks = new Map<Element, (visible: boolean) => void>()
  const disconnect = vi.fn()
  const options: IntersectionObserverInit[] = []
  class Observer {
    constructor(private readonly callback: (entries: Partial<IntersectionObserverEntry>[]) => void, init: IntersectionObserverInit) {
      options.push(init)
    }
    observe(target: Element): void {
      callbacks.set(target, (visible) => { this.callback([{ target, isIntersecting: visible }]) })
    }
    unobserve(): void {}
    disconnect = disconnect
  }
  vi.stubGlobal('IntersectionObserver', Observer)
  return {
    disconnect, options,
    move: (row: Element, visible: boolean): void => {
      const deliver = callbacks.get(row)
      if (deliver === undefined) throw new Error('No observation for row')
      act(() => { deliver(visible) })
    },
  }
}

function idleQueue() {
  let next = 0
  const callbacks = new Map<number, IdleRequestCallback>()
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    const id = ++next
    callbacks.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelIdleCallback', (id: number) => { callbacks.delete(id) })
  return {
    get size() { return callbacks.size },
    take(budget = 0): () => void {
      const item = callbacks.entries().next().value
      if (item === undefined) throw new Error('No pending idle callback')
      const [id, callback] = item
      callbacks.delete(id)
      return () => { act(() => { callback({ didTimeout: false, timeRemaining: () => budget }) }) }
    },
    step(budget = 0): void { this.take(budget)() },
  }
}

function animationFrames() {
  let next = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++next, callback)
    return next
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { callbacks.delete(id) })
  return {
    get size() { return callbacks.size },
    take(timestamp: number): () => void {
      const item = callbacks.entries().next().value
      if (item === undefined) throw new Error('No pending animation frame')
      const [id, callback] = item
      callbacks.delete(id)
      return () => { act(() => { callback(timestamp) }) }
    },
    step(timestamp: number): void { this.take(timestamp)() },
  }
}

function interactionSignals() {
  const add = vi.spyOn(document, 'addEventListener')
  const remove = vi.spyOn(document, 'removeEventListener')
  return {
    remove,
    send(type: string, trusted = true): void {
      const listener = add.mock.calls.find(([name]) => name === type)?.[1]
      if (listener === undefined || listener === null) throw new Error(`No listener for ${type}`)
      const event = new Proxy(new Event(type), {
        get: (target, key): unknown => key === 'isTrusted' ? trusted : Reflect.get(target, key),
      })
      act(() => {
        if (typeof listener === 'function') listener.call(document, event)
        else listener.handleEvent(event)
      })
    },
  }
}

function historyWindow(quietMs: number) { return new TranscriptWindow(quietMs, (commit) => { commit() }) }

function mount(node: ChatConversationViewNode, renderSlot: ComponentProps<typeof ChatNodeSeat>['renderSlot'],
  window = historyWindow(0), bottom = createSnapshotStore(false)) {
  const store = createChatStore().create()
  const view = render(<div data-chat-scroll=""><ChatNodeSeat
    nodeKey={node.key} transcriptWindow={window} nodeStore={chatNodeStore([node])}
    useChatNode={bindKeyedSnapshotSelector(() => createSnapshotStore(node))}
    useChatNodeProcess={bindKeyedSnapshotSelector(() => createSnapshotStore(undefined))}
    useChatNodeBottom={bindKeyedSnapshotSelector(() => bottom)}
    usePresentation={bindSnapshotSelector(createSnapshotStore(presentationPolicyFor('verbose', 'completion')))}
    useStore={bindSnapshotSelector(store)} actions={store.actions} deferCollapse={false}
    useGroupAction={() => useRef<HTMLDivElement>(null)} renderSlot={renderSlot} t={makeTranslate(en, common)}
    openFile={vi.fn()} inspectCall={undefined} forkAt={vi.fn()}
    loadImage={Object.assign(vi.fn(), { peek: () => undefined })} fileMentions={() => undefined}
  /></div>)
  return { view, window, bottom, row: view.container.querySelector<HTMLElement>('[data-chat-anchor-key]')! }
}

const reply = () => chatNode({ key: 'reply', data: settledAssistant({ text: 'public reply' }) })
const prose = () => <div data-slot="conversation.chat.node"><div><p>public reply</p></div></div>
const input = () => chatNode({ key: 'steer', kind: 'steering', data: { content: [{ type: 'text', text: 'synthetic-private-value' }], batchStart: true } })

function BodyHarness({ owner }: { owner: TranscriptWindow | undefined }) {
  const ref = useRef<HTMLDivElement>(null)
  const height = useChatBodyHeight(owner, ref, 80)
  return <div ref={ref}>{height === null
    ? <details><summary>Original body</summary>Stateful content</details>
    : <div data-placeholder="" style={{ height }} />}</div>
}

describe('progressive transcript bodies', () => {
  it('mounts latest-exchange participants immediately and keeps them mounted when the exchange advances', () => {
    vi.useFakeTimers()
    intersections()
    const idle = idleQueue()
    const first = mount(reply(), prose, historyWindow(500), createSnapshotStore(true))
    const body = first.row.querySelector('p')
    expect(first.row.textContent).toBe('public reply')
    act(() => { first.bottom.set(false) })
    expect(first.row.querySelector('p')).toBe(body)
    expect(idle.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    const promoted = mount(reply(), prose, historyWindow(500))
    expect(promoted.row.textContent).toBe('')
    act(() => { promoted.bottom.set(true) })
    expect(promoted.row.textContent).toBe('public reply')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('wraps both visible and idle mounts in the synchronous viewport transaction', () => {
    const { move } = intersections()
    const idle = idleQueue()
    const transitions: string[] = []
    const owner = new TranscriptWindow(0, (commit) => {
      transitions.push(`${first.textContent}|${second.textContent}`)
      commit()
      transitions.push(`${first.textContent}|${second.textContent}`)
    })
    const first = mount(reply(), prose, owner).row
    const second = mount(reply(), prose, owner).row
    move(second, true)
    idle.step()
    expect(transitions).toEqual(['|', '|public reply', '|public reply', 'public reply|public reply'])
  })

  it('waits for the configured opening quiet period without delaying visible rows', () => {
    vi.useFakeTimers()
    const { move } = intersections()
    const idle = idleQueue()
    const frames = animationFrames()
    const owner = historyWindow(500)
    const first = mount(reply(), prose, owner)
    const visible = mount(reply(), prose, owner)
    expect(idle.size).toBe(0)
    expect(vi.getTimerCount()).toBe(1)
    move(visible.row, true)
    expect(visible.row.textContent).toBe('public reply')
    act(() => { vi.advanceTimersByTime(499) })
    expect(frames.size).toBe(0)
    expect(first.row.textContent).toBe('')
    act(() => { vi.advanceTimersByTime(1) })
    frames.step(0)
    expect(idle.size).toBe(0)
    frames.step(16)
    idle.step()
    expect(first.row.textContent).toBe('public reply')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('restarts one quiet timer for input bursts and resumes automatically after the last gesture', () => {
    vi.useFakeTimers()
    intersections()
    const idle = idleQueue()
    const frames = animationFrames()
    const signals = interactionSignals()
    const { row } = mount(reply(), prose, historyWindow(500))
    for (const type of ['keydown', 'beforeinput', 'wheel', 'pointerdown']) {
      act(() => { vi.advanceTimersByTime(400) })
      signals.send(type)
      expect(vi.getTimerCount()).toBe(1)
      expect(idle.size).toBe(0)
      expect(frames.size).toBe(0)
      expect(row.textContent).toBe('')
    }
    act(() => { vi.advanceTimersByTime(499) })
    expect(frames.size).toBe(0)
    act(() => { vi.advanceTimersByTime(1) })
    frames.step(0)
    frames.step(16)
    idle.step()
    expect(row.textContent).toBe('public reply')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an obsolete opening timer and gives the new view its own quiet period', () => {
    vi.useFakeTimers()
    intersections()
    const idle = idleQueue()
    const frames = animationFrames()
    const old = mount(reply(), prose, historyWindow(500))
    act(() => { vi.advanceTimersByTime(250) })
    old.view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    const current = mount(reply(), prose, historyWindow(500))
    act(() => { vi.advanceTimersByTime(250) })
    expect(frames.size).toBe(0)
    expect(idle.size).toBe(0)
    act(() => { vi.advanceTimersByTime(250) })
    expect(frames.size).toBe(1)
    current.view.unmount()
    expect(frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('replaces a pending owner after a configuration change and honors zero without a timer', () => {
    vi.useFakeTimers()
    intersections()
    const idle = idleQueue()
    const frames = animationFrames()
    const view = render(<BodyHarness owner={historyWindow(500)} />)
    act(() => { vi.advanceTimersByTime(250) })
    view.rerender(<BodyHarness owner={historyWindow(0)} />)
    expect(vi.getTimerCount()).toBe(0)
    expect(frames.size).toBe(0)
    expect(idle.size).toBe(1)
    idle.step()
    expect(view.container.querySelector('details')?.textContent).toContain('Original body')
  })

  it('uses measured adaptive batches after foreground work is quiet', () => {
    intersections()
    const idle = idleQueue()
    const owner = historyWindow(0)
    let now = 0
    let layout = 3
    const renderer = vi.fn(() => { now += 2; return prose() })
    const rows = Array.from({ length: 16 }, () => mount(reply(), renderer, owner))
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    Object.defineProperty(rows[0]!.row.parentElement!, 'scrollHeight', { get: () => { now += layout; return 100 } })
    idle.step(20)
    expect(renderer).toHaveBeenCalledTimes(1)
    idle.step(20)
    expect(renderer).toHaveBeenCalledTimes(3)
    idle.step(20)
    expect(renderer).toHaveBeenCalledTimes(7)
    layout = 40
    idle.step(7)
    expect(renderer).toHaveBeenCalledTimes(9)
    idle.step(20)
    expect(renderer).toHaveBeenCalledTimes(13)
    for (const row of rows) row.view.unmount()
    expect(idle.size).toBe(0)
  })

  it('reflects a null renderer immediately after its commit before measuring layout', () => {
    intersections()
    const idle = idleQueue()
    const { row } = mount(reply(), () => <div data-slot="conversation.chat.node" />)
    const measured = vi.fn(() => {
      expect(row.hasAttribute('data-chat-row-empty')).toBe(true)
      return 100
    })
    Object.defineProperty(row.parentElement!, 'scrollHeight', { get: measured })
    idle.step()
    expect(row.hasAttribute('data-chat-row-empty')).toBe(true)
    expect(measured).toHaveBeenCalledOnce()
  })

  it.each(['beforeinput', 'keydown', 'wheel', 'pointerdown'])('lets trusted %s changes paint before resuming idle work', (type) => {
    intersections()
    const idle = idleQueue()
    const frames = animationFrames()
    const signals = interactionSignals()
    const { row } = mount(reply(), prose)
    signals.send(type, false)
    expect(idle.size).toBe(1)
    expect(frames.size).toBe(0)
    const late = idle.take()
    signals.send(type)
    late()
    expect(row.textContent).toBe('')
    expect(idle.size).toBe(0)
    frames.step(0)
    expect(idle.size).toBe(0)
    frames.step(16)
    expect(idle.size).toBe(1)
    idle.step()
    expect(row.textContent).toBe('public reply')
    expect(frames.size).toBe(0)
    for (const signal of ['beforeinput', 'keydown', 'wheel', 'pointerdown']) {
      expect(signals.remove.mock.calls.some(([name]) => name === signal)).toBe(true)
    }
  })

  it('coalesces input signals without delaying visible rows or reviving cancelled frames', () => {
    const { move } = intersections()
    const idle = idleQueue()
    const frames = animationFrames()
    const signals = interactionSignals()
    const first = mount(reply(), prose)
    const visible = mount(reply(), prose, first.window)
    signals.send('keydown')
    const stale = frames.take(0)
    signals.send('beforeinput')
    stale()
    expect(frames.size).toBe(1)
    move(visible.row, true)
    expect(visible.row.textContent).toBe('public reply')
    expect(first.row.textContent).toBe('')
    frames.step(1)
    signals.send('wheel')
    expect(frames.size).toBe(1)
    frames.step(2)
    expect(idle.size).toBe(0)
    frames.step(3)
    expect(idle.size).toBe(1)
    idle.step()
    expect(first.row.textContent).toBe('public reply')
    expect(frames.size).toBe(0)
  })

  it.each([0, 1])('cancels the input paint barrier at frame %s when its last row unmounts', (stage) => {
    intersections()
    const idle = idleQueue()
    const frames = animationFrames()
    const signals = interactionSignals()
    const { view } = mount(reply(), prose)
    signals.send('keydown')
    if (stage === 1) frames.step(0)
    const stale = frames.take(16)
    view.unmount()
    stale()
    expect(idle.size).toBe(0)
    expect(frames.size).toBe(0)
    expect(signals.remove.mock.calls.some(([name]) => name === 'keydown')).toBe(true)
  })

  it('uses one containing scrollport height of overscan, or the document viewport without one', () => {
    const { options } = intersections()
    const idle = idleQueue()
    const outer = document.createElement('div')
    outer.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(outer, 'clientHeight', { value: 450 })
    const inner = document.createElement('div')
    inner.setAttribute('data-chat-scroll', '')
    Object.defineProperty(inner, 'clientHeight', { value: 900 })
    const row = document.createElement('div')
    outer.append(inner)
    inner.append(row)
    const owner = historyWindow(0)
    const release = owner.observe(row, vi.fn())
    expect(options).toEqual([{ root: outer, rootMargin: '450px 0px' }])
    release()
    const releaseDetached = owner.observe(document.createElement('div'), vi.fn())
    expect(options.at(-1)).toEqual({ root: null, rootMargin: `${window.innerHeight}px 0px` })
    releaseDetached()
    expect(idle.size).toBe(0)
  })

  it('never defers an already eager body when newer rows take its place at the tail', () => {
    intersections()
    const idle = idleQueue()
    const view = render(<BodyHarness owner={undefined} />)
    const body = view.container.querySelector('details')!
    body.open = true
    view.rerender(<BodyHarness owner={historyWindow(0)} />)
    expect(view.container.querySelector('details')).toBe(body)
    expect(body.open).toBe(true)
    expect(view.container.querySelector('[data-placeholder]')).toBeNull()
    expect(idle.size).toBe(0)
  })

  it('mounts visible rows ahead of the idle queue and retains their exact DOM on exit', () => {
    const { move } = intersections()
    const idle = idleQueue()
    const first = mount(reply(), prose)
    const second = mount(reply(), prose, first.window)
    expect(first.row.textContent).toBe('')
    expect(second.row.textContent).toBe('')
    move(second.row, true)
    const text = second.row.querySelector('p')!
    expect(text.textContent).toBe('public reply')
    expect(first.row.textContent).toBe('')
    move(second.row, false)
    expect(second.row.querySelector('p')).toBe(text)
    idle.step()
    expect(first.row.textContent).toBe('public reply')
    expect(idle.size).toBe(0)
    expect(second.view.container.querySelector('[data-chat-anchor-key="reply"]')).toBe(second.row)
  })

  it('eventually mounts every offscreen body, yielding between original renderer commits', () => {
    const { move, disconnect } = intersections()
    const idle = idleQueue()
    const frames = animationFrames()
    const first = mount(reply(), prose)
    const second = mount(reply(), prose, first.window)
    const third = mount(reply(), prose, first.window)
    for (const item of [first, second, third]) move(item.row, false)
    expect(idle.size).toBe(1)
    idle.step()
    expect(first.row.textContent).toBe('public reply')
    expect(second.row.textContent).toBe('')
    expect(third.row.textContent).toBe('')
    idle.step()
    expect(second.row.textContent).toBe('public reply')
    expect(third.row.textContent).toBe('')
    idle.step()
    expect(third.row.textContent).toBe('public reply')
    expect(idle.size).toBe(0)
    expect(frames.size).toBe(0)
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('admits new rows while work is pending and after the previous queue drained', () => {
    intersections()
    const idle = idleQueue()
    const first = mount(reply(), prose)
    const second = mount(reply(), prose, first.window)
    idle.step()
    const third = mount(reply(), prose, first.window)
    idle.step()
    expect(second.row.textContent).toBe('public reply')
    expect(third.row.textContent).toBe('')
    idle.step()
    const fourth = mount(reply(), prose, first.window)
    expect(fourth.row.textContent).toBe('')
    idle.step()
    expect(fourth.row.textContent).toBe('public reply')
    expect(idle.size).toBe(0)
  })

  it('cancels obsolete idle and observer deliveries on unmount without touching the new flow', () => {
    const { move, disconnect } = intersections()
    const idle = idleQueue()
    const oldRenderer = vi.fn(prose)
    const old = mount(reply(), oldRenderer)
    const late = idle.take()
    old.view.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
    const current = mount(reply(), prose)
    late()
    move(old.row, true)
    expect(oldRenderer).not.toHaveBeenCalled()
    expect(current.row.textContent).toBe('')
    expect(idle.size).toBe(1)
    idle.step()
    expect(current.row.textContent).toBe('public reply')
  })

  it('removes one unmounted row without cancelling the remaining work', () => {
    intersections()
    const idle = idleQueue()
    const first = mount(reply(), prose)
    const second = mount(reply(), prose, first.window)
    first.view.unmount()
    expect(idle.size).toBe(1)
    idle.step()
    expect(second.row.textContent).toBe('public reply')
    const last = mount(reply(), prose, first.window)
    last.view.unmount()
    expect(idle.size).toBe(0)
  })

  it('retains selection, focus and opaque plugin state after leaving the viewport', () => {
    const { move } = intersections()
    idleQueue()
    const { row } = mount(reply(), () => <div><p>public reply</p><details><summary>Plugin detail</summary>Opaque state</details></div>)
    move(row, true)
    const text = row.querySelector('p')!.firstChild!
    const selection = document.getSelection()!
    selection.setBaseAndExtent(text, 1, text, 6)
    const detail = row.querySelector('details')!
    detail.open = true
    move(row, false)
    expect(selection.toString()).toBe('ublic')
    selection.removeAllRanges()
    row.tabIndex = -1
    row.focus()
    move(row, false)
    expect(row.querySelector('p')?.firstChild).toBe(text)
    expect(row.querySelector('details')).toBe(detail)
    expect(detail.open).toBe(true)
    expect(document.activeElement).toBe(row)
  })

  it('renders only original masked content and leaves native Find free of eager catch-up', () => {
    intersections()
    const idle = idleQueue()
    const { row } = mount(input(), () => <span>Masked</span>)
    expect(row.outerHTML).not.toContain('synthetic-private-value')
    expect(row.dataset.chatSteeringBatchStart).toBe('true')
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })
    fireEvent(row, event)
    expect(event.defaultPrevented).toBe(false)
    expect(row.textContent).toBe('')
    idle.step()
    expect(row.textContent).toBe('Masked')
    expect(row.outerHTML).not.toContain('synthetic-private-value')
  })

  it('keeps reasoning disclosures eager and renders eagerly without an observer', () => {
    const idle = idleQueue()
    const node = chatNode({ key: 'reason', data: { ...settledAssistant(), blocks: [{ kind: 'reasoning', text: 'thought' }] } })
    expect(mount(reply(), prose).row.textContent).toBe('public reply')
    intersections()
    expect(mount(node, () => <button>Reasoning</button>).row.textContent).toBe('Reasoning')
    expect(idle.size).toBe(0)
  })

  it('yields through a frame and task without idle callbacks, and cancels either stage', () => {
    intersections()
    vi.useFakeTimers()
    vi.stubGlobal('requestIdleCallback', undefined)
    let next = 0
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
    const frame = (): void => {
      const [id, callback] = frames.entries().next().value!
      frames.delete(id)
      act(() => { callback(0) })
    }
    const first = mount(reply(), prose)
    const second = mount(reply(), prose, first.window)
    frame()
    expect(first.row.textContent).toBe('')
    act(() => { vi.runOnlyPendingTimers() })
    expect(first.row.textContent).toBe('public reply')
    expect(second.row.textContent).toBe('')
    second.view.unmount()
    expect(frames.size).toBe(0)
    const third = mount(reply(), prose, first.window)
    frame()
    third.view.unmount()
    act(() => { vi.runOnlyPendingTimers() })
    expect(third.row.textContent).toBe('')
    expect(vi.getTimerCount()).toBe(0)
    expect(frames.size).toBe(0)
  })
})

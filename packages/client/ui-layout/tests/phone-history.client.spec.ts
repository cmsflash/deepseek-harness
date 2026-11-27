import { describe, expect, it, vi } from 'vitest'
import { phoneDepth, syncPhoneHistory, type PhoneHistoryTarget, type PhoneLayoutFacts } from '../src/client/phone-history.ts'

/** A window whose history is an in-memory entry stack with async traversal, like a browser's. */
function fakeWindow(initial: unknown = null) {
  const entries: unknown[] = [initial]
  let index = 0
  const listeners = new Set<() => void>()
  const pending: (() => void)[] = []
  const history = {
    get state() { return entries[index] },
    pushState: vi.fn((state: unknown) => {
      entries.splice(index + 1)
      entries.push(state)
      index += 1
    }),
    go: vi.fn((delta: number) => {
      pending.push(() => {
        index = Math.max(0, Math.min(entries.length - 1, index + delta))
        for (const listener of listeners) listener()
      })
    }),
  }
  const target: PhoneHistoryTarget = {
    history,
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener) },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener) },
  }
  return {
    window: target,
    history,
    depth: () => (entries[index] as { dshPhoneDepth?: number } | null)?.dshPhoneDepth ?? 0,
    length: () => entries.length,
    /** Deliver queued traversals, as the browser does after the current task. */
    flush: () => { while (pending.length > 0) pending.shift()!() },
    /** A platform back or forward action. */
    traverse: (delta: number) => { history.go(delta) },
    listenerCount: () => listeners.size,
  }
}

function fakeLayout(facts: PhoneLayoutFacts) {
  const listeners = new Set<() => void>()
  let state = facts
  const set = (patch: Partial<PhoneLayoutFacts>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  const dismissRightbar = vi.fn(() => { set({ rightbarShown: false }) })
  const willTraverse = vi.fn()
  return {
    host: {
      willTraverse,
      read: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      showList: (shown: boolean) => { set({ narrowExpanded: shown }) },
      dismissRightbar,
    },
    set,
    dismissRightbar,
    willTraverse,
    read: () => state,
  }
}

const LIST: PhoneLayoutFacts = { viewportWidth: 390, narrowExpanded: true, rightbarShown: false }

describe('phoneDepth', () => {
  it('maps the phone views to depths and the column layout to null', () => {
    expect(phoneDepth(LIST)).toBe(0)
    expect(phoneDepth({ ...LIST, narrowExpanded: false })).toBe(1)
    expect(phoneDepth({ ...LIST, narrowExpanded: false, rightbarShown: true })).toBe(2)
    expect(phoneDepth({ ...LIST, viewportWidth: 1280 })).toBeNull()
  })
})

describe('syncPhoneHistory', () => {
  it('pushes one entry per view opened and rewinds them when views close in the page', () => {
    const browser = fakeWindow({ app: 'kept' })
    const layout = fakeLayout(LIST)
    syncPhoneHistory(layout.host, browser.window)
    layout.set({ narrowExpanded: false })
    layout.set({ rightbarShown: true })
    expect(browser.depth()).toBe(2)
    expect(browser.history.state).toEqual({ app: 'kept', dshPhoneDepth: 2 })
    layout.set({ rightbarShown: false })
    expect(browser.history.go).toHaveBeenLastCalledWith(-1)
    browser.flush()
    expect(browser.depth()).toBe(1)
    layout.set({ narrowExpanded: true })
    browser.flush()
    expect(browser.depth()).toBe(0)
    expect(layout.dismissRightbar).not.toHaveBeenCalled()
    // Rewinds the page started itself change no view.
    expect(layout.willTraverse).not.toHaveBeenCalled()
  })

  it('closes the top view on a platform back action without rewinding twice', () => {
    const browser = fakeWindow()
    const layout = fakeLayout(LIST)
    syncPhoneHistory(layout.host, browser.window)
    layout.set({ narrowExpanded: false, rightbarShown: true })
    expect(browser.depth()).toBe(2)
    expect(browser.length()).toBe(3)
    browser.traverse(-1)
    browser.flush()
    expect(layout.dismissRightbar).toHaveBeenCalledOnce()
    expect(phoneDepth(layout.read())).toBe(1)
    browser.traverse(-1)
    browser.flush()
    expect(layout.read().narrowExpanded).toBe(true)
    expect(browser.history.go).toHaveBeenCalledTimes(2)
    expect(layout.willTraverse).toHaveBeenCalledTimes(2)
  })

  it('leaves the panel shown while the right panel reports its closing later', () => {
    const browser = fakeWindow()
    const layout = fakeLayout({ ...LIST, narrowExpanded: false, rightbarShown: true })
    layout.host.dismissRightbar = vi.fn()
    syncPhoneHistory(layout.host, browser.window)
    expect(browser.depth()).toBe(2)
    browser.traverse(-1)
    browser.flush()
    // An unrelated change before the panel reports must not push the entry back.
    layout.set({ viewportWidth: 380 })
    expect(browser.depth()).toBe(1)
    expect(browser.history.pushState).toHaveBeenCalledTimes(2)
  })

  it('jumps from the panel to the list in one traversal', () => {
    const browser = fakeWindow()
    const layout = fakeLayout({ ...LIST, narrowExpanded: false, rightbarShown: true })
    syncPhoneHistory(layout.host, browser.window)
    browser.traverse(-2)
    browser.flush()
    expect(layout.dismissRightbar).toHaveBeenCalledOnce()
    expect(layout.read().narrowExpanded).toBe(true)
    expect(browser.history.go).toHaveBeenCalledTimes(1)
  })

  it('reopens the conversation on a forward action from the list', () => {
    const browser = fakeWindow()
    const layout = fakeLayout(LIST)
    syncPhoneHistory(layout.host, browser.window)
    layout.set({ narrowExpanded: false })
    browser.traverse(-1)
    browser.flush()
    expect(layout.read().narrowExpanded).toBe(true)
    browser.traverse(1)
    browser.flush()
    expect(layout.read().narrowExpanded).toBe(false)
    expect(layout.willTraverse).toHaveBeenCalledTimes(2)
    expect(browser.length()).toBe(2)
  })

  it('keeps the entries a reload left while the restored views catch up', () => {
    const browser = fakeWindow({ dshPhoneDepth: 2 })
    const layout = fakeLayout({ ...LIST, narrowExpanded: false })
    syncPhoneHistory(layout.host, browser.window)
    layout.set({ rightbarShown: true })
    expect(browser.history.go).not.toHaveBeenCalled()
    expect(browser.history.pushState).not.toHaveBeenCalled()
  })

  it('ignores the column layout and treats unmarked or malformed entries as the list', () => {
    const browser = fakeWindow({ dshPhoneDepth: 'two' })
    const layout = fakeLayout({ ...LIST, viewportWidth: 1280, narrowExpanded: false })
    syncPhoneHistory(layout.host, browser.window)
    browser.traverse(0)
    browser.flush()
    expect(browser.history.pushState).not.toHaveBeenCalled()
    // Entering the phone layout on the conversation adds its entry.
    layout.set({ viewportWidth: 390 })
    expect(browser.depth()).toBe(1)
    layout.set({ viewportWidth: 1280 })
    layout.set({ narrowExpanded: true })
    browser.traverse(-1)
    browser.flush()
    expect(layout.read().narrowExpanded).toBe(true)
    expect(browser.history.go).toHaveBeenCalledTimes(2)
  })

  it('detaches on dispose without rewriting history', () => {
    const browser = fakeWindow()
    const layout = fakeLayout(LIST)
    const dispose = syncPhoneHistory(layout.host, browser.window)
    dispose()
    expect(browser.listenerCount()).toBe(0)
    layout.set({ narrowExpanded: false })
    expect(browser.history.pushState).not.toHaveBeenCalled()
  })
})

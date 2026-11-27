/**
 * Browser history for the phone layout's view stack: thread list (depth 0),
 * conversation (1), fullscreen right panel (2). Each level above the list owns
 * one history entry marked with its depth, so the platform's own back action
 * (Android's back button or gesture, Safari's edge swipe) pops one view.
 *
 * The browser's entry depth and the on-screen depth are reconciled on
 * transitions only. A rise in the on-screen depth pushes entries; a fall
 * rewinds the entries above it. A popstate that lands below the on-screen
 * depth asks the views to close, and the entries are left alone while they
 * catch up, because the right panel reports its closing a render later.
 * The first read and each entry into the phone layout only push: entries a
 * reload left above the on-screen depth stay, because the store restores the
 * conversation from the reloaded entry and the right panel restores itself
 * later.
 */
import { MOBILE_MAX } from './columns.ts'

/** `history.state` key holding the phone view depth of an entry. */
const DEPTH_KEY = 'dshPhoneDepth'

/** On-screen phone view depth. */
export type PhoneDepth = 0 | 1 | 2

/** Layout facts the phone view depth derives from. */
export interface PhoneLayoutFacts {
  viewportWidth: number
  narrowExpanded: boolean
  rightbarShown: boolean
}

/** Store access and view commands the history controller drives. */
export interface PhoneHistoryHost {
  /** Current layout facts. */
  read(): PhoneLayoutFacts
  /**
   * Subscribe to layout changes.
   * @param listener - called after each store change.
   * @returns the unsubscriber.
   */
  subscribe(listener: () => void): () => void
  /**
   * Select the thread list (true) or the conversation (false).
   * @param shown - whether the thread list is on screen.
   */
  showList(shown: boolean): void
  /** Close the right panel through its occupant, if one registered how. */
  dismissRightbar(): void
  /** Called before a platform back or forward action changes the view on screen. */
  willTraverse(): void
}

/** The parts of `window` the controller uses. */
export interface PhoneHistoryTarget {
  readonly history: Pick<History, 'state' | 'pushState' | 'go'>
  addEventListener(type: 'popstate', listener: () => void): void
  removeEventListener(type: 'popstate', listener: () => void): void
}

/**
 * Phone view depth for a layout, or null outside the phone layout.
 * @param facts - current layout facts.
 * @returns the depth, or null when the frame is a column layout.
 */
export function phoneDepth(facts: PhoneLayoutFacts): PhoneDepth | null {
  if (facts.viewportWidth > MOBILE_MAX) return null
  if (facts.narrowExpanded) return 0
  return facts.rightbarShown ? 2 : 1
}

/**
 * Depth recorded in a history entry's state; unmarked entries are the list.
 * @param state - a `history.state` value.
 * @returns the recorded depth, or 0.
 */
export function historyEntryDepth(state: unknown): number {
  if (typeof state !== 'object' || state === null || !(DEPTH_KEY in state)) return 0
  const depth = (state as Record<string, unknown>)[DEPTH_KEY]
  return typeof depth === 'number' ? depth : 0
}

/**
 * Keep `window.history` in step with the phone view stack.
 * @param host - store access and view commands.
 * @param target - window whose history and popstate events are used.
 * @returns the disposer, which detaches without rewriting history.
 */
export function syncPhoneHistory(host: PhoneHistoryHost, target: PhoneHistoryTarget): () => void {
  const history = target.history
  let previous: PhoneDepth | null = null

  const onLayout = (): void => {
    const depth = phoneDepth(host.read())
    const before = previous
    previous = depth
    if (depth === null) return
    const entries = historyEntryDepth(history.state)
    if (depth > (before ?? entries) && depth > entries) {
      const base = typeof history.state === 'object' && history.state !== null ? history.state as object : {}
      for (let level = entries + 1; level <= depth; level += 1) {
        history.pushState({ ...base, [DEPTH_KEY]: level }, '')
      }
    } else if (before !== null && depth < before && depth < entries) {
      history.go(depth - entries)
    }
  }

  const onPopState = (): void => {
    const depth = phoneDepth(host.read())
    if (depth === null) return
    const entries = historyEntryDepth(history.state)
    if (entries < depth) {
      host.willTraverse()
      if (depth === 2 && entries <= 1) host.dismissRightbar()
      if (entries === 0) host.showList(true)
    } else if (entries > depth && depth === 0) {
      host.willTraverse()
      host.showList(false)
    }
  }

  const unsubscribe = host.subscribe(onLayout)
  target.addEventListener('popstate', onPopState)
  onLayout()
  return () => {
    unsubscribe()
    target.removeEventListener('popstate', onPopState)
  }
}

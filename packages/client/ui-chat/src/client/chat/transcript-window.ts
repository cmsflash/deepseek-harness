/** Mount rich transcript bodies near the viewport first, then retain idle-mounted history. */
import { useEffect, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { updateFlowRowState } from './flow-row-state.ts'

/**
 * Reserve initial space until the renderer supplies its natural height.
 * @param node - projected row, absent while its keyed source is unavailable.
 * @param groupPart - selected portion, or undefined for the whole node.
 * @returns estimated pixels for deferred text, or null for eager content.
 */
export function estimateChatBody(node: ChatNode | undefined, groupPart: string | undefined): number | null {
  if (node?.kind === 'steering' || node?.kind === 'user') {
    const length = node.data.content.reduce((n, block) => n + (block.type === 'text' ? block.text.length : 0), 0)
    return 44 + 22 * Math.max(1, Math.ceil(length / 72))
  }
  if (node?.kind !== 'assistant-step' || node.data.status !== 'settled' || groupPart === 'reasoning') return null
  let length = 0
  for (const block of node.data.blocks) {
    if (block.kind === 'text') length += block.text.length
    else if (block.kind !== 'tool-call' && !(block.kind === 'reasoning' && groupPart === 'response')) return null
  }
  return length === 0 ? null : 24 * Math.ceil(length / 96)
}

/** Owns deferred mounts for one flow; scrolling remains owned by ChatViewport. */
export class TranscriptWindow {
  private readonly rows = new Map<Element, () => void>()
  private observer: IntersectionObserver | null = null
  private cancelWork: (() => void) | null = null
  private detachInteractions: (() => void) | null = null
  private layoutRoot: Element | null = null
  private sample: { rows: number; commit: number; layout: number } | null = null

  /**
   * @param quietMs - validated foreground quiet delay; zero skips the timer.
   * @param commitHistory - viewport-owned transaction that executes each body commit synchronously once.
   */
  constructor(private readonly quietMs: number, private readonly commitHistory: (commit: () => void) => void) {}

  /**
   * Expose viewport-observation availability for this flow.
   * @returns whether viewport observations are available; otherwise render eagerly.
   */
  get enabled(): boolean { return typeof IntersectionObserver === 'function' }

  private mount(row: Element): void {
    const update = this.rows.get(row)
    if (update === undefined) return
    this.rows.delete(row)
    this.observer?.unobserve(row)
    update()
  }

  private readonly yieldToInput = (event: Event): void => {
    if (event.isTrusted && this.rows.size > 0) this.waitForQuiet()
  }

  private waitForQuiet(): void {
    this.cancelWork?.()
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let frame: number | null = null
    const paint = (): void => {
      if (cancelled) return
      // The second callback follows a rendering opportunity for foreground changes.
      frame = requestAnimationFrame(() => {
        if (cancelled) return
        frame = requestAnimationFrame(() => {
          if (cancelled) return
          this.cancelWork = null
          this.schedule()
        })
      })
    }
    if (this.quietMs === 0) paint()
    else timer = setTimeout(paint, this.quietMs)
    this.cancelWork = () => {
      cancelled = true
      clearTimeout(timer)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }

  private schedule(): void {
    if (this.cancelWork !== null || this.rows.size === 0) return
    let cancelled = false
    const run = (deadline?: IdleDeadline): void => {
      if (cancelled) return
      this.cancelWork = null
      const sample = this.sample
      const remaining = deadline?.timeRemaining() ?? 0
      const layout = sample?.layout ?? 0
      const budget = remaining > layout ? remaining - layout : remaining
      const affordable = sample === null || sample.commit === 0 ? Infinity : Math.floor(budget * sample.rows / sample.commit)
      // Bound extrapolation from cheap rows; a single expensive renderer remains indivisible.
      const limit = sample === null || budget === 0 ? 1 : Math.max(1, Math.min(sample.rows * 2, affordable))
      const root = this.layoutRoot
      const started = performance.now()
      let rendererTime = 0
      let mounted = 0
      this.commitHistory(() => {
        const renderStarted = performance.now()
        const changed: Element[] = []
        flushSync(() => {
          for (const row of this.rows.keys()) {
            changed.push(row)
            this.mount(row)
            if (++mounted >= limit) break
          }
        })
        for (const row of changed) updateFlowRowState(row)
        rendererTime = performance.now() - renderStarted
      })
      // Shared layout and anchor compensation can exceed the renderer allowance.
      if (root !== null) void root.scrollHeight
      this.sample = { rows: mounted, commit: rendererTime, layout: performance.now() - started - rendererTime }
      this.releaseIfEmpty()
      this.schedule()
    }
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(run)
      this.cancelWork = () => { cancelled = true; cancelIdleCallback(id) }
    } else {
      let task: ReturnType<typeof setTimeout> | undefined
      const frame = requestAnimationFrame(() => {
        if (!cancelled) task = setTimeout(run, 0)
      })
      this.cancelWork = () => {
        cancelled = true
        cancelAnimationFrame(frame)
        clearTimeout(task)
      }
    }
  }

  private releaseIfEmpty(): void {
    if (this.rows.size !== 0) return
    this.cancelWork?.()
    this.cancelWork = null
    this.detachInteractions?.()
    this.detachInteractions = null
    this.observer?.disconnect()
    this.observer = null
    this.layoutRoot = null
  }

  /**
   * Prioritize an intersecting row over the idle queue, without ever recycling its renderer.
   * @param row - stable seat inside the Chat scrollport.
   * @param update - mount the original renderer once.
   * @returns release that cancels this row's pending work; the last release stops the scheduler.
   */
  observe(row: HTMLElement, update: () => void): () => void {
    if (!this.enabled) { update(); return () => {} }
    const starting = this.observer === null
    if (this.observer === null) {
      const root = row.closest('[data-conversation-scroll]') ?? row.closest('[data-chat-scroll]')
      const doc = row.ownerDocument
      this.layoutRoot = root ?? doc.documentElement
      const signals = ['beforeinput', 'keydown', 'wheel', 'pointerdown'] as const
      for (const type of signals) doc.addEventListener(type, this.yieldToInput, { capture: true, passive: true })
      this.detachInteractions = () => {
        for (const type of signals) doc.removeEventListener(type, this.yieldToInput, true)
      }
      const margin = root === null ? window.innerHeight : root.clientHeight
      const observer = new IntersectionObserver((entries) => {
        if (this.observer !== observer) return
        const visible = entries.filter(entry => entry.isIntersecting && this.rows.has(entry.target))
        if (visible.length === 0) return
        this.commitHistory(() => {
          flushSync(() => { for (const entry of visible) this.mount(entry.target) })
          for (const entry of visible) updateFlowRowState(entry.target)
        })
        this.releaseIfEmpty()
      }, { root, rootMargin: `${margin}px 0px` })
      this.observer = observer
    }
    this.rows.set(row, update)
    this.observer.observe(row)
    if (starting && this.quietMs > 0) this.waitForQuiet()
    else this.schedule()
    return () => {
      this.rows.delete(row)
      this.observer?.unobserve(row)
      this.releaseIfEmpty()
    }
  }
}

/**
 * Reserve an unvisited row's estimated height until its original renderer mounts permanently.
 * @param owner - the flow scheduler, absent for nested groups and the eager tail.
 * @param ref - the persistent anchor used by fold and paging.
 * @param estimate - initial height, or null for an always-mounted renderer.
 * @returns placeholder height, or null to use the original renderer.
 */
export function useChatBodyHeight(
  owner: TranscriptWindow | undefined, ref: RefObject<HTMLDivElement>, estimate: number | null,
): number | null {
  const enabled = estimate !== null && owner?.enabled === true
  const [mounted, setMounted] = useState(() => !enabled)
  if (!enabled && !mounted) setMounted(true)
  useEffect(() => {
    const row = ref.current
    if (!enabled || mounted || row === null) return
    return owner.observe(row, () => { setMounted(true) })
  }, [enabled, mounted, owner, ref])
  return enabled && !mounted ? estimate : null
}

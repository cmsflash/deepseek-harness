// @vitest-environment jsdom
/**
 * The collapsed-steps row: what it reports about the hidden work, and the
 * disclosure control that opens and re-folds the group.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { CollapsedStepsRow, type CollapsedStepsRowProps } from '../src/client/chat/CollapsedStepsRow.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh) as CollapsedStepsRowProps['t']

function row(overrides: Partial<CollapsedStepsRowProps> = {}) {
  const props: CollapsedStepsRowProps = {
    turn: 3,
    metrics: { steps: 12, calls: 15, files: 2, added: 40, removed: 7, elapsedMs: 0, inputTokens: 0, outputTokens: 0 },
    expanded: false,
    onToggle: vi.fn(),
    renderSlot: () => null,
    t,
    ...overrides,
  }
  return { view: render(<CollapsedStepsRow {...props} />), props }
}

describe('CollapsedStepsRow', () => {
  it('reports the hidden steps, calls, edit volume, and files', () => {
    const { view } = row()
    const text = view.container.textContent ?? ''
    expect(text).toContain('12 步')
    expect(text).toContain('15 次调用')
    expect(text).toContain('+40')
    expect(text).toContain('-7 行')
    expect(text).toContain('2 个文件')
  })

  it('omits the edit group when the collapsed steps changed no lines', () => {
    const { view } = row({ metrics: { steps: 4, calls: 2, files: 0, added: 0, removed: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0 } })
    const text = view.container.textContent ?? ''
    expect(text).toContain('4 步')
    expect(text).toContain('2 次调用')
    expect(text).not.toContain('个文件')
  })

  it('shows only the step count when nothing else happened', () => {
    const { view } = row({ metrics: { steps: 1, calls: 0, files: 0, added: 0, removed: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0 } })
    expect(view.container.textContent).toBe('1 步')
  })

  it('reports elapsed time and token spend when the hidden steps recorded them', () => {
    const { view } = row({
      metrics: {
        steps: 3, calls: 2, files: 0, added: 0, removed: 0,
        elapsedMs: 65_000, inputTokens: 1_500, outputTokens: 200,
      },
    })
    const text = view.container.textContent ?? ''
    expect(text).toContain('1m5s')
    expect(text).toContain('1.7K tokens')
  })

  it('leads with the bare duration', () => {
    const { view } = row({
      metrics: {
        steps: 3, calls: 2, files: 0, added: 0, removed: 0,
        elapsedMs: 65_000, inputTokens: 1_500, outputTokens: 200,
      },
    })
    expect((view.container.textContent ?? '').startsWith('1m5s')).toBe(true)
  })

  it('drops the step count for a turn whose hidden work is all tool calls', () => {
    // A tool-only group settles no assistant node before the last step, so a
    // literal "0 steps" would misdescribe what is hidden.
    const { view } = row({ metrics: { steps: 0, calls: 5, files: 0, added: 0, removed: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0 } })
    expect(view.container.textContent).toBe('5 次调用')
  })

  it('renders contributed figures after every built-in one', () => {
    const { view } = row({
      metrics: {
        steps: 3, calls: 2, files: 0, added: 0, removed: 0,
        elapsedMs: 65_000, inputTokens: 1_500, outputTokens: 200,
      },
      renderSlot: ((key: string) => (key === 'conversation.chat.collapsedMetric'
        ? <span>$0.42</span>
        : null)) as unknown as CollapsedStepsRowProps['renderSlot'],
    })
    const text = view.container.textContent ?? ''
    expect(text.endsWith('$0.42')).toBe(true)
    // The built-ins keep their own order ahead of it.
    expect(text.indexOf('1m5s')).toBeLessThan(text.indexOf('$0.42'))
    expect(text.indexOf('1.7K tokens')).toBeLessThan(text.indexOf('$0.42'))
  })

  it('passes the collapsed group identity to contributors', () => {
    let seen: unknown = null
    row({
      turn: 7,
      metrics: { steps: 4, calls: 9, files: 0, added: 0, removed: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0 },
      renderSlot: ((_key: string, owner: unknown) => { seen = owner; return null }) as unknown as CollapsedStepsRowProps['renderSlot'],
    })
    expect(seen).toEqual({ turn: 7, steps: 4, calls: 9 })
  })

  it('exposes its disclosure state and reports each toggle', () => {
    const { view, props } = row()
    const button = view.getByRole('button')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    button.click()
    expect(props.onToggle).toHaveBeenCalledTimes(1)
    cleanup()

    const opened = row({ expanded: true })
    expect(opened.view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
  })

  it('carries its turn for the surrounding flow', () => {
    const { view } = row({ turn: 9 })
    expect(view.container.querySelector('[data-collapsed-turn="9"]')).not.toBeNull()
  })
})

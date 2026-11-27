// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeFlowRowState, updateFlowRowState } from '../src/client/chat/flow-row-state.ts'
import { ChatViewport } from '../src/client/chat/use-chat-viewport.ts'

const releases: (() => void)[] = []
afterEach(() => { for (const release of releases.splice(0)) release(); vi.restoreAllMocks() })

function watch(markup = '<div data-chat-flow-key="row"><div data-slot="conversation.chat.node"></div></div>') {
  const column = document.createElement('div')
  column.innerHTML = markup
  document.body.append(column)
  const { flush, dispose } = observeFlowRowState(column)
  releases.push(() => { dispose(); column.remove() })
  return { column, flush, dispose, row: column.querySelector<HTMLElement>('[data-chat-flow-key]')! }
}

function expectEquivalent(row: Element): void {
  const slot = ':scope > [data-slot="conversation.chat.node"]'
  expect(row.hasAttribute('data-chat-row-self-empty')).toBe(row.matches(':empty'))
  expect(row.hasAttribute('data-chat-row-empty')).toBe(row.matches(':empty') || row.querySelector(`${slot}:empty`) !== null)
  expect(row.hasAttribute('data-chat-row-steering')).toBe(row.querySelector(`${slot} > [data-chat-steering-batch]`) !== null)
  expect(row.hasAttribute('data-chat-row-steering-start')).toBe(row.querySelector(`${slot} > [data-chat-steering-batch="start"]`) !== null)
}

describe('flow row DOM state', () => {
  it('flushes pending DOM transitions synchronously before layout effects and remains inert after disposal', () => {
    const { row, flush, dispose } = watch()
    const slot = row.firstElementChild!
    const marker = document.createElement('p')
    marker.dataset.chatSteeringBatch = 'start'
    slot.append(marker)
    expect(row.hasAttribute('data-chat-row-empty')).toBe(true)
    flush()
    expect(row.hasAttribute('data-chat-row-empty')).toBe(false)
    expect(row.hasAttribute('data-chat-row-steering-start')).toBe(true)
    slot.replaceChildren()
    expect(row.hasAttribute('data-chat-row-empty')).toBe(false)
    flush()
    expectEquivalent(row)
    expect(row.hasAttribute('data-chat-row-empty')).toBe(true)
    dispose()
    slot.append(document.createComment('empty renderer'))
    flush()
    expect(row.hasAttribute('data-chat-row-empty')).toBe(false)
  })

  it('matches direct slot emptiness without treating comments, whitespace or nested empty elements differently', () => {
    const { column } = watch([
      '<div data-chat-flow-key="empty"></div>',
      '<div data-chat-flow-key="comment"><!--retained--></div>',
      '<div data-chat-flow-key="space"> </div>',
      '<div data-chat-flow-key="slot"><div data-slot="conversation.chat.node"><!--null renderer--></div></div>',
      '<div data-chat-flow-key="nested"><div data-slot="conversation.chat.node"><div></div></div></div>',
      '<div data-chat-flow-key="other"><div data-slot="other"></div></div>',
    ].join(''))
    for (const row of column.children) expectEquivalent(row)
    expect(column.children[0]!.hasAttribute('data-chat-row-empty')).toBe(true)
    expect(column.children[3]!.hasAttribute('data-chat-row-empty')).toBe(true)
    expect(column.children[4]!.hasAttribute('data-chat-row-empty')).toBe(false)
    expect(column.children[5]!.hasAttribute('data-chat-row-empty')).toBe(false)
  })

  it('follows arbitrary null-to-content renderers and direct text changes', async () => {
    const { row } = watch()
    const slot = row.firstElementChild!
    const text = document.createTextNode('')
    slot.append(text)
    await Promise.resolve()
    expectEquivalent(row)
    text.data = 'Rendered text'
    await Promise.resolve()
    expect(row.hasAttribute('data-chat-row-empty')).toBe(false)
    text.data = ''
    await Promise.resolve()
    expectEquivalent(row)
    text.remove()
    await Promise.resolve()
    expect(row.hasAttribute('data-chat-row-empty')).toBe(true)
    slot.removeAttribute('data-slot')
    await Promise.resolve()
    expect(row.hasAttribute('data-chat-row-empty')).toBe(false)
    slot.setAttribute('data-slot', 'conversation.chat.node')
    await Promise.resolve()
    expect(row.hasAttribute('data-chat-row-empty')).toBe(true)
    slot.remove()
    await Promise.resolve()
    expectEquivalent(row)
    row.append(document.createTextNode('Direct text'))
    await Promise.resolve()
    expect(row.hasAttribute('data-chat-row-empty')).toBe(false)
  })

  it('tracks only direct rendered steering markers, including attribute changes and mixed marker values', async () => {
    const { row } = watch()
    const slot = row.firstElementChild!
    const marker = document.createElement('div')
    slot.append(marker)
    marker.setAttribute('data-chat-steering-batch', 'start')
    await Promise.resolve()
    expectEquivalent(row)
    expect(row.hasAttribute('data-chat-row-steering-start')).toBe(true)
    marker.setAttribute('data-chat-steering-batch', '')
    await Promise.resolve()
    expect(row.hasAttribute('data-chat-row-steering')).toBe(true)
    expect(row.hasAttribute('data-chat-row-steering-start')).toBe(false)
    const another = marker.cloneNode() as Element
    another.setAttribute('data-chat-steering-batch', 'start')
    slot.append(another)
    await Promise.resolve()
    expect(row.hasAttribute('data-chat-row-steering-start')).toBe(true)
    marker.removeAttribute('data-chat-steering-batch')
    marker.append(another)
    await Promise.resolve()
    expectEquivalent(row)
    expect(row.hasAttribute('data-chat-row-steering')).toBe(false)
  })

  it('does not rewrite unchanged flags or inspect a row for deep renderer edits', async () => {
    const { row } = watch('<div data-chat-flow-key="row"><div data-slot="conversation.chat.node"><section><p>Text</p></section></div></div>')
    const matches = vi.spyOn(row, 'matches')
    const toggle = vi.spyOn(row, 'toggleAttribute')
    row.querySelector('p')!.textContent = 'Streamed text'
    await Promise.resolve()
    expect(matches).not.toHaveBeenCalled()
    const slot = row.firstElementChild!
    slot.replaceChildren(document.createElement('article'))
    await Promise.resolve()
    expect(matches).toHaveBeenCalled()
    expect(toggle).not.toHaveBeenCalled()
    row.removeChild(slot)
    row.append(slot)
    await Promise.resolve()
    expect(toggle).not.toHaveBeenCalled()
    expectEquivalent(row)
  })

  it('initializes rows added inside groups and ignores detached rows', async () => {
    const { column } = watch('')
    const group = document.createElement('section')
    group.innerHTML = '<div data-chat-flow-key="nested"><div data-slot="conversation.chat.node"></div></div>'
    column.append(group)
    await Promise.resolve()
    const row = group.firstElementChild!
    expect(row.hasAttribute('data-chat-row-empty')).toBe(true)
    row.firstElementChild!.append(document.createElement('p'))
    group.remove()
    await Promise.resolve()
    expect(row.hasAttribute('data-chat-row-empty')).toBe(true)
  })

  it('synchronizes a commit before measurements and does not revive disposed observations', async () => {
    const { row, dispose } = watch()
    row.firstElementChild!.append(document.createElement('p'))
    updateFlowRowState(row)
    expect(row.hasAttribute('data-chat-row-empty')).toBe(false)
    row.firstElementChild!.replaceChildren()
    dispose()
    await Promise.resolve()
    expect(row.hasAttribute('data-chat-row-empty')).toBe(false)
    row.firstElementChild!.append(document.createComment('still empty'))
    await Promise.resolve()
    expect(row.hasAttribute('data-chat-row-empty')).toBe(false)
  })

  it('binds observation and flag cleanup to the viewport attachment', async () => {
    const column = document.createElement('div')
    column.innerHTML = '<div data-chat-flow-key="empty"></div>'
    document.body.append(column)
    const viewport = new ChatViewport()
    releases.push(() => { viewport.detach(); column.remove() })
    viewport.attach(column, column)
    const row = column.firstElementChild!
    expect(row.hasAttribute('data-chat-row-empty')).toBe(true)
    viewport.detach()
    expect(row.hasAttribute('data-chat-row-empty')).toBe(false)
    row.append(document.createComment('unobserved'))
    await Promise.resolve()
    expect(row.hasAttribute('data-chat-row-empty')).toBe(false)
  })
})

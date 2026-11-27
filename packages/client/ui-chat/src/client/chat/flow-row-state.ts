/** Reflect direct renderer DOM state on rows without descendant-dependent sibling CSS selectors. */
const ROW = '[data-chat-flow-key]'
const SLOT = '[data-slot="conversation.chat.node"]'
const FLAGS = ['data-chat-row-empty', 'data-chat-row-self-empty', 'data-chat-row-steering', 'data-chat-row-steering-start'] as const

function flag(row: Element, name: typeof FLAGS[number], value: boolean): void {
  if (row.hasAttribute(name) !== value) row.toggleAttribute(name, value)
}

/**
 * Synchronize one row before measuring a renderer commit; arbitrary empty renderers stay empty.
 * @param row - stable Chat seat whose direct slot DOM is committed.
 */
export function updateFlowRowState(row: Element): void {
  const selfEmpty = row.matches(':empty')
  flag(row, 'data-chat-row-self-empty', selfEmpty)
  flag(row, 'data-chat-row-empty', selfEmpty || row.querySelector(`:scope > ${SLOT}:empty`) !== null)
  flag(row, 'data-chat-row-steering', row.querySelector(`:scope > ${SLOT} > [data-chat-steering-batch]`) !== null)
  flag(row, 'data-chat-row-steering-start', row.querySelector(`:scope > ${SLOT} > [data-chat-steering-batch="start"]`) !== null)
}

/**
 * Track row and immediate slot contents, including text-node and renderer-marker changes.
 * @param column - viewport-owned flow column, including any nested Chat groups.
 * @returns a synchronous pre-measurement flush and a disposer for observations and owned flags.
 */
export function observeFlowRowState(column: HTMLElement): { flush: () => void; dispose: () => void } {
  let disposed = false
  const update = (records: readonly MutationRecord[]): void => {
    if (disposed || records.length === 0) return
    const changed = new Set<Element>()
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement
      if (target === null) continue
      const parent = target.parentElement
      if (target.matches(ROW)) changed.add(target)
      else if (parent?.matches(ROW) && (target.matches(SLOT) || record.attributeName === 'data-slot')) changed.add(parent)
      else if (record.attributeName === 'data-chat-steering-batch' && parent?.matches(SLOT)
        && parent.parentElement?.matches(ROW)) changed.add(parent.parentElement)
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        if (node.matches(ROW)) changed.add(node)
        for (const row of node.querySelectorAll(ROW)) changed.add(row)
      }
    }
    for (const row of changed) if (column.contains(row)) updateFlowRowState(row)
  }
  const observer = new MutationObserver(update)
  for (const row of column.querySelectorAll(ROW)) updateFlowRowState(row)
  observer.observe(column, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['data-slot', 'data-chat-steering-batch'],
  })
  return {
    flush: () => { update(observer.takeRecords()) },
    dispose: () => {
      disposed = true
      observer.disconnect()
      for (const row of column.querySelectorAll(ROW)) for (const name of FLAGS) row.removeAttribute(name)
    },
  }
}

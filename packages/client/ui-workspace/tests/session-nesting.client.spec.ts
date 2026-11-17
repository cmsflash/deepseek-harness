import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  nestedRows, nestingAncestorIds, nestSessions,
  type NestableRow, type NestedSession, type SessionParents,
} from '../src/client/session-nesting.ts'

const sid = (id: string) => id as SessionId
const row = (id: string, blank = false): NestableRow => ({ id: sid(id), blank })
const rowsOf = (...ids: string[]) => ids.map(id => row(id))
const links = (pairs: Record<string, string>) => pairs as SessionParents
const ids = (entries: readonly NestedSession<NestableRow>[]) => entries.map(entry => entry.row.id)
const outline = (entries: readonly NestedSession<NestableRow>[]): string[] => entries.flatMap(entry => [
  `${'  '.repeat(entry.depth)}${entry.row.id}`, ...outline(entry.children),
])

describe('nestSessions', () => {
  it('keeps every row a root in list order when there are no links', () => {
    const nesting = nestSessions(rowsOf('c', 'a', 'b'), {}, {})
    expect(outline(nesting.roots)).toEqual(['c', 'a', 'b'])
    expect(nesting.roots.every(entry => entry.depth === 0 && entry.childCount === 0 && entry.expanded)).toBe(true)
    expect(nesting.parents.size).toBe(0)
  })

  it('nests to any depth', () => {
    const nesting = nestSessions(rowsOf('a', 'b', 'c'), links({ b: 'a', c: 'b' }), {})
    expect(outline(nesting.roots)).toEqual(['a', '  b', '    c'])
    expect([...nesting.parents]).toEqual([['b', 'a'], ['c', 'b']])
  })

  it('nests a child listed before its parent and keeps the parent in its own place', () => {
    const nesting = nestSessions(rowsOf('x', 'child', 'parent', 'y'), links({ child: 'parent' }), {})
    expect(outline(nesting.roots)).toEqual(['x', 'parent', '  child', 'y'])
  })

  it('keeps children in list order', () => {
    const nesting = nestSessions(rowsOf('c2', 'p', 'c1'), links({ c1: 'p', c2: 'p' }), {})
    expect(ids(nesting.roots)).toEqual(['p'])
    expect(ids(nesting.roots[0]!.children)).toEqual(['c2', 'c1'])
    expect(nesting.roots[0]!.childCount).toBe(2)
  })

  it('leaves a row whose parent is absent from the list a root at its own position', () => {
    const nesting = nestSessions(rowsOf('a', 'child', 'b'), links({ child: 'gone' }), {})
    expect(outline(nesting.roots)).toEqual(['a', 'child', 'b'])
    expect(nesting.parents.size).toBe(0)
  })

  it('does not re-attach a row to its grandparent when its parent is absent', () => {
    const nesting = nestSessions(
      rowsOf('grand', 'child', 'leaf'), links({ hidden: 'grand', child: 'hidden', leaf: 'child' }), {},
    )
    expect(outline(nesting.roots)).toEqual(['grand', 'child', '  leaf'])
    expect([...nesting.parents]).toEqual([['leaf', 'child']])
  })

  it('ignores a self link', () => {
    const nesting = nestSessions(rowsOf('a', 'b'), links({ a: 'a' }), {})
    expect(outline(nesting.roots)).toEqual(['a', 'b'])
    expect(nesting.parents.size).toBe(0)
  })

  it('keeps both rows of a cycle roots and still nests a row linked into the cycle', () => {
    const rows = rowsOf('a', 'b', 'c')
    const nesting = nestSessions(rows, links({ a: 'b', b: 'a', c: 'a' }), {})
    expect(outline(nesting.roots)).toEqual(['a', '  c', 'b'])
    expect([...nesting.parents]).toEqual([['c', 'a']])
    expect(nestedRows(nesting.roots)).toHaveLength(rows.length)
  })

  it('keeps a linked blank row a root and nests nothing under a blank row', () => {
    const nesting = nestSessions(
      [row('new', true), row('a'), row('b')], links({ new: 'a', b: 'new' }), {},
    )
    expect(outline(nesting.roots)).toEqual(['new', 'a', 'b'])
    expect(nesting.parents.size).toBe(0)
  })

  it('builds no children under a collapsed row but still counts them', () => {
    const nesting = nestSessions(
      rowsOf('p', 'c1', 'c2', 'g', 'other'), links({ c1: 'p', c2: 'p', g: 'c1' }), { p: false },
    )
    expect(outline(nesting.roots)).toEqual(['p', 'other'])
    expect(nesting.roots[0]).toMatchObject({ expanded: false, childCount: 2, children: [] })
    expect(nestedRows(nesting.roots)).toHaveLength(2)
    expect(nesting.parents.get(sid('g'))).toBe('c1')
  })

  it('reads a saved true and an absent entry as expanded', () => {
    const nesting = nestSessions(rowsOf('p', 'c', 'q', 'd'), links({ c: 'p', d: 'q' }), { p: true })
    expect(nesting.roots.map(entry => entry.expanded)).toEqual([true, true])
    expect(outline(nesting.roots)).toEqual(['p', '  c', 'q', '  d'])
  })

  it('does not mutate its inputs', () => {
    const rows = Object.freeze(rowsOf('c', 'p').map(entry => Object.freeze(entry)))
    const sessionParents = Object.freeze(links({ c: 'p' }))
    const expansion = Object.freeze({ p: true })
    expect(outline(nestSessions(rows, sessionParents, expansion).roots)).toEqual(['p', '  c'])
    expect(rows.map(entry => entry.id)).toEqual(['c', 'p'])
    expect(sessionParents).toEqual({ c: 'p' })
  })
})

describe('nestingAncestorIds', () => {
  const { parents } = nestSessions(rowsOf('a', 'b', 'c'), links({ b: 'a', c: 'b' }), {})

  it('returns ancestors nearest first', () => {
    expect(nestingAncestorIds(sid('c'), parents)).toEqual(['b', 'a'])
  })

  it('returns nothing for a root or an unknown id', () => {
    expect(nestingAncestorIds(sid('a'), parents)).toEqual([])
    expect(nestingAncestorIds(sid('unknown'), parents)).toEqual([])
  })

  it('ends on links that form a cycle or point at the row itself', () => {
    const cyclic = new Map([[sid('a'), sid('b')], [sid('b'), sid('c')], [sid('c'), sid('b')], [sid('self'), sid('self')]])
    expect(nestingAncestorIds(sid('a'), cyclic)).toEqual(['b', 'c'])
    expect(nestingAncestorIds(sid('b'), cyclic)).toEqual(['c'])
    expect(nestingAncestorIds(sid('self'), cyclic)).toEqual([])
  })
})

describe('nestedRows', () => {
  it('lists rendered rows in display order and leaves out rows under a collapsed row', () => {
    const rows = rowsOf('x', 'a', 'b', 'c', 'd')
    const sessionParents = links({ b: 'a', c: 'b', d: 'a' })
    expect(nestedRows(nestSessions(rows, sessionParents, {}).roots).map(entry => entry.id)).toEqual(['x', 'a', 'b', 'c', 'd'])
    expect(nestedRows(nestSessions(rows, sessionParents, { b: false }).roots).map(entry => entry.id)).toEqual(['x', 'a', 'b', 'd'])
    expect(nestedRows([])).toEqual([])
  })
})

describe('a parent chain 10,000 deep', () => {
  const depth = 10_000
  const rows = Array.from({ length: depth }, (_, index) => row(`s${String(index)}`))
  const chain = links(Object.fromEntries(rows.slice(1).map((child, index) => [child.id, `s${String(index)}`])))

  it('nests, flattens and walks without exhausting the call stack', () => {
    const nesting = nestSessions(rows, chain, {})
    expect(nesting.roots.map(entry => entry.row.id)).toEqual(['s0'])
    const flat = nestedRows(nesting.roots)
    expect(flat).toHaveLength(depth)
    expect(flat.at(-1)?.id).toBe(`s${String(depth - 1)}`)
    let deepest = nesting.roots[0]
    while (deepest?.children[0] !== undefined) deepest = deepest.children[0]
    expect(deepest?.depth).toBe(depth - 1)
    expect(nestingAncestorIds(sid(`s${String(depth - 1)}`), nesting.parents)).toHaveLength(depth - 1)
  })

  it('keeps every row of a cycle that long at the top level', () => {
    const nesting = nestSessions(rows, links({ ...chain, s0: `s${String(depth - 1)}` }), {})
    expect(nesting.roots).toHaveLength(depth)
    expect(nesting.parents.size).toBe(0)
  })
})

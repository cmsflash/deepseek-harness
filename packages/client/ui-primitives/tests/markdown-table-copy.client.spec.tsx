// @vitest-environment jsdom
// The markdown table's copy-as-markdown control: what it writes (canonical
// GFM, not the authored spacing), when it is withheld (streaming, and cells
// the serializer cannot handle), and the confirmation window it shares with
// the other copy affordances.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Md from 'mdast'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseGfmWithMath } from '../src/markdown/parse.ts'
import { tableToMarkdown } from '../src/markdown/table-markdown.ts'
import { markdownLabels } from './labels.client.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** The tables of a document, parsed through the renderer's own grammar. */
function parseTables(source: string): Md.Table[] {
  return parseGfmWithMath(source).children.filter(node => node.type === 'table')
}

/** Every row's cell text, for asserting that a projection reparses intact. */
function cellTexts(table: Md.Table): string[][] {
  return table.children.map(row => row.children.map(cell => cell.children
    .map(child => ('value' in child ? child.value : ''))
    .join('')))
}

const TABLE = [
  '| Left | Center | Right | None |',
  '|:--|:-:|--:|---|',
  '| a | b | c | `code` |',
  '| [link](https://example.com) | *em* | 1 | **2** |',
].join('\n')

function stubClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
}

describe('tableToMarkdown', () => {
  it('rewrites a raggedly spaced table as canonical GFM', () => {
    // Authored spacing and the delimiter row's width carry no meaning; the
    // projection pads columns and rebuilds the delimiters from `align`.
    const ragged = [
      '| a |    b |',
      '|:-----|---:|',
      '| 1 | 2 |',
    ].join('\n')
    const [table] = parseTables(ragged)
    // Columns are padded to a common width, and the delimiters shrink to
    // that width while keeping the authored alignment.
    expect(tableToMarkdown(table!)).toBe(
      '| a  |  b |\n| :- | -: |\n| 1  |  2 |\n',
    )
  })

  it('escapes a cell pipe so the projection reparses to the same cells', () => {
    const [table] = parseTables('| x | y |\n|---|---|\n| a \\| b | c |')
    const projected = tableToMarkdown(table!)
    expect(projected).toContain('a \\| b')
    const [round] = parseTables(projected!)
    expect(cellTexts(round!)).toEqual([['x', 'y'], ['a | b', 'c']])
  })

  it('withholds a projection for a cell node the serializer cannot handle', () => {
    // The renderer's node union is merge-extensible: a grammar registered
    // elsewhere can put a node type in a cell that has no serializer handler.
    const table: Md.Table = {
      type: 'table',
      align: [null],
      children: [{
        type: 'tableRow',
        children: [{
          type: 'tableCell',
          children: [{ type: 'unknownGrammarNode' } as unknown as Md.PhrasingContent],
        }],
      }],
    }
    expect(tableToMarkdown(table)).toBeUndefined()
  })
})

describe('markdown table copy control', () => {
  it('copies the table as GFM, not as the rendered text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    render(<MarkdownText text={TABLE} labels={markdownLabels} />)

    fireEvent.click(screen.getByRole('button', { name: '复制' }))

    const written = writeText.mock.calls[0]?.[0] as string
    // Inline markup survives as markup: a plain-text projection of the same
    // table would have flattened these to their labels.
    expect(written).toContain('[link](https://example.com)')
    expect(written).toContain('*em*')
    expect(written).toContain('`code`')
    // The delimiter row carries each column's authored alignment.
    expect(written.split('\n')[1]).toMatch(/^\| :-+ \| :-+: \| -+: \| -+ \|$/)
    expect(await screen.findByRole('button', { name: '复制成功' })).toBeTruthy()
  })

  it('restores the idle label after the confirmation window', async () => {
    vi.useFakeTimers()
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    render(<MarkdownText text={TABLE} labels={{ ...markdownLabels, code: { copyLabel: 'Copy table', copiedLabel: 'Copied' } }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy table' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()

    await vi.advanceTimersByTimeAsync(1000)
    expect(screen.getByRole('button', { name: 'Copy table' })).toBeTruthy()
  })

  it('does not claim success when the host refuses the write', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    render(<MarkdownText text={TABLE} labels={markdownLabels} />)

    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await act(async () => { await Promise.resolve() })

    expect(screen.queryByRole('button', { name: '复制成功' })).toBeNull()
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('withholds the control while the table is still streaming', () => {
    // A streaming table's trailing row is still growing, so its projection
    // would copy a half-parsed final cell.
    const live = render(<MarkdownText text={TABLE} streaming labels={markdownLabels} />)
    expect(live.queryByRole('button', { name: '复制' })).toBeNull()

    live.rerender(<MarkdownText text={TABLE} labels={markdownLabels} />)
    expect(live.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('offers one control per table, including inside a blockquote', () => {
    const doc = `${TABLE}\n\n> | q | r |\n> |---|---|\n> | 1 | 2 |\n`
    render(<MarkdownText text={doc} labels={markdownLabels} />)
    expect(screen.getAllByRole('button', { name: '复制' })).toHaveLength(2)
  })
})

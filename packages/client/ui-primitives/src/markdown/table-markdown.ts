/**
 * GFM serialization of a parsed table, backing the table block's copy control.
 *
 * The projection is canonical rather than verbatim: cells are padded to a
 * common column width and the delimiter row is rewritten from `node.align`,
 * so the copied text is well-formed GFM regardless of how the source was
 * spaced. Cell content round-trips through the same GFM and math extensions
 * the renderer parses with, so pipes, emphasis, links, and inline TeX come
 * back escaped as the grammar requires.
 */

import type * as Md from 'mdast'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { mathToMarkdown } from 'mdast-util-math'
import { toMarkdown } from 'mdast-util-to-markdown'

const EXTENSIONS = [gfmToMarkdown(), mathToMarkdown()]

/**
 * Serialize one table node to GFM source.
 * @param node - The parsed table.
 * @returns The table as GFM, or undefined when a cell holds a node type the
 * serializer has no handler for.
 */
export function tableToMarkdown(node: Md.Table): string | undefined {
  try {
    return toMarkdown(node, { extensions: EXTENSIONS })
  } catch {
    // mdast-util-to-markdown throws on the first node type its handlers do
    // not cover. The renderer's node union is merge-extensible, so a grammar
    // registered elsewhere can place an unhandled node in a cell; the caller
    // withholds the control rather than copying a truncated table.
    return undefined
  }
}

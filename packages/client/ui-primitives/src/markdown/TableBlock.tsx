// TableBlock: the rendered GFM table plus its hover-revealed copy control.
// The control writes the table back as GFM (tableToMarkdown), so a reader can
// paste a comparison matrix into an editor instead of losing the columns to a
// plain-text selection.

import type { ReactNode } from 'react'
import clsx from 'clsx'
import { IconCheckOutline16, IconCopyOutline16 } from '../icons/index.tsx'
import { useCopyFeedback } from '../use-copy-feedback.ts'
import css from './MarkdownText.module.css'

/** Copy-control labels for the table block; the owner passes localized text. */
export interface TableBlockLabels {
  /** Copy-button idle label. */
  copyLabel: string
  /** Copy-button label during the post-copy confirmation window. */
  copiedLabel: string
}

export interface TableBlockProps extends TableBlockLabels {
  /** The rendered `<table>` and its rows. */
  children: ReactNode
  /**
   * Four-or-more-column table: keeps natural width and carries the
   * `md-table-wide` hook a hosting layout widens past the message column.
   */
  wide: boolean
  /** The table as GFM; absent withholds the control (unserializable cell). */
  markdown: string | undefined
}

/**
 * A markdown table with its copy-as-markdown affordance.
 * @param props - Rendered rows, the wide-layout flag, the GFM projection, and copy labels.
 * @returns The positioned block, the scroller, and the copy control when serializable.
 */
export function TableBlock({ children, wide, markdown, copyLabel, copiedLabel }: TableBlockProps) {
  const { copied, onCopy } = useCopyFeedback(markdown ?? '')
  const label = copied ? copiedLabel : copyLabel
  return (
    // `md-table-wide` rides this block, not the scroller: a hosting layout
    // widens the hook with a negative margin measured against the message
    // column, which only resolves correctly on the block-level child. The
    // control is likewise a sibling of the scroller rather than inside it,
    // so it holds the corner instead of drifting as a wide table scrolls.
    <div className={clsx(css.tableBlock, wide && 'md-table-wide')}>
      <div
        // Wide tables rest with overflow-x hidden (the hover-revealed bar in
        // MarkdownText.module.css), which drops Chromium's implicit scroller
        // focusability — the explicit tabindex keeps them keyboard-reachable,
        // and :focus-visible restores scrolling.
        className={clsx(css.tableScroll, wide ? css.tableScrollWide : css.tableFill)}
        tabIndex={wide ? 0 : undefined}
      >
        {children}
      </div>
      {markdown !== undefined && (
        <button
          type="button"
          className={css.tableCopyButton}
          data-state={copied ? 'copied' : 'idle'}
          aria-label={label}
          title={label}
          onClick={onCopy}
        >
          {copied ? <IconCheckOutline16 size={14} /> : <IconCopyOutline16 size={14} />}
        </button>
      )}
    </div>
  )
}

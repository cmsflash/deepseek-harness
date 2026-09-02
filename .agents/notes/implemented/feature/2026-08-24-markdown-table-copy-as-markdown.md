# Agent Note: Markdown tables carry a copy-as-markdown control

Status: implemented

English | [中文](2026-08-24-markdown-table-copy-as-markdown.zh.md)

## Problem

Every other block surface in the transcript could be copied — fences through `CodeBlock`'s banner button, file mutations through `DiffBlock`, command output through `TerminalBlock`, search results through `SearchBlock`, whole messages through `MessageIconActions` — and a rendered markdown table could not.

A table is the one block where a text selection loses the most. Dragging across a rendered `<table>` yields the cell text with the column structure gone: no pipes, no delimiter row, no alignment. The reader who most wants a comparison matrix in their editor is exactly the reader the selection fails, and a model that produced a table has already written the GFM the reader wants.

## Decision

`renderTable` renders through a new `TableBlock` component that carries a hover-revealed copy control, and the control writes the table back as GFM.

### The projection is a real serialization, not a DOM scrape

`tableToMarkdown` (`packages/client/ui-primitives/src/markdown/table-markdown.ts`) hands the parsed `Md.Table` to `mdast-util-to-markdown` with the same GFM and math extensions the renderer parses with. Reading the DOM back would have to re-derive alignment from inline styles and re-escape cell text by hand; serializing the node the renderer already holds gets pipes, emphasis, links, inline code, strikethrough, and inline TeX escaped by the grammar's own rules.

The projection is canonical rather than verbatim: columns are padded to a common width and the delimiter row is rebuilt from `node.align`, so a raggedly spaced source copies as well-formed GFM. A cell's escaped pipe survives as `a \| b`, so the copied text reparses to the same cells.

`mdast-util-to-markdown` was already in the lockfile as a transitive dependency of `mdast-util-gfm`; it is now a direct dependency of `ui-primitives` because the package imports it directly. Including it costs ~9 KB gzipped against a ~315 KB gzipped client baseline. The table-only extension (`gfmTableToMarkdown`) is not enough on its own — it throws on `delete` and math nodes, which the renderer's grammar readily puts in cells.

An unserializable cell withholds the control instead of copying a truncated table. The renderer's node union is merge-extensible, so a grammar registered elsewhere can place a node type in a cell that no handler covers.

### Streaming withholds the control

A streaming table's trailing row is still growing, so its projection would copy a half-parsed final cell. The control lands on the settled pass, which is also where the fence copy button and file mentions already live.

### The control is a sibling of the scroller, and the wide hook moved with it

`md-table-wide` now rides the new `.tableBlock` wrapper rather than `.tableScroll`. `AssistantMarkdown` widens that hook with margins measured against the message column, which only resolves correctly on the block-level child of that column; leaving the hook on a now-nested scroller would have silently broken the breakout.

The button is a sibling of the scroller for the same reason it is not inside it: `.tableScroll` scrolls horizontally, so a child button drifts out of view as the reader scrolls a wide table. As a sibling of the positioned block it holds the top-right corner at every scroll offset — verified against a real 312 px overflow.

It overlays the header row's trailing edge rather than reserving space, because a reserved row would push every table in the transcript down by the control's height.

### Visibility

Hover on the block reveals it; `:focus-visible` reveals it for keyboard users; `@media (hover: none)` keeps it visible where there is no hover to give. The post-copy confirmation stays visible regardless, so a pointer that slides off during the write — or a copy made from the keyboard — still reports.

The fill uses `--dsw-alias-button-floating-*`, not a `--dsw-alias-bg-*` rung. That is the substantive difference the scrollbar-elevation gate enforces: `MarkdownText.module.css` contains a scroll container, so any surface token in that sheet obliges a scrollbar rebind, while the control-family token correctly says this is a floating control rather than a surface a scrollbar sits against.

## Consequences

- The eight DOM-parity fixtures covering table-bearing documents were re-recorded. The diff is exactly one added wrapper, the relocated hook, and the button; table markup is untouched, and the streaming fixtures correctly carry no button.
- `markdown-wide-table.e2e.ts` reads the breakout facts off the block and the residual scroll off the scroller. Its committed geometry golden is unchanged, which is the evidence that the fill/scroll/breakout relations, lead-padding alignment, keyboard scrolling, and hover-scrollbar behavior all survived the structural change.
- The labels arrive through the existing `codeLabels` prop rather than a new channel, so the table and fence controls cannot drift apart in a locale.

## Alternatives considered

**Slice the original markdown source.** Each block carries `position` offsets, so a table's source text is recoverable at zero bundle cost and would copy the author's exact spacing. Rejected: the settled render does not thread the source string down to `renderTable`, and the streaming renderer's frozen blocks carry offsets relative to their own parse slice. Threading a source string through both paths to save 9 KB would couple the renderer to text it otherwise never needs.

**Register the control as a slot contribution from a separate plugin.** Rejected: `ui-primitives` is a static, cordis-free package with no slot dependency, and markdown rendering exposes no extension point. Adding one to make this a plugin would be a much larger change to a package whose cordis-free status is deliberate.

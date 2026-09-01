# @deepseek-ai/dsh-client-ui-layout

English | [中文](README.zh.md)

Shell plugin: three-column AppFrame (drag handles and concession chain) plus the `ctx.layout` panel-geometry service; it registers into the runtime-owned `root` slot and declares `sidebar`, `conversation`, `details`, and `conversation.empty`. The sidebar resize boundary is an invisible hit strip, while the details boundary retains its floating pill; only details shrinks during concession and then auto-closes. A closed sidebar retains a 56px control rail while details closes to zero width. The package also seats the theme presenter: it consumes resolved `ctx.theme` snapshots and projects them onto the document (`html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, the theme's alias tokens as inline variables on body, and one owned `<meta name="theme-color">` whose content follows the computed body background). Measuring after palette and token application keeps the rendered background as the single color authority; disposing the presenter removes its metadata node with its other global writes.

At or below `MOBILE_MAX` (640px) the solver stops producing a column layout: the conversation takes the whole viewport, details stays closed, and the sidebar leaves the grid flow for an overlay drawer that floats above the conversation behind a dismiss scrim. The rail has no mobile form, so a closed drawer resolves to zero width and the frame renders its own opener control — the conversation header does not exist in the hero state, so the frame owns the only way back to the session list. `Columns.overlay` marks that layout, and `Columns.sidebar` then reports the drawer width rather than a track width; the drawer is capped by `DRAWER_MAX` and always leaves at least `DRAWER_PEEK` of the conversation reachable. Crossing the breakpoint changes only frame geometry: slot occupants keep their tree positions and React identity, and no width preference is rewritten, so widening restores the previous column layout. `ctx.layout.collapseNarrowSidebar()` is the navigation-side companion — ui-sidebar and ui-workspace call it after starting or opening a session so the drawer stops covering the destination.

AppFrame always mounts the conversation and details columns; a connected Session renders through `SessionProvider`. The transient layout store starts the sidebar at its default width and details closed, and it never reads or writes `localStorage`. Hero and other unselected states also derive a zero rendered details width without changing that stored preference. AppFrame retains the last non-blank Session id across those states: the first Session remains closed, an explicit details action opens the contract default width, returning to the same Session restores its unchanged width, and selecting a different Session closes details before paint. The conversation owner share is empty, while the sidebar owner share contains only `collapsed` and `width`; registrants obtain business data from standard hooks and actions from their own inject faces.

The `/client` exports are the plugin body (`apply`/`inject`), `LayoutController`, and the four owner-share interfaces. AppFrame, the panel store, and the concession solver remain package-internal.

## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Panel geometry is transient** — reload restores the sidebar default and details closed; switching between distinct Session ids also closes details and forgets its dragged width, while unselected surfaces render details at zero width without modifying geometry.
- **Concession-chain auto-close derives a zero width without touching the preferred width** — the panel restores itself when the window widens; consumers must not read the stored details width as the rendered truth.
- **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.
- **The details column has no mobile form** — below `MOBILE_MAX` it is always closed, so tool details and other `details` occupants are unreachable on a phone; they need their own mobile surface (a sheet over the conversation) before that gap closes.
- **The drawer has no swipe gesture** — it opens and closes through the frame's opener, the scrim, and navigation; an edge-swipe would need a gesture owner the frame does not currently have.

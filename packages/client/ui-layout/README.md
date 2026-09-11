---
description: "Shell layout for the Web GUI: the three-column AppFrame whose right column is a track for an edge-anchored panel, the panel-geometry service, and theme presentation; for users and maintainers of the window chrome."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-layout

English | [中文](README.zh.md)

## Summary

This package provides the Web GUI's three-column AppFrame, edge-column widths, and `ctx.layout` presentation control. The right column concedes space before the center; its occupant renders fullscreen while the frame retains the wide-screen track underneath. The theme presenter owns color scheme, alias tokens, content font size, and document metadata. Layout state resets on reload.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The root slot composes the sidebar, main content, and right column. The sidebar spans 264–420px, defaults to 280px, and retains a 56px rail when collapsed; below 1024px it collapses automatically, and opening the right panel collapses a manually expanded sidebar. The right panel first opens at 45% of the viewport, then retains the user's pixel preference, capped at 70%. To protect 400px for the center, the frame first reduces the right panel to 300px, then reports insufficient room so its occupant closes it, and only then compresses the center further. Dragging has no transition delay; the right handle is absent while closed or fullscreen.

Global panels occupy the root-scoped `main` keyed slot; `conversation` is the reserved key for the Conversation. `ctx.layout.selectPanel(id)` selects a registered panel, and `null` selects the Conversation without changing the current Session. No global panel is registered by the shipped composition.

Windows Electron's `data-windows-titlebar` marker reserves the caption height above all columns and removes the collapsed sidebar rail. Only the content area's top-left corner has a 16px radius; the other corners and the internal divider remain square. The frame publishes `--dsh-windows-content-radius` and `--dsh-windows-sidebar-width` for ui-sidebar-right's fullscreen corner and sidebar clearance. Ordinary Web documents do not receive the marker; macOS retains its separate layout.

At or below `MOBILE_MAX` (640px) the solver stops producing a column layout: the conversation takes the whole viewport, the right column stays closed, and the sidebar leaves the grid flow for an overlay drawer that floats above the conversation behind a dismiss scrim. The rail has no mobile form, so a closed drawer resolves to zero width and the frame renders its own opener control — the conversation header does not exist in the hero state, so the frame owns the only way back to the session list. `Columns.overlay` marks that layout, and `Columns.sidebar` then reports the drawer width rather than a track width; the drawer is capped by `DRAWER_MAX` and always leaves at least `DRAWER_PEEK` of the conversation reachable. Crossing the breakpoint changes only frame geometry: slot occupants keep their tree positions and React identity, and no width preference is rewritten, so widening restores the previous column layout. Every `selectPanel` call, including the `null` that every Session navigation ends in, dismisses an open drawer so it stops covering the destination; between the two breakpoints the sidebar is a column the user opened deliberately, and navigation leaves it alone.

### Theme presentation

The presenter consumes resolved theme snapshots and projects them onto the document: `html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, the theme's alias tokens and `--dsh-content-font-size` as inline variables on body, and one owned `<meta name="theme-color">` whose content follows the computed body background. Disposing the presenter removes its metadata node with its other global writes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`selectPanel(id)` checks the live `main` registry before changing selection; an absent key throws and leaves the current panel intact. `beginNavigation()` returns an abort signal for an asynchronous UI navigation. A later call, a valid panel selection (including repeated selection), or layout disposal aborts that signal without cancelling underlying Session creation. Consumers check the signal before committing navigation or moving drafts.

One registration declares four child slots and binds `ctx.layout` methods `selectPanel`, `toggleSidebar`, `openRightbar(track, fullscreen)`, and `closeRightbar`. One root store separates `panelInfo` selection from `layoutInfo` measurements, width preferences, and presentation reports. `usePanelInfo` subscribes to the stable selection object; AppFrame subscribes to the stable layout object. The `rightbar` owner supplies actual `width`, `viewportWidth`, and normal-presentation eligibility `canShow`; insufficient room causes a deterministic close, never automatic reopening on widening. Fullscreen hides the width handle without releasing a track the occupant retains. AppFrame keeps the column containers mounted. The frame clips its overflow without becoming a scroll container, and a closed right column clips the hidden panel its occupant keeps mounted past the frame edge, so neither contributes horizontal overflow and no focus scroll can move the columns. The right column's root controller renders `rightbar.session` through `SessionProvider` only while the Conversation is selected; its unmount report releases the track. The independent title component uses the selected Session title only while the Conversation is visible, with the build-configured product title or localized `common.brand.localBuild` as its fallback; locale revisions update that fallback. The theme presenter is a second effect: pure DOM writes from resolved snapshots — initial state through the getter once, then event-driven only, with no React path. It applies palette, font-size, and token variables before measuring the rendered background as the single color authority. Fullscreen presentation suppresses grid and handle transitions; its occupant reports the new columns only after covering the frame. Fullscreen exit keeps transitions suppressed while the frame installs its destination geometry: close removes the right track, and restore retains it. Subsequent normal geometry actions restore ordinary transitions.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the layout surface is not enough. They move from the frame to the columns it renders and the theme it presents.

- [ui-sidebar](../ui-sidebar/README.md) — occupies the `sidebar` column and its seats.
- [ui-conversation](../ui-conversation/README.md) — occupies the `main` key `conversation`.
- [ui-sidebar-right](../ui-sidebar-right/README.md) — occupies the `rightbar` column with one docking surface per session.
- [ui-theme](../ui-theme/README.md) — the theme seam whose resolved snapshots the presenter consumes.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current layout behavior. They are current package constraints, not a general window-manager comparison or a task backlog.

- **Panel geometry is transient** — reload restores the sidebar default and the right panel hidden; each dragged width is one frame-wide preference, not a per-Session fact.
- **Extremely narrow windows** — after the right panel closes, the center may still fall below 400px; the left 56px rail remains down to the phone breakpoint.
- **The right column has no mobile form** — below `MOBILE_MAX` it is always closed, so file previews and other `rightbar` occupants are unreachable on a phone; they need their own mobile surface (a sheet over the conversation) before that gap closes.
- **The drawer has no swipe gesture** — it opens and closes through the frame's opener, the scrim, and navigation; an edge-swipe would need a gesture owner the frame does not currently have.
- **Track and panel travel on one shared curve** — the frame's track transition and the occupant's slide read the same duration and easing variables; an occupant that used its own would detach the panel's edge from the conversation's while squeezing.
- **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The shell viewing-state store behind `ctx.layout` emits no Cordis events; clamp and track sequencing is asserted directly by this package's columns and service specs.

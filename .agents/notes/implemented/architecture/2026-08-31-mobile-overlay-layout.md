# Agent Note: Mobile overlay layout for the web frame

Status: implemented

English | [中文](2026-08-31-mobile-overlay-layout.zh.md)

## Problem

The web GUI stayed a column layout at every width. `computeColumns` had one breakpoint, `SIDEBAR_AUTO_COLLAPSE` (1024px), and it only swapped the sidebar's width preference for the 56px `SIDEBAR_COLLAPSED` rail — it never removed a column. On a 390px phone that produced two panels: a rail the user cannot read anything in, plus a 334px conversation. Opening the sidebar was worse, because the sidebar never concedes: the drawer took 280px and left the conversation 110px, so the surface the user came for became the smallest thing on screen.

The center column's floor compounded it. `CENTER_MIN` is 640px, and every occupant was laid out against that assumption, but step 3 of the concession chain lets center absorb the whole deficit. At phone widths the conversation ran at roughly half its design floor, and rows that assume horizontal room broke: the session header pairs a `flex: 1` title cluster with a `flex: none` utilities cluster, so the utilities kept their intrinsic ~150px and squeezed a 230px session title into 41px of readable space.

None of this was reachable from a plugin. `root` is a `single` slot and single slots are priority-shadowable, but `SlotCore.register` rejects re-declaring a child slot another entry declared, and a component may only render slots its own `children` table declares. A shadowing frame would be an empty shell that cannot host `sidebar`, `conversation`, or `details`; the alternative is disabling the `ui-layout` bundle row and reimplementing the service, all four declarations, the store, the drag handles, and the theme presenter. The overflow half is likewise unreachable — it is hashed CSS Modules inside other packages, and cross-package symbol imports are forbidden.

## Decision

`computeColumns` owns a second breakpoint, `MOBILE_MAX` (640px, the deepsuite SM stop). At or below it the solver stops producing a column layout: center takes the whole viewport, details resolves to zero, and the sidebar leaves the grid flow for an overlay drawer. `Columns` carries an `overlay` discriminant, and on that layout `Columns.sidebar` reports the drawer's width rather than a track width, so AppFrame needs no second geometry source. The rail has no mobile form — a permanent 56px of chrome on a 390px screen is the original complaint — so a closed mobile sidebar resolves to zero.

The drawer is sized to leave a strip of the conversation visible: `DRAWER_PEEK` (56px) below the cap, `DRAWER_MAX` (320px) above it. That strip is what makes the scrim an obvious dismiss target rather than an invisible full-screen overlay, and it is the region a real pointer can actually reach — a click at the scrim's geometric center lands on the drawer.

AppFrame renders the drawer opener itself. The obvious home is the conversation header, but the hero state renders no header, so a closed drawer would strand a user with no route back to the session list. The frame is the only element present in both states. Because the drawer covers the conversation, navigating from it also has to dismiss it: `ctx.layout.collapseNarrowSidebar()` is the navigation-side verb, and ui-sidebar and ui-workspace call it after starting or opening a session.

That verb is gated on the overlay layout, not on `narrow`. The two breakpoints are 384px apart, and between them (a 700px window, say) the sidebar is still a column the user deliberately opened beside the conversation — dismissing it there would undo that choice on every navigation. The store therefore mirrors `overlay` alongside `narrow`, and `collapseNarrowSidebar` is a no-op unless the sidebar actually covers its destination. Reusing `narrow` looked right and silently broke session switching at 700px, which is what the browser scroll-contract scenario caught.

Crossing the breakpoint changes frame geometry only. Slot occupants keep their tree positions and React identity, and no width preference is rewritten, so widening restores the previous column layout — the same purity the concession chain already had.

AppFrame measures its own box rather than the window, which is right for a frame that can be smaller than the viewport, but it makes the width a function of the layout the width selects. A resize that does not settle the observed element therefore strands the frame at its last measurement, and now that a measurement decides how many columns exist, that stale read can hold the layout on the wrong side of the breakpoint. A `window` resize listener runs the same rAF-throttled measurement beside the observer, so the two agree on every path.

The header fix belongs to ui-conversation, in one `@media (max-width: 640px)` block placed last in its stylesheet. The base rules set shorthands (`flex: 1` resolves to a `0%` basis) that the override must beat at equal specificity, so source order decides; a block placed before them silently loses. On phones the title row wraps, the title cluster takes a full-width basis to force the utilities onto their own row, and the header indents past the frame's floating opener.

Markdown tables take the same treatment in ui-primitives. A cell's `min-width: 100px` plus 32px of horizontal padding sets a table's minimum at 132px per column, so even a three-column wrap-first table needed 396px and forced a horizontal scroll inside a ~334px message column. Both budgets shrink together on the mobile breakpoint (64px floor, 16px padding), which keeps the floor clearing a short word and the padding separating columns while letting a narrow table wrap as designed. Genuinely wide tables still scroll inside their own box — that is their contract at every width.

## Alternatives considered

**A plugin instead of a core patch.** Rejected as impossible rather than undesirable — see the Problem. Worth recording because "make the GUI responsive" reads like exactly the kind of presentation concern the slot system should absorb, and it is not: slot *declaration* is exclusive, so anything that re-parents the shipped columns is a fork of `ui-layout`.

**A breakpoint inside AppFrame, leaving the solver untouched.** This is where `SIDEBAR_AUTO_COLLAPSE` lives, so it had precedent. Rejected because that breakpoint only picks an input to the solver, while the mobile layout changes the *output* — a different number of tracks. Deciding it in the component would have split the geometry contract across two files and left `Columns` unable to describe what was rendered.

**Lowering `CENTER_MIN` on phones instead of dropping the rail.** It removes the squeeze arithmetic but not the wasted 56px, and it weakens a constant the center column's occupants are designed against at every width. Dropping the rail is the narrower change: the floor keeps meaning what it meant, and the mobile arm returns before the chain runs.

**Hiding the utilities cluster on phones.** Shorter than wrapping, but "Session log" and its neighbours are the session's controls, and a layout fix that deletes functionality on the smallest screen trades one complaint for another.

## Testing

`columns.client.spec.ts` covers the mobile arm at 375/390/414 with real device widths: full-width center in both drawer states, the peek/cap sizing, the exact `MOBILE_MAX` switch, and purity across the breakpoint. Two pre-existing cases asserted the old behavior at 400px and 500px — phone widths under the new contract — and now state the same column-layout facts just above `MOBILE_MAX`.

`app-frame.client.spec.tsx` covers the rendered frame: the single track, the closed drawer's `inert`/`aria-hidden`, opener and scrim dismissal, the absence of drag handles, and the restore to columns.

`apps/web/tests/mobile-viewport.e2e.ts` is the browser-level guard the package specs cannot be — jsdom resolves no layout, so only a real engine can answer whether the conversation actually spans the viewport or the page scrolls sideways. It asserts viewport-relative facts at 390px and 375px, never absolute pixels, which differ across platforms with installed fonts.

Three existing viewport sweeps now reach phone widths instead of stopping at 600–640px, which is what surfaced the table defect above: `message-feedback-layout` (414/390), `conversation-column-overflow` (414/390), and `markdown-wide-table` (390). The feedback sweep's anchor assertion needed a phone arm: `useAnchoredPosition` clamps a popover into the viewport, and staying on screen outranks staying beside the trigger, so a phone stop legitimately reports a non-zero trigger gap that wider stops never produce.

## Consequences

The phone layout is now single-column with the conversation at full width, and the drawer is reachable, dismissable, and self-closing on navigation. `Columns` gained a field, so every construction site states `overlay` — a compile-time push to consider which layout a caller means.

Two gaps stay open, and the ui-layout README records both. The details column has no mobile form: below `MOBILE_MAX` it is always closed, so tool details and other `details` occupants are unreachable on a phone and need their own surface (a sheet over the conversation) before that closes. The drawer also has no swipe gesture; it opens and closes through the opener, the scrim, and navigation, because an edge swipe needs a gesture owner the frame does not have.

`ui-layout` now injects `locale` for the opener's label, and `ui-workspace` injects `layout` for the dismiss verb. Both are ordinary service edges, but the second is worth noting: the workspace browser now depends on the layout service purely to cooperate with a viewport it never reads.

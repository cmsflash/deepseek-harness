# Agent Note: Collapsed right panel outside the frame's overflow

Status: implemented

English | [中文](2026-09-11-collapsed-rightbar-frame-overflow.zh.md)

## Problem

The right Sidebar keeps its panel mounted while collapsed, at its normal width and translated past the frame's right edge ([docking infrastructure](../feature/2026-09-04-right-sidebar-docking-infrastructure.md)). The frame's zero-width right column did not clip, and the frame itself used `overflow: hidden`, which Chromium treats as a scroll container. The hidden panel therefore extended the frame's scrollable overflow by one panel width: conversation text was clipped short on the right, and the browser's scroll walk on the first Composer `focus()` set `frame.scrollLeft` to that width, moving the left Sidebar and the Conversation out of the viewport while the frame's own box did not move.

## Decision

`AppFrame.module.css` clips the frame with `overflow: clip`, which is never scrollable, and adds `.frame[data-rightbar-collapsed] .rightbarCol { overflow: clip }` so a closed column clips the mounted hidden panel out of the frame's overflow. `.rightbarCol` keeps `overflow: visible` while a track exists, so an opening panel still hangs over the Conversation from the narrow column. The closing slide is unaffected: the track and the panel's transform ride the same transition, so the panel's left edge stays on the column's left edge until both reach the frame's edge. The fullscreen panel is `position: fixed` and outside both clips. The mobile layout's `display: none` for the column is unchanged.

## Alternatives considered

**Unmount the collapsed panel.** The docking infrastructure keeps the panel mounted so tab state survives a collapse and showing and hiding are one slide; unmounting reverses that decision.

**`preventScroll` on every Composer focus.** The Composer already focuses with `preventScroll` on its own paths; the failing walk is the browser's default on a user click, and any `scrollIntoView` from any column would still move the frame. The frame's own overflow is the single owner.

**Clip the column in every state.** The opening slide starts from a zero or narrow track and the panel must hang over the Conversation until the track catches up; clipping there cuts the panel to the track's width mid-slide.

## Consequences

The frame contributes no horizontal overflow with the panel collapsed, and no descendant scroll walk can move its columns. [Stylesheet assertions](../../../../packages/client/ui-layout/tests/app-frame-styles.client.spec.ts) pin the three overflow rules; the [assembled browser case](../../../../apps/web/tests/sidebar-right.e2e.ts) asserts a wide hidden panel past the frame edge, zero scrollable frame width before and after focusing the Composer, unchanged column boxes, and `scrollLeft` reading back zero after a programmatic write. The ui-layout README states the clip contract.

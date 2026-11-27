# Agent Note: Phone view stack with platform back actions

Status: implemented

English | [中文](2026-11-26-phone-view-stack.zh.md)

## Problem

The [mobile overlay layout](2026-08-31-mobile-overlay-layout.md) put the thread list in a drawer over the conversation. A drawer is a temporary panel: it left a strip of the conversation behind a scrim, the page opened on whichever conversation was selected, and the platform's own back actions did nothing. On a phone, messaging apps treat the list as a screen of its own and leave a conversation with Android's back action or an iOS swipe from the left edge.

## Decision

At or below `MOBILE_MAX` the frame stacks three full-screen views: the thread list, the conversation, and the fullscreen right panel. The list and the thread page (center plus right column) share the single grid track; the thread page slides over the list. The existing `narrowExpanded` flag selects the list, so the store gains only a direct setter, and a page that opens at a phone width starts on the list.

Each view above the list owns one browser history entry, marked with its depth in `history.state`. `phone-history.ts` reconciles entries with the views on transitions only: a rise in the on-screen depth pushes entries, and a fall rewinds the entries above it. A popstate below the on-screen depth asks the views to close and leaves the entries alone while they catch up, because the right panel reports its closing a render later; comparing levels instead of transitions would push the popped entry back during that render. Android's back action, Safari's edge swipe, and the browser's forward action all go through this path, so the frame needs no platform detection for them.

iOS needs no gesture code: Safari and home-screen apps both turn a swipe from the left edge into a history traversal and animate it with a snapshot of the destination entry. A frame-owned swipe for home-screen apps was built first, on the belief that they have no such gesture, and on an iPhone both ran at once: the page slid under the finger while the frame slid its own view inside it. Because iOS has already shown the destination when `popstate` arrives, the frame marks the root element for 300ms around a traversal-driven view change, and the frame and the right panel skip their slide while the mark is set. The mark is set only where `navigator.standalone` is defined, which identifies iOS WebKit; Android's back action shows no preview, so the slide stays there.

Closing the right panel belongs to ui-sidebar-right, which owns its expanded state. The panel registers a dismiss callback through `ctx.layout.registerRightbarDismiss`; ui-layout calls it for a back action from the panel and imports nothing from that package.

## Alternatives considered

**URL routes per thread.** A route would give each thread a shareable address, but the client has no router and Session selection does not live in the URL. Depth markers in `history.state` give the back actions without changing how Sessions are opened.

**An edge-swipe handler.** iOS and Android already turn edge gestures into history traversals; a second handler runs beside the platform's own animation.

## Testing

`phone-history.client.spec.ts` drives an in-memory history with asynchronous traversal: pushes and rewinds, platform back from each level, a panel that reports its closing late, a two-level jump, forward, a reload that restores its views, and the column layout. `app-frame.client.spec.tsx` covers the inert views and the back control, and `apply.client.spec.ts` the traversal mark; `apps/web/tests/mobile-viewport.e2e.ts` covers both views at full width, the back control, browser back from the conversation and from the right panel.

## Consequences

A fresh phone page opens on the list; a reload restores the conversation when its history entry belongs to one, and the right panel restores itself, so the first read pushes entries but never rewinds them. Selecting another thread before an earlier rewind's popstate arrives can return to the list once; the window is one task long.

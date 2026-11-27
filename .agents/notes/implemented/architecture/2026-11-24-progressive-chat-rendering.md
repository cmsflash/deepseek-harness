# Agent Note: Progressive Chat rendering

Status: implemented

English | [中文](2026-11-24-progressive-chat-rendering.zh.md)

## Problem

A warm Session retains history but not its rendered Chat view. Mounting every loaded message before the first usable frame makes switching slower as the reader loads older pages. The [browser local copy](2026-11-07-browser-local-session-copy.md) removes the history-transfer wait; it does not remove rendering work.

## Decision

Chat mounts the saved reading anchor and newest rows eagerly, gives nearby rows priority through one flow-owned intersection observer, and admits remaining eligible message bodies in idle batches. Every admitted renderer stays mounted while its semantic row remains loaded; viewport exit alone never recycles it. Stable semantic wrappers preserve the existing paging, navigation and scroll-owner relationships; placeholders reserve estimated height until the original renderer supplies its content. The queue does not write scroll positions or duplicate Session data. It delegates each body commit to the viewport, which compensates growth above a surviving visual anchor without spending fold space reserved below it. The same transaction rebases active folds and preserves unsampled reader movement; ordinary growth below the anchor keeps the existing reclamation policy.

Native idle time between keystrokes is not evidence that the reader has stopped typing. Background admission therefore waits for the configured quiet period after opening and trusted input, followed by a rendering opportunity. Input restarts the same cancellable wait; visible rows bypass it. The [Chat preference](../../../../packages/client/ui-chat/README.md#scroll-ownership) controls this wait without adding a manual rendering mode.

Row spacing uses viewport-owned flags that reflect the committed DOM's exact emptiness and steering-marker predicates. Replacing a placeholder briefly makes its row empty during a React commit; descendant-dependent sibling CSS then invalidates later subtrees even when the final row is still nonempty. Initial synchronization, narrowly filtered mutations and post-batch synchronization update flags only when the final predicates change. Arbitrary null-returning renderers keep their original spacing.

A batch shares one synchronous React commit. Its next size uses the browser's available idle time and the previous commit and layout costs, with at most doubled growth and a one-renderer minimum for progress. A layout read after each commit includes deferred style work in this estimate. When shared layout alone exceeds the idle allowance, the batch still budgets renderer work within that allowance and pays the shared layout once; subtracting an impossible fixed cost would keep every batch at one row. This exception can exceed one idle period and must be checked against input latency. Yielding between batches lets browser input and layout run rather than moving the entire initial stall to one later task. Visible rows leave the idle queue immediately. Removing the final pending row disconnects observation and cancels outstanding scheduling; callbacks from a disposed queue cannot mount content into another view. Browsers without intersection observation render eagerly; browsers without idle callbacks yield through a frame and a task.

A saved anchor can lie far inside a message, beyond that message's estimated height. Its real body must therefore exist before scroll restoration: aligning only an estimated placeholder can place it wholly outside the observation buffer, preventing it from ever becoming visible. The exact saved node and group part remain eager for that view mount.

## Alternatives considered

Persistent virtualization reduces retained rendering work but removes off-screen text from native Find and accessibility browsing. Intercepting a keyboard shortcut cannot cover browser-menu Find or browser chrome that already holds focus. Recycling arbitrary renderer output also loses component-owned state that cannot be inferred from passive-looking DOM. Progressive mounting retains the original renderer and eventually restores the complete loaded transcript without requiring a manual rendering mode.

Rendering the entire remainder in one delayed task merely moves the freeze. CSS off-screen layout skipping retains all rendering and parsing work; it does not provide an initial mount budget. Keeping inactive views mounted changes scope and state lifetimes and consumes memory even when the reader leaves; it is not required by this decision.

## Consequences

Initial switching does less rich rendering, but wrapper creation, total work and completed-view memory still grow with loaded history. One unusually expensive message can exceed a frame budget because its renderer is not preemptible. Native search and accessibility browsing can temporarily miss deferred text while the queue fills; all loaded messages become available automatically. Background work must be measured through completion, including the last stall, rather than judging only first paint.

Unit tests pin queue ownership, cancellation, eager fallback, visible priority, retained renderer state and deep-anchor restoration. The assembled scroll suite checks paging, live follow, disclosure retention and restored positions. Its progressive-history expected output records automatic completion, stable visible content and native search without a keyboard shortcut. The [manual browser diagnostic](../../../../benchmarks/long-session-browser/README.md) separates first usable viewport, trusted typing during fill and full rendering completion; it adds no CI timing threshold. The existing [browser performance budgets](../testing/2026-09-06-frontend-performance-budgets.md) remain independently owned.

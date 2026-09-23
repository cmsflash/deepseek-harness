# Agent Note: Billed cost at the session, Turn, and subagent scopes

Status: implemented

English | [中文](2026-09-11-billed-cost-display.zh.md)

## Problem

Every priced model call records `costUsd` on its `assistant/message` usage ([TokenUsage carries billed cost](../architecture/2026-08-24-token-usage-carries-billed-cost.md)), yet no GUI surface displayed it. The three folds that feed the usage displays each dropped the field: the `tokenUsage` session projection summed four token buckets, `deriveTurnTokenUsage` normalized the same four plus reasoning and routes, and the subagent lineage menu read the projection's buckets. A plugin could not close the gap. Projections are Host folds with no Client extension point, the Turn tail and usage pills are built-in renderers, and the one reachable slot, `conversation.chat.collapsedMetric`, receives folded counts and hidden node keys rather than usage.

## Decision

`TokenUsageProjection` and `TurnTokenUsage` gain two required fields: `costUsd`, the sum of every priced attempt's cost, and `unpricedCalls`, the number of billed attempts whose provider published no rate. An unpriced attempt contributes zero to the sum and one to the count. The `tokenUsage` unit's `stateVersion` rises to 3 so the projection cache rebuilds from the log. The Turn fold rejects a negative or non-finite cost as it rejects a malformed count.

Three displays read the fields. The session usage pill under the Composer appends the dollar total after the cache-hit segment and adds a `Cost` row to its dialog; the Turn-tail usage pill appends the Turn's total and adds the same row; a subagent row in the lineage menu places the child's total beside its token count. The figure is always present in an available usage display: a session whose calls all lack a rate reads `$0.0000`, and each dialog's `Cost` row appends `(N unpriced)` whenever the count is nonzero, so a reader can tell a partial sum from a complete one. Amounts use four decimals below one dollar and two from one dollar on, so sub-cent Turns remain distinguishable.

The Turn footer receives accounting through [turn-end history metadata](../architecture/2026-09-22-turn-usage-history-metadata.md), so collapsing or paging details does not change its value or availability.

## Alternatives considered

**Hide the figure when any attempt is unpriced.** An absent pill segment reads as a missing feature, not as a withheld total, and most DeepSeek-routed sessions would never show cost at all. The count on the dialog row carries the same caveat without hiding the number.

**Fill `conversation.chat.collapsedMetric` from a plugin.** The slot's owner props carry counts and node keys; a contributor would have to re-read the Session, which the slot contract forbids, and the figure would duplicate the Turn tail minus the visible final step.

**A dollar figure on the collapsed-steps row.** The row summarizes process, not billing, and already carries six figures; the Turn's cost is one click away in its tail pill. Adding it would require a fourth fold change in `StepDigest` and its merge rule.

**Sidebar or workspace totals.** Session rows are deliberately sparse, and spend across a workspace is an aggregate over a catalog rather than a row decoration; that is a separate view.

## Consequences

Every session shows a dollar figure at every scope a reader thinks in; a DeepSeek route or a gateway model outside pi-ai's catalog contributes zero and is counted in the dialog's `(N unpriced)` note. A parent's total excludes its children, because each child is its own log. Existing sessions gain the figures on next open through the projection rebuild; no migration runs. The [projection tests](../../../../packages/llm/token-meter/tests/token-usage-projection.spec.ts) pin summation, per-attempt replacement, and the unpriced count; the [Turn fold tests](../../../../packages/llm/token-meter/tests/turn-usage.spec.ts) pin the same over attempts and malformed-cost rejection; the ui-chat and ui-subagent component specs pin the pill segments, the dialog rows, and the unpriced note.

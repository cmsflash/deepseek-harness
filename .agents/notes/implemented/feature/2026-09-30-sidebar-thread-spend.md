# Agent Note: Thread spend as the Session row's trailing figure

Status: implemented

English | [中文](2026-09-30-sidebar-thread-spend.zh.md)

## Problem

Each Session row in the sidebar ends with the time since its latest prompt. Order already conveys recency, so the label repeats what the list position shows, while a Session's spend is visible only after opening it: the Composer's usage pill shows the parent's own log, and each subagent's total sits in the lineage menu. A reader comparing threads by cost had to open each one and add up its children.

Two facts make the existing figures unsuitable for a per-row sum. A fork's log begins with its source's events, so `tokenUsage` counts the source's attempts again in every fork; in one measured history, three forks of one long thread each reported over $2,000, of which their own work was $27 to $880. And a subagent's attempts live in its own log, so a parent's `tokenUsage` excludes them.

## Decision

**View options → Show** offers **Last active** (the existing relative time) and **Total cost**. The choice is browser-local, persists with the other view options, and changes neither order nor search; a value persisted before the option existed reads as Last active. The hover card always shows both figures.

Total cost is the thread spend: the Session's own spend plus the own spend of every Session reached from it through uninterrupted subagent-origin lineage. A fork row counts only what happened after its fork point; its source keeps its own total, so no attempt is counted twice across a fork tree.

Own spend comes from a new token-meter projection unit, `ownTokenUsage`. It applies the `tokenUsage` fold, including same-attempt replacement and retry boundaries, only to events at or after the Session's exact fork cut, which `init` receives as `inheritedEventCount`. For a Session that inherited nothing it equals `tokenUsage`. It is a separate key rather than a change to `tokenUsage`, whose meaning the Composer and lineage displays depend on.

An unpriced attempt adds zero, and a row with no usage values reads `$0`; the row carries no unpriced marker. The cell shows cents below $10, whole dollars to $999, and thousands as `K` above that, in tabular numerals.

## Alternatives considered

**Sum `tokenUsage` across the lineage.** It counts every fork's inherited prefix once per fork, which made fork rows show their ancestor's spend instead of their own and inflated any total that included more than one branch.

**Subtract a fork's inherited total in the client.** The client sees the source's current total, not its total at the fork point, and cannot see a source that has since been archived or deleted. Only the fold over the fork's own log knows the cut.

**Mark rows that contain unpriced attempts.** A `+` or dash would distinguish a partial sum, but the row is chosen to read as one plain figure; the Composer dialog's `(N unpriced)` note remains the place that distinction is shown.

**Serve cached rows for cold forks.** The listing skips projection-cache rows for seeded Sessions because the header does not carry the fork cut that completes the cache identity. Matching on the remaining identity fields would show a cold fork's spend without opening it, but it relaxes a documented cache rule; it was deferred, so a cold fork's own spend counts as `$0`.

**Workspace or sidebar totals.** The [billed-cost Note](2026-09-11-billed-cost-display.md) rejected aggregate totals as a separate view. This change keeps that line: each row shows its own thread, and no header sums its members.

## Consequences

Rows can be compared by cost without opening them. A thread's figure includes all of its delegated work, so a parent that spends little itself but runs expensive subagents shows what it actually cost. A fork's figure is its own work.

Two gaps remain. While a fork is not loaded in the Host, its own spend counts as `$0` and its row shows only its subagents' spend, because the list serves cached values only for Sessions that inherited nothing. A cached row checkpointed before `ownTokenUsage` existed carries only `tokenUsage`, so the client reads it as own spend; this is exact because such a row can only reach the list for an unseeded Session. The [projection tests](../../../../packages/llm/token-meter/tests/token-usage-projection.spec.ts) pin the fork cut and checkpoint restore; the ui-workspace [lineage](../../../../packages/client/ui-workspace/tests/subagent-lineage.client.spec.ts), [tree](../../../../packages/client/ui-workspace/tests/tree.client.spec.ts), [row](../../../../packages/client/ui-workspace/tests/rows.client.spec.tsx), and [browser](../../../../packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx) specs pin the sum, the formatting, and the persisted option.

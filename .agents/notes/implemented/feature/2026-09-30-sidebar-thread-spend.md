# Agent Note: Thread spend as the Session row's trailing figure

Status: implemented

English | [中文](2026-09-30-sidebar-thread-spend.zh.md)

## Problem

Each Session row in the sidebar ends with the time since its latest prompt. Order already conveys recency, so the label repeats what the list position shows, while a Session's spend is visible only after opening it: the Composer's usage pill shows the parent's own log, and each subagent's total sits in the lineage menu. A reader comparing threads by cost had to open each one and add up its children.

Two facts make the existing figures unsuitable for a per-row sum. A fork's log begins with its source's events, so `tokenUsage` counts the source's attempts again in every fork; in one measured history, three forks of one long thread each reported over $2,000, of which their own work was $27 to $880. And a subagent's attempts live in its own log, so a parent's `tokenUsage` excludes them.

## Decision

**View options → Show** offers **Last active** (the existing relative time) and **Total cost**. The choice is browser-local, persists with the other view options, and changes neither order nor search; a value persisted before the option existed reads as Last active. The hover card always shows both figures.

Total cost is the thread spend: the Session's own spend plus the own spend of every Session reached from it through loaded parent `subagentCatalog` projections, the same subagent membership the row's activity count reads. A fork row counts only what happened after its fork point; its source keeps its own total, so no attempt is counted twice across a fork tree.

Own spend comes from a new token-meter projection unit, `ownTokenUsage`. It applies the `tokenUsage` fold, including same-attempt replacement and retry boundaries, only to events at or after the Session's exact fork cut, which `init` receives as `inheritedEventCount`. For a Session that inherited nothing it equals `tokenUsage`. It is a separate key rather than a change to `tokenUsage`, whose meaning the Composer and lineage displays depend on.

An unpriced attempt adds zero, and a row with no usage values reads `$0`; the row carries no unpriced marker. The cell shows cents below $10, whole dollars to $999, and thousands as `K` above that, in tabular numerals.

## Alternatives considered

**Sum `tokenUsage` across the lineage.** It counts every fork's inherited prefix once per fork, which made fork rows show their ancestor's spend instead of their own and inflated any total that included more than one branch.

**Subtract a fork's inherited total in the client.** The client sees the source's current total, not its total at the fork point, and cannot see a source that has since been archived or deleted. Only the fold over the fork's own log knows the cut.

**Mark rows that contain unpriced attempts.** A `+` or dash would distinguish a partial sum, but the row is chosen to read as one plain figure; the Composer dialog's `(N unpriced)` note remains the place that distinction is shown.

**Workspace or sidebar totals.** The [billed-cost Note](2026-09-11-billed-cost-display.md) rejected aggregate totals as a separate view. This change keeps that line: each row shows its own thread, and no header sums its members.

## Consequences

Rows can be compared by cost without opening them. A thread's figure includes all of its delegated work, so a parent that spends little itself but runs expensive subagents shows what it actually cost. A fork's figure is its own work.

Three gaps remain. The list serves a checkpoint folded under an earlier Session format only as a title, so a Session whose log predates the current format counts `$0` until opening it migrates and refolds the log. A cached row checkpointed before `ownTokenUsage` existed carries only `tokenUsage`. The list serves cached rows by header for seeded and unseeded Sessions alike, so that total can include a fork's inherited spend, and the client cannot tell which; such a row counts `$0` until the Session is opened and refolded. And a parent's catalog lists only children recorded by catalog events, so a child created before parents recorded them is not part of the thread until the parent's log is migrated with its child facts. The [projection tests](../../../../packages/llm/token-meter/tests/token-usage-projection.spec.ts) pin the fork cut and checkpoint restore; the ui-workspace [tree](../../../../packages/client/ui-workspace/tests/tree.client.spec.ts), [row](../../../../packages/client/ui-workspace/tests/rows.client.spec.tsx), and [browser](../../../../packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx) specs pin the sum, the formatting, and the persisted option.

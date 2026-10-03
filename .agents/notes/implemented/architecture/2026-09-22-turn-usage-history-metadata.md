# Agent Note: Whole-turn usage travels with history end records

Status: implemented

English | [中文](2026-09-22-turn-usage-history-metadata.zh.md)

## Problem

Exact turn accounting needs every started model attempt, including retries, while a browser history window may omit earlier messages or collapsed step interiors. Computing tokens and cost from that window makes a completed turn's disclosure disappear even when the durable log contains complete accounting. Step digests describe process figures, not complete attempt accounting.

## Decision

The Session Controller attaches `turnUsage` to each served `turn/end` record, outside its unchanged durable event. Token-meter owns the environment-neutral accounting fold. A page uses the complete logical source prefix through its requested cut and emits summaries only for the end records it serves. Full, collapsed, and exact-interval reads therefore agree without fetching hidden details. Live follow seeds the same accumulator from its opening observation and advances it once per subsequent accepted durable event.

`null` means exact accounting is unavailable, including incomplete lifecycle evidence, missing usage, conflicting or unsafe totals, and non-finite aggregate cost. Missing prices instead contribute zero and increment the unpriced count. Optional cache, reasoning, and route values retain their completeness rules. The accumulator holds running totals, the active attempt, and distinct routes, not completed attempts or event bodies.

The Client journal keeps this metadata on its accepted entry. `ConversationMatch.record` retains that original entry, with `record.event === event`, so target builders can read authoritative metadata through the existing append, prepend, replacement, and location-replay paths. The Turn footer consumes the end record's result and never substitutes a fold over partial raw events. No separate Client accounting map or durable event is introduced.

The [collapsed-step paging decision](2026-09-01-collapsed-step-digest-paging.md) still owns elision, coverage, and process-row figures. The [cost display decision](../feature/2026-09-11-billed-cost-display.md) still owns display scopes, formatting, and unpriced disclosure; this note owns their history-independent accounting delivery.

## Alternatives considered

**Fetch complete history to show usage.** Rejected because a scalar summary must not undo the byte savings and lazy detail behavior of collapsed history.

**Add the existing step-digest figures.** Rejected because those figures omit retry-attempt accounting and price/completeness information, and page fragments can repeat the same whole-step account.

**Publish a whole-session map of every turn's usage.** Rejected because it grows each baseline and update independently of the history the reader requested. End-record metadata remains bounded by the served records.

**Modify durable events or reconstruct lightweight Assistant messages.** Rejected because accounting is a read model, not a new model-visible fact, and a shortened message would misrepresent the exact event the history record claims to carry.

## Consequences

No Session log format or model behavior changes. The same metadata works for ordinary and validated subagent addresses. A history replacement replaces its accounting with the same records; pagination and expansion do not recalculate or double-count already served totals. Host page reads still scan their source prefix; this decision bounds wire payload and retained live accounting, not cold-read work.

Accounting tests pin retries, optional-field completeness, zero and unpriced amounts, and overflow rejection. Host history tests cover a turn larger than the collapsed page budget, exact cuts, midturn follow, and unavailable accounting. Client tests preserve record identity and authoritative null across replay and replacement. Recorded browser checks keep the token and dollar pill through collapsed reload, expansion, and recollapse.

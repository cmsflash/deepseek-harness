# Agent Note: History pages elide collapsed steps and describe them with digests

Status: implemented

English | [中文](2026-09-01-collapsed-step-digest-paging.zh.md)

## Problem

Collapsing a turn's settled steps hid them from the reader but still shipped every one of their events, so paging cost was unchanged: the transcript a reader could see was a small fraction of what the page carried, and reaching older history took many `load earlier` clicks.

Measured over six real session logs in this repository, a turn's non-final steps are 87–97% of the log by bytes (median ≈ 96%). On the largest — 58 turns, 21,655 events, 13.76 MB — the steps a collapsing reader looks at are 4.6% of the payload. One 50-message page carried 3,243 events and 1.23 MB to show **7 turns**, and reaching the top of that session took 9 pages.

## Decision

`session.history` takes `stepDetail: 'full' | 'collapsed'`. Under `collapsed` the host serves an elidable step as its `step/start` / `step/end` boundaries plus one `StepDigest`, withholding the interior until `session.expandSteps` asks for it. `PAGE_MESSAGES` (50) becomes `COLLAPSED_PAGE_MESSAGES` (300) for those pages, because the point is to reach further back rather than to send a smaller response.

**Boundaries are never elided.** That is what keeps the seq range one contiguous run: the window stays gap-free in the coordinates Conversation Definitions read, `loadOlder`'s continuity assertion still holds on the page tail, and the assembler gains only `spliceInterior` — Matches merge by seq, and every Context an expansion reaches already holds its start Match, because a Step's `step/start` arrived with the page.

**A step is elidable only when the reader is not looking at it.** The turn's highest step is retained, and so is the step carrying the turn's closing assistant text: `turn-tail` picks its closing message, branch anchor, and latency figures from that message, so eliding its step would degrade a settled turn's footer rather than merely hide steps. On the measured session that costs one extra retained step on 2 of 56 turns.

Retention is decided over the whole event range rather than over the page, so a turn split across pages keeps the same steps whole on each; deciding per page would let the boundary change which step counts as a turn's last, and adjacent pages would disagree about the same turn.

**`expandSteps` is bounded by the client's window head** (`fromSeq`). A turn routinely starts before the page that shows it, and its earlier steps belong to pages the client has not loaded; returning them would splice events below the head and leave `baseSeq` describing a range the client no longer holds contiguously.

**Digests are the summary row's figures, and they outlive expansion.** A digest describes a whole step, computed host-side over the whole log, so loading that step's events does not change what it cost. The Session keeps two maps: `stepDigests` (still withheld — drives the fetch-on-open marker) and `stepAccounts` (every account received, expanded turns included). The row folds accounts, and skips any step an account covers when folding loaded nodes, so the two sources never count the same work twice. Without that split the row silently shrank on expansion — 55 steps / 25.5M tokens closed, 33 / 15.3M open.

The summary row's anchor is resolved over the whole render order before any row is emitted, and on node **kind** (the turn's first assistant or tool row). Anchoring on the first row carrying a step coordinate puts the marker above the prompting message, because the engine assigns a step Location by log position, so that message and any context injection carry one too; resolving the anchor during the row walk lets expansion move the row.

`DEFAULT_COLLAPSE_SETTLED_STEPS` ships `true`, so the preference now selects a fetch strategy, not only a presentation.

## Alternatives considered

- **Drop `assistant/chunk` for settled steps.** 39% of the log and pure streaming residue once `assistant/message` exists (only 4 of 1,307 steps ever needed chunk reconstruction). Deferred by the owner as a separable change that also helps the uncollapsed default.
- **Ship the elided events and hide them client-side.** This is the shipped behavior the note replaces; it fixes reading, not paging.
- **Send whole steps and let the client summarize.** Rejected: the client can only fold what it loaded, so the figures would be window-scoped and change as the reader pages — the property the digest exists to remove.
- **Expand per step rather than per turn.** Rejected: the turn is the unit the reader opens, and per-step requests multiply round trips for one gesture.

## Consequences

- On the measured session a page carries 18 turns instead of 7 at equal bytes (1.20 MB vs 1.23 MB), and reaching the top takes 4 pages instead of 9.
- A collapsed page's remaining bulk is `request/header` (141 KB per event, no step coordinate, so never elidable): 67% of one measured collapsed page. It is the binding constraint on any further gain and is untouched here.
- Expanding one turn costs a request sized by that turn: p50 151 KB, p90 528 KB, max 2.15 MB on the measured session.
- Subagent transcripts page whole; the catalog child view has no collapsing reader to serve.
- The summary row's figures are no longer window-scoped, which retires the corresponding consequence in [the step-collapse note](2026-08-14-chat-collapses-settled-steps.md).

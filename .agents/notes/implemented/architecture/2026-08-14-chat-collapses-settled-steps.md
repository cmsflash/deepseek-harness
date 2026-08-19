# Agent Note: Chat collapses a turn's settled steps behind one expandable row

Status: implemented

English | [中文](2026-08-14-chat-collapses-settled-steps.zh.md)

## Problem

A long turn's transcript is dominated by intermediate work. One user round in this repository routinely spends 150+ model calls, and reading it means scrolling past every settled tool call to reach what the agent is doing now. The wanted reading mode keeps the newest model call rendered exactly as today — including while it streams — and reduces the earlier ones to a single line reporting what they cost.

The granularity is the log's own and is easy to get wrong. A `turn` is one user round (`turn/start` → `turn/end` in `agent-loop`); each `step` inside it is one model call with its tool calls. Collapsing per turn answers the wrong question: it hides a whole round behind one row while leaving the 150 steps inside it untouched.

## Decision

`ChatView` groups its already-ordered rows by `(turn, step)` and renders one `CollapsedStepsRow` per turn in place of that turn's non-final steps. The highest step of each turn always renders normally, so the live step stays visible while a turn streams and moves into the collapsed group only once a later step opens. Rows carrying no step coordinate — the prompting user message, the turn tail — never collapse.

Expansion is per turn and all-or-nothing: the marker stays rendered when open and doubles as the control that folds the group back, and the revealed rows go through the same `ChatNodeSeat` as every other row. Reader disclosure is component-local and deliberately unpersisted, because it is a reading position rather than a preference.

The behavior lives inside the Chat view rather than in a second view. A keyed slot is renderable by exactly one entry: `renderSlot` authorization reads `entry.children?.[key]` on the rendering entry with no ancestor walk, and a second declaration of an already-declared key throws at load. `conversation.chat.node` is declared by the chat view entry and filled by `ui-tool`, `ui-goal`, and `ui-workflow-run`, so no sibling view can dispatch those renderers. Building here makes an expanded group identical to an uncollapsed transcript by construction, and keeps working for renderer kinds that plugins merge into `ChatNodeDataMap` later.

The `collapseSettledSteps` preference ships **off** in the durable `ui-conversation` settings section, so the assembled transcript is unchanged until a reader enables it. `ComposerSubmissionPolicy` already owns that section's scope and adoption subscription, so the preference rides it instead of opening a second subscription.

The row is open at one point: `conversation.chat.collapsedMetric` is a list slot whose entries render after every built-in figure. Contributed-last is the contract rather than a shared `order` space, because the row owns figures it may add later and a shared space would silently reshuffle out-of-tree contributors when it does. The disclosure control and the figure strip are siblings so a contributed figure is not nested inside a button. This is what lets a cost display — whose data no in-box adapter records — ship as an out-of-tree plugin.

## Alternatives considered

- **A separate `Focus` view tab.** Rejected after implementation: it cannot reuse Chat's renderers for the reason above, so it hand-rolled approximations that rendered tool calls *worse* than Chat. Its per-turn granularity also collapsed the wrong unit.
- **Move the node-slot declaration up to `conversation.session`.** Rejected: authorization is checked on the rendering entry, so declaring it on an ancestor authorises that ancestor, not the view entries beneath it.
- **Import `ChatNodeSeat` into another view package.** Rejected: its `renderSlot` prop is bound per entry, so the imported seat throws `SlotOwnershipError` from an entry that does not declare the key — and it would breach the cross-package import rule besides.
- **Copy the renderers into a second package.** Rejected: ~4,600 lines duplicated across `ui-conversation` and `ui-tool`, guaranteed to drift, and blind to renderer kinds contributed later.
- **Per-step disclosure.** Rejected: the reader wants the round's outcome or its full detail, and per-step toggles reintroduce the scanning the feature removes.

## Consequences

- Default output is unchanged: with the preference off, `ChatView` maps the snapshot order exactly as before, so existing web snapshots stay valid.
- A collapsed group's figures are window-scoped, because the loaded history window is paged and compaction rewrites it. Paging older steps in changes the numbers.
- Line counts come from the applied `card:'diff'` result views that write and edit already return, validated per entry because those views cross the wire with only `card` schema-checked. A mutation applied by a tool that emits no diff card contributes no lines.
- Turn cost is absent. No model pricing exists in the harness, and the provider adapters discard endpoint-reported spend before the client sees it (`llm-deepseek`'s `mapUsage` builds a token-only `TokenUsage`; `llm-pi-ai` zeroes its catalog `ModelCost`). Adding cost later is a data change, not a view change.

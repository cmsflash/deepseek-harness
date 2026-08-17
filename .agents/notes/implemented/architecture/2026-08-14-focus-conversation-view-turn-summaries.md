# Agent Note: Reading a long session through an additive Focus view, not a collapsing Chat

Status: implemented

English | [中文](2026-08-14-focus-conversation-view-turn-summaries.zh.md)

## Problem

A long session's Chat transcript is dominated by settled intermediate work. Reading it means scrolling past tool calls and prior assistant prose to reach what the agent is doing now. The wanted reading mode is: the latest turn in full — visible while it is still a tool-call turn, not only once it settles — with every earlier turn reduced to the figures that answer "what did that turn cost": turn and call counts, lines changed, wall time, and tokens.

The tempting implementation is to collapse rows inside the existing Chat view. That is not reachable from a plugin, and the slot system says so by construction: `conversation.chat.node` is a keyed slot **declared** by the chat view entry, declaring is claiming, and a second registration for an existing key throws at load. `visibility: 'hidden'` is owned by each Definition for its own Nodes, so no plugin can hide another's row. Collapsing in place therefore means editing `ChatView`'s ordering, paging-anchor, and bottom-follow logic plus its web snapshots — a change to the shipped transcript everyone reads, to add one optional reading mode.

## Decision

The reading mode ships as `@deepseek-ai/dsh-client-ui-focus`, one additive `conversation.view` list entry (id `focus`, order 5) beside chat and trajectory, following the `ui-trajectory` precedent. Chat is not modified. The tab choice already persists per session in the chat store, so the mode is chosen once rather than re-selected per turn, and removing the bundle row drops the tab with no effect on the transcript.

The view owns its rendering and its arithmetic. It reads the target-neutral `ConversationNode` compatibility stream and the engine-owned turn timeline through `useSession`, and registers **no** Conversation Definition: the plugin introduces no business event family, so there is nothing for a Definition to assemble — it is a second reader of what the Chat Definitions already produce. Turn attribution follows log order, with a tool result belonging to the turn of the nearest preceding assistant step; a result preceding every in-window step is dropped rather than misattributed. The latest turn's slice opens at that turn's own `turn/start` seq, so the boundary is the engine's rather than inferred from node kinds, with a step-identified fallback when the start was paged out.

Lines changed is derived, not newly logged. Write and edit tools already return applied `card:'diff'` result views carrying whole before/after images, so the fold is a line-multiset difference per file. Those views cross the wire with only their `card` string schema-validated, so each entry is validated and a malformed one skipped — the same reason `ui-tool`'s `narrowDiffs` exists.

Turn cost is deliberately absent. No model pricing exists anywhere in the harness, and the provider adapters discard endpoint-reported spend before the client could see it: `llm-deepseek`'s `mapUsage` constructs a token-only `TokenUsage`, and `llm-pi-ai` zeroes its catalog's `ModelCost` with the note that no consumer reports spend. Showing cost requires a price source first, so the rows show token counts rather than a rate the harness does not have.

## Alternatives considered

- **Collapse turns inside the existing Chat view**: rejected — unreachable from a plugin (keyed-slot ownership above), and reaching it means editing shipped `ChatView` scroll/paging logic and its snapshots for an optional mode. The user asked for a plugin.
- **Register competing `conversation.chat.node` renderers**: rejected — the keyed slot throws on a duplicate key by design; the conflict is the composition model speaking, not an obstacle to work around.
- **A new host-side per-turn projection**: deferred — it would make figures whole-log instead of window-scoped, but adds a durable projection unit and its persistence for a presentation feature. The view instead states its window scope in the UI (an explicit notice plus the paging control) and in the README.
- **Reuse `sessionStats`/`tokenUsage` for the rows**: rejected — both are whole-session totals with no per-turn breakdown, so they cannot answer what one turn cost.
- **A configurable price table in the plugin**: rejected for now — it would make each row's headline figure depend on hand-maintained rates that silently drift from real billing, and pricing belongs beside the provider that knows the model, not in a view.

## Consequences

- Chat, trajectory, and every shipped Chat Definition are untouched; the tab is purely additive and independently removable.
- Every figure is window-scoped by construction, because the loaded history window is paged and compaction rewrites it. The band renders the truncation notice and paging control while older history is unloaded, and a turn whose `turn/start` is outside the window reports no wall time.
- The latest turn renders a reduced transcript (prose, reasoning, terminal cards, raw arguments) rather than the chat view's full keyed tool cards, images, and per-message actions, because those renderers belong to the slot chat declares. Rich cards stay one tab away.
- Lines changed covers only tools that emit diff cards, and counts a moved line as unchanged.
- Adding cost later is a data problem, not a view problem: the rows already carry the token buckets a price source would multiply.

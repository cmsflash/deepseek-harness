---
description: "Browser Chat target that renders Session conversation nodes, historical images, actions, localization, and scroll state."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-chat

English | [中文](README.zh.md)

## Summary

Renders recorded Session conversations with historical images, localized actions, and restored scroll position. Compact display folds completed-turn process rows while keeping the final answer and independently useful context visible; collapsed-steps display folds each turn's context injections and settled intermediate steps behind one summary row. Local transcript and steering submissions appear immediately in their original surface and disappear atomically when authoritative Session records arrive; queued submissions stay outside Chat. File-mention providers receive the viewed Session ID with the closing-turn owner, so inherited-history links can address the fork. The package does not assemble or modify model requests.

## Table of Contents

- [Reference previews](#reference-previews)
- [System prompt row](#system-prompt-row)
- [Turn token usage](#turn-token-usage)
- [Completed-turn footer](#completed-turn-footer)
- [Turn Process Folding](#turn-process-folding)
- [Settled Step Collapse](#settled-step-collapse)
- [Scroll ownership](#scroll-ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="reference-previews"></a>
## Reference previews

Chat supplies file and HTTP(S) navigation through one `MarkdownDelegateProvider` around its node list. Assistant Markdown file links open in the right Sidebar after the message settles, including references to unmodified files. Relative paths resolve in the viewed Session's workspace; absolute paths retain the same Session's filesystem access. `#L24` and `#L24-L30` navigate to the first specified line and reuse an existing file tab. Missing files show the preview's error state.

HTTP(S) links in Assistant Markdown open a new right-Sidebar Browser tab on ordinary clicks when that type is registered, or the system browser otherwise; modified clicks retain the native external-link behavior. Sent file references and skills confirmed by the message’s logged invocation also open in the right Sidebar. File paths use the viewed Session; skill names resolve through its current input-trigger source. Both use the prose file-link dotted underline on hover or focus. Sessions, directories, and command labels remain non-navigating references.

<a id="system-prompt-row"></a>
## System prompt row

Each nonempty appended `system/message` owns a collapsed prompt row, including a complete prompt at the start of a headerless window; the same-step header does not duplicate it. Chat also shows a collapsed `System prompt` row for a non-empty initial request, explicit message-series start, or `system/message` surface node replacement whose text differs, reading the last nonempty surviving system node in surface order at the `request/header`; a non-initial request whose preceding header is outside the loaded history window also shows one. A resume repeats the row even when its system text is unchanged, including after pagination supplies the preceding header and system node; same-series config-only or tool-only changes, tool steps, and retries create no repetition, and a `system/message` event is never rendered as a transcript message. The row appears before that request's user messages, matching the provider envelope, and expands to the exact model-visible text with its original line breaks. A request whose system node is empty or outside the loaded window creates no row until the page holding the node arrives.

<a id="turn-token-usage"></a>
## Turn token usage

A completed Turn reads its expandable usage row from the Host's `turn/end` record metadata, so tokens and cost remain available in collapsed history and when the turn start is outside the loaded page. Expanding steps or loading older pages does not change the authoritative total. The row omits unavailable optional buckets. Missing or null accounting hides the complete disclosure instead of reconstructing a partial total from loaded events. The Turn pill and the session usage pill under the composer each append the billed dollar total, summing the priced attempts in scope; the dialog's `Cost` row appends `(N unpriced)` when any attempt lacked a rate, so a partial sum is never mistaken for the whole spend ([billed cost display](../../../.agents/notes/implemented/feature/2026-09-11-billed-cost-display.md)).

After Assistant replies settle, the completed-turn timing dialog omits TTFT and decoding speed, both after live replies and after reopening history. Elapsed turn time remains available. The Session Stats pill reads timing independently from its durable projection.

<a id="completed-turn-footer"></a>
## Completed-turn footer

The completed-turn action footer starts 20px below the preceding prose or extension content.

-----

<a id="turn-process-folding"></a>
## Turn Process Folding

Each reasoning row starts collapsed, including during streaming and in reasoning-only replies. Clicking the row opens or closes its complete Markdown; incoming answer text, Tool calls, and stream completion preserve that choice. Expanded reasoning uses compact secondary typography: headings add bold weight without changing text size, line height, or color. The collapsed summary stays on one line, follows the latest reasoning line while streaming, and shows the first line after settlement.

Settings → General exposes a persisted, localized `Normal` / `Compact` / `Collapsed steps` conversation-display preference in the `ui-chat` namespace; `Compact` is the default. Normal leaves process rows visible and renders no Turn-process control; Collapsed steps replaces the Turn-process control with the [per-step fold](#settled-step-collapse). In Compact mode, the System prompt remains independently visible before the opening User throughout the Turn. Context injection, reasoning, Assistant material, Tool rows, and Retry rows remain expanded while a Turn is open. At `turn/end`, its latest Step becomes the final-answer boundary only when it contains non-blank text, an image, or an unknown visible block—and no Tool-call block; preceding Context injection, reasoning, earlier Assistant material, Tool rows, and Retry rows then collapse by default. The control reports Turn-wide durable counts for non-subagent Tool calls, reply-bearing Assistant messages before the final answer, and subagent delegation calls; zero-valued segments are omitted, the Tool and subagent figures are mutually exclusive, and neither System prompt nor Context injection contributes a count. When all three counts are zero, the process still folds and the control reads `Thought for a while`. A full-width divider below the summary separates it from the answer or expanded process rows. User and steering messages, System prompt, error, max-token, and turn-tail rows stay outside, and a closed Turn with no final answer keeps all process evidence visible. A newly available process control is inserted without changing the relative order of existing rows: opening human input precedes the control and process rows from their first projection, while System prompt remains above that input. While older history remains available through Load earlier, process controls stay absent and no members are hidden; once history is complete, every eligible closed Turn uses the collapsed default immediately. Stable Chat Node Seats keep every renderer mounted, hidden members add no flow spacing, and a closed control sits 8px above its answer only when no independent input intervenes. Completion collapse does not depend on tail-follow position, so a reader above the tail may see the transcript reflow. An automatic collapse that would hide keyboard focus keeps the group open and leaves focus in place; a manual close focuses the process control before hiding its members. The session-scoped store records only manually expanded Turn-and-answer-Step generations; a different answer generation starts collapsed.

-----

<a id="settled-step-collapse"></a>
## Settled Step Collapse

A turn is one user round and each step inside it is one model call, so the reading cost of a long turn is its intermediate steps rather than its answer. In `Collapsed steps` mode every turn keeps only its highest step rendered — the live one while it streams — and folds its earlier `assistant-step` and `tool-call` rows into one `CollapsedStepsRow` reporting the elapsed time, steps, tool calls, tokens, added and removed lines, and distinct files they produced. Settled tool roots and nested dispatch outcomes each count one call. Host and Client file figures share `appliedFileDiffs` in `dsh-tools/presentation`: failed outcomes contribute no diff; usable metadata supplies hunks; a successful `write` without hunks uses its recorded whole-file argument image. That fallback also represents identical overwrites, so its volume is not a measured net filesystem change. Nested dispatches record no diff metadata. Recorded paths are deduplicated across steps, and a touched empty file remains visible even when line volume is zero. Every context injection owned by the turn also folds into this summary, including injections beside its last or live step; the row reports `X context injections` and can contain only that count for a single-step turn. Context records are counted independently of step digests because history pages retain those messages. Human and steering messages, the turn tail, and context without a resolved turn stay visible. Opening the row restores the hidden rows in place through the same keyed node seat, so an expanded group renders exactly like an uncollapsed transcript; disclosure is per turn, all-or-nothing, reader-owned, and not persisted. The row is open at one point: `conversation.chat.collapsedMetric` is a session-scoped list slot whose entries render after every figure the row computes itself, so a contributor never reserves an `order` band against figures the row may gain later; the owner passes the collapsed group's turn, the node keys it hides, and its folded step and call counts, so a contributor can identify the materialized hidden nodes. Digest-only steps have no node key until their events are loaded. Reading the whole turn instead would include the still-visible last step in metrics for hidden assistant/tool work. The disclosure control and the figures are siblings, so a contributed figure may carry interactive content without nesting inside a button.

The mode also selects a history-reading preference: `collapsed` pages carry boundaries and a `StepDigest` per elidable step until expansion retrieves the interior. Each account describes a whole step and survives expansion, while a partial turn's total can grow when older pages add more steps. Loaded events remain in memory when the preference changes. A full-detail consumer such as Trajectory overrides the preference for that Session object and restores its loaded interval; Chat still folds its rendering. A turn with all events present expands without another request, and the row reports an in-flight expansion ([digest paging](../../../.agents/notes/implemented/architecture/2026-09-01-collapsed-step-digest-paging.md), [full-detail recovery](../../../.agents/notes/implemented/bug-fix/2026-09-10-consumer-required-full-history.md)).

-----

<a id="scroll-ownership"></a>
## Scroll ownership

Chat restores semantic anchors across history prepend and renderer remounts. Pinned scroll deliveries without reader movement update follow ownership immediately, before subsequent layout changes can invalidate their floor. Reader movement remains pending until the sampling interval or `scrollend`, even inside the follow threshold, so layout growth cannot erase small scroll gestures. While the reader is pinned to the floor, `ResizeObserver` follows the new floor and selects the latest loaded Turn without reading row geometry. Once the reader moves away, flow-height changes preserve the top position and the reading-line geometry selects the active Turn. Turn-rail previews paint above sticky Markdown code-block banners, while the rail frame remains inside the transcript band above the composer.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders logged conversation state in the browser and registers nothing model-facing.

#### KV Cache effect

None; Chat presentation does not assemble or mutate provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The transcript reflects the loaded Session window** — older transcript nodes become available only after Session Controller loads the preceding event page. Turn navigation is wider than the window: the rail merges the loaded Turns with the host `turnOutline` projection, so every started Turn gets a fixed-pitch mark (10px apart; a ladder taller than the frame scrolls inside it with gradient fades), and activating an unloaded mark pages history through the Turn's `turn/start` seq before landing on its row. Without the projection (assemblies not mounting `dsh-session-turn-outline`) the rail falls back to loaded Turns only.
- **Rail previews are card-sized** — one prompt line (50 characters) and up to three response lines (120), on loaded and unloaded Turns alike; an unloaded Turn's response arrives from the outline only once the Turn settled, so an open Turn previews its prompt (or just the Turn number) until then.
- **Collapsed-step metrics show no cost of their own** — `TokenUsage.costUsd` carries a priced call's dollars, so a cost figure is a `conversation.chat.collapsedMetric` contribution rather than a built-in. A `StepDigest` carries no cost; contributors needing omitted usage must request full detail before pricing those steps.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Conversation and Slot registration enforce Chat target consistency.

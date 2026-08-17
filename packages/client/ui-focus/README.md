# @deepseek-ai/dsh-client-ui-focus

English | [中文](README.zh.md)

Focus conversation view, browser half: one additive `conversation.view` entry (id `focus`, order 5) that renders the latest turn in full above a band of collapsed per-turn metric rows. It exists for reading a long session without scrolling through settled tool calls: every earlier turn becomes a single line carrying its step and call counts, added/removed lines, files touched, wall time, and token spend, followed by one summed total line. The current turn keeps its prompting message, assistant prose, reasoning, and every tool call — including a call still in flight, so a tool-only turn is visible from its first frame rather than after it settles. When the next turn starts, the turn that was rendered in full collapses into one more metric row.

The view derives every figure itself from the target-neutral `ConversationNode` stream and the engine-owned turn timeline, both read through `useSession`. It registers no Conversation Definition and publishes no Location data, because it introduces no new business event family: the plugin is a second reader of what the Chat Definitions already assemble. Turn attribution follows log order — a tool result belongs to the turn of the nearest preceding assistant step — and the latest turn's slice opens at that turn's own `turn/start`, so the boundary is the engine's, not inferred. Lines changed come from the applied `card:'diff'` result views that write and edit tools return; because those views cross the wire with only their `card` string schema-validated, the fold validates each entry and skips a malformed one instead of throwing inside a render.

Chat is untouched: `conversation.chat.node` is declared, and therefore owned, by the chat view entry, so this plugin renders its own rows rather than dispatching another view's keyed renderers, and removing the `ui-focus` row from the bundle drops the tab with no effect on the shipped transcript.

The `/client` exports are the plugin body (`apply`/`inject`), the `FocusView` component with its injected face type, and the pure folds the view is assembled from.

## Composition

```yaml
- id: ui-focus
  name: '@deepseek-ai/dsh-client-ui-focus'
```

Injects `slots` (the view ring), `sessions` (ordinary history paging), and `locale`. The tab label reads through the bound translate as a thunk, so it follows the active locale without re-registration.

## Model Experience

None, as the plugin only folds already-logged session events into a browser-side read model: it sends no request, writes no session event, and contributes no prompt, tool schema, or tool result, so which view tab is active never changes what the model receives.

#### KV Cache effect

None; the plugin never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Figures are window-scoped, not whole-log** — the loaded history window is paged, so a summary describes the turns currently loaded. The band renders an explicit notice and the paging control while older history remains unloaded, and a turn whose `turn/start` is outside the window reports no wall time. Per-turn attribution has no durable projection to ride: `sessionStats` and `tokenUsage` are whole-session totals, so a per-turn equivalent would need a new host-side projection unit.
- **No turn cost** — no model pricing exists anywhere in the harness, and the provider adapters map wire usage into token-only `TokenUsage` (`llm-deepseek`'s `mapUsage`) while `llm-pi-ai` explicitly zeroes the catalog's `ModelCost`, so endpoint-reported spend never reaches the client. Displaying cost requires a price source first; the rows show token counts instead of inventing a rate.
- **Lines changed only covers diff-card tools** — a mutation applied by a tool that returns no `card:'diff'` result view (a shell `sed`, a script) contributes no lines, and the count is a line-multiset difference over whole before/after images, so a moved line reads as unchanged and a modified line as one addition plus one removal.
- **Files touched sums per-turn counts in the total line** — one file edited across several turns counts once per turn there; the per-turn rows remain exact.
- **The latest turn renders a reduced transcript** — prose, reasoning, terminal cards, and raw arguments, but not the full keyed tool cards, images, or per-message actions that the chat view's registered renderers provide. Reach for the Chat tab when a call needs its rich card.

# Agent Note: Per-model reasoning effort memory

Status: implemented

English | [中文](2026-09-01-per-model-reasoning-effort-memory.zh.md)

Builds on [adapter-owned reasoning effort capabilities](../../archived/architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.md), which owns the effort vocabulary and its validation; this note adds only which level the picker preselects.

## Problem

The composer's model seat reset the reasoning effort on every model switch. `ModelSelect`'s `choices` memo built each candidate selection from `model.reasoning?.defaultEffort` alone, and the model-list click site passed only `{provider, model}`, so a user who ran one model at a non-default level lost that choice the moment they switched away: coming back re-applied the adapter default. The `/model` popup's `selectionOf` had the same rule, keeping the live route's own effort but resetting for every other row.

Two memories existed, and neither covers this. The session's active `ModelSelection` is one `(provider, model, effort)` triple, durable through the request header the Host records per step; `agent-default-model` stores one more triple as the global default for future sessions. Both describe the *current* selection. Neither says anything about the effort a user prefers on a model they are not currently using, which is exactly what a switch needs to preselect.

## Decision

The effort last selected for an exact route is user preference, so it lives in the Host's live configuration: the `ui-model-selection` profile entry declares a volatile `rememberedEfforts` Config field, a dict mapping `provider/model` to an effort id, which the Settings service persists through the active profile's patch. Selecting an effort writes that route's entry; selecting a model reads it and submits it. A route with no usable entry submits what the picker submits without memory: no effort in the composer, so the adapter default applies per request, and the declared default from a `/model` row.

The field is declared by this package's node half, which until now was the empty apply that only made the plugin appear in the Loader. That keeps one package owning the whole feature — the field, both read paths, and the write — and required no host, wire, or schema change: Settings forms project any entry's volatile Config, `ctx.configForms.get` derives the entry's form from the shared describe mirror, and `ui-chat` and `ui-conversation` already follow the pattern. A per-model field on `ModelCatalogModel` would have been the other obvious home and would have rippled through `sessions.ts`, the zod schemas, `api-remotes`, the fake API, and the RPC schema specs to store something no Host component reads.

`EffortMemory` owns both directions over that form, and `apply` constructs one instance shared by both entries, so a level chosen in the composer preselects in `/model` and the reverse.

Three rules make the memory advisory rather than authoritative, matching how the catalog is already treated:

- **The adapter owns the vocabulary.** A remembered id absent from the model's current `reasoning.efforts` counts as no entry, because adapters rename and drop levels between runs. Without that check a stale id would ride into `selectModel` and fail the switch the user asked for.
- **Only an accepted level is recorded.** `chooseEffort` remembers after the Host returns success, so a refused effort cannot be preselected into a selection that fails again.
- **A write never fails the switch.** The selection has already landed on the Host by then; a refused configuration write is swallowed and the next selection rewrites from reloaded state.

`null` records an explicit provider-default choice, distinct from an absent key that carries no choice: the effort pane offers a provider-default row whenever the model declares no default, and collapsing the two would make choosing it a no-op. The field keeps its 200 most recently written routes — it accretes one entry per model ever selected and is read whole on every describe — and re-selecting a route reinserts it so it counts as recent.

The plugin deliberately offers no settings row and opts out of a generated page with `configure({ auto: false })`. It is machine-managed state whose useful edit gesture is the picker itself, so it stays durable without becoming a form the user has to reason about.

## Consequences

The picker preselects the level a user last ran on the model they switch to, across sessions, browsers, and Host restarts. Nothing else about selection moved: the Host still validates every submitted effort, the session log still records what a request actually used, and `agent-default-model` still owns the default for new sessions.

`ui-model-selection` gained a node half with real behavior, so a deployment composing the browser row without the node row exposes no form. The form then reports `unavailable`, `effortFor` reads an empty memory, and the picker behaves exactly as it did before this change — adapter defaults, nothing remembered.

The seat's injected face gained `effortFor` and `rememberEffort`, so every `ModelSelect` construction site supplies both. The package's settings edge is a service injection (`configForms`), which makes the browser half depend on the settings plugin being composed; the manifest, tsconfig, and bundle declarations record that edge.

One gap stays open, and the README records it: the field has no settings row, so a wrong entry is corrected by selecting the level again or editing the profile patch. Adding a row would mean rendering a dictionary of opaque route keys, which is a worse surface than the picker itself.

## Alternatives considered

**A browser-local memory (`localStorage`).** `createSnapshotStore` supports persistence, and this needs no Host at all. Rejected because the plugin's own contract is that "the host stays the single fact source and the store is one shared echo" — a second browser-local truth beside the Host's directory is the fork that comment exists to prevent. It also fails the case that motivated the feature: a preference that does not follow the user to another browser is not remembered.

**A per-session memory in `ModelDirectory`.** Cheapest, and wrong in a way that is easy to miss: `ModelDirectory` is per-session browser memory, so the map would die on a page refresh while surviving a Host restart. That is the opposite of the durability a user expects from "remember".

**Recording the memory in the Host's `selectModel` handler.** The write is one line from `saveDefaultModelSelection`, and it would cover every future client. Rejected because the read still has to reach the browser, which means a new wire field and its full schema ripple, to store a value only the picker consumes.

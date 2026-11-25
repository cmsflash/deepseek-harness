---
kind: upgrade-guide
description: "Workspace follow consumers must apply complete registry commits, and older writers discard reporting attachment state."
---

# Workspace reporting attachment and registry commits

English | [中文](guide.zh.md)

## Change

Workspace `follow` now sends a `registry` increment for a changed global commit instead of independent `order`, `archived`, `pinned`, or `parents` increments. Its `value` carries `workspaceIds`, `archivedSessionIds`, `pinnedSessionIds`, `sessionParents`, and `detachedSessionIds` together. Consumers that reject unknown frame types must update with the Host.

The durable `detachedSessionIds` array defaults to empty for existing data: old Sessions remain attached, with no backfill. A detached Report retains its visual parent but reports to the human. Builds without this field strip it on their next Workspace global-state write; this is not downgrade-safe.

## Migration

1. Back up the Harness home before rollout. Upgrade every writer of that home together; do not open it with an older build after setting attachment state.
2. Update custom `workspace/follow` consumers to apply every field of a `registry` increment atomically. Default an absent baseline `detachedSessionIds` to `[]`. Parent and attachment unary responses are receipts, not complete relationship snapshots; use the ordered feed for display state.
3. Reload browser Clients with the matching build. On an isolated test home, set attachment with `workspace/setSessionAttachment({ request: { sessionId, parentSessionId, attachment: 'detached' } })`, where `parentSessionId` is the expected current parent. Confirm the returned detached set, unchanged parent link, and retained state after restart. Clearing the parent must remove its marker in the same registry increment.
4. If rollback is necessary, restore the pre-rollout backup with its matching build rather than letting an older writer silently erase attachment state.

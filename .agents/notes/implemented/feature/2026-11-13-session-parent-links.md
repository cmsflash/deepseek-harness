# Agent Note: Session parent links live in the Workspace registry

Status: implemented

English | [中文](2026-11-13-session-parent-links.zh.md)

## Problem

An agent programme runs as a tree of Sessions: a managing Session starts other Sessions, which may manage Sessions of their own. Workspace grouping surfaces listed every Session of a Workspace as one flat row, so the tree was visible only through naming conventions in Session titles. A grouping surface needs a durable record of which Session a Session sits under, and a caller outside the browser needs a way to set it.

## Decision

- The link is registry-global state in the [Workspace registry](../../../../packages/workspace/workspace/README.md): `sessionParents`, a map from a child Session id to the id of the Session it nests under, stored in the `workspace` domain's global state beside the archive and pin sets. The field defaults to empty and the domain version stays 2.
- `WorkspaceRegistry.setSessionParent(sessionId, parentSessionId | undefined)` sets or clears one link. The [Workspace controller](../../../../packages/api/workspace-controller/README.md) serves it as `workspace/setSessionParent`, returns the complete map, includes the map in the `workspace/follow` baseline, and sends a `parents` frame after each committed change to it. No session event, tool, or prompt carries the link, so models do not see it.
- Setting a link refuses without a write when the child is its own parent (`self`), when the child is already an ancestor of the parent (`cycle`), when the two Sessions belong to different Workspaces (`cross-workspace`), when either Session has subagent origin (`subagent`), or when no Workspace's `sessionIds` contains one of them (`unaccounted`). Each of these fails as `workspace/session-parent-invalid` with that reason; an unknown Session fails as `session/not-found`. A Session in no Workspace therefore cannot be nested.
- Archive state is not consulted: a managing Session archives finished Sessions, and their place in the tree must survive, so archived Sessions can be linked and archiving changes no link.
- A link ends when either Session leaves its Workspace's durable account. Deleting a Workspace drops the links of its Sessions in the global-state write that removes it from the order. A `detachSession` or a prune of filtered candidates changes one table record, which no write can combine with the global state, so the entity reports the removed ids and the registry drops their links in one write that follows; a failure of that write is logged. At start the registry drops every link with an end on no durable account, which also repairs a crash or failure between those two writes.
- `sessionParents` is optional in `WorkspaceBaseline` and `WorkspaceSnapshot`, although the Host and the Remote-backed Client model always supply it. The Client model replaces its `sessionParents` object only when an entry changes, so consumers can memoize on its identity.

## Alternatives considered

**Session logs or Session headers.** A header field or a session event would make the link part of the released Session format, its exports, and its chain hashes, and anything in the log is a candidate for model-visible context. The link is display grouping that a caller can set again, so it belongs with the other grouping state the registry already owns.

**A field on each Workspace record.** Storing the links of a Workspace's Sessions in its own record would let a detach or a prune drop them in the same write. It would also split one map across records, add the map to the `Workspace` entity's write path, and depart from how the archive and pin sets are stored and streamed. The two-write lifetime with a repair at start costs less than that.

**Raise the `workspace` domain version.** A build without the field would then refuse to open the registry at all. That turns a silent loss of display grouping into a Host that does not start, which is worse than the loss.

**A separate storage domain for the links.** Builds without the feature would never open it, so the links would survive them. It adds a second durable owner whose lifetime has to be reconciled with Workspace accounts across two domains, for a case that keeping the feature in every build serving a home avoids.

**A required `sessionParents` on `WorkspaceBaseline` and `WorkspaceSnapshot`.** The types would say what the Host always sends, but 24 hand-written `WorkspaceSnapshot` literals in the tests of 9 Client packages outside the feature would each have to change, and so would every downstream branch that carries such a literal. Readers use `?? {}` instead.

**Keep the links of a deleted Workspace.** Nothing returns a Session to a Workspace account after its Workspace is deleted, including adding the same directory again, so the kept links could never be shown.

## Consequences

- A build that predates `sessionParents` parses the registry state without the field and drops it. When such a build opens a home that a build with the feature wrote, its next write of the registry's global state (creating, deleting, or reordering a Workspace, archiving, unarchiving, pinning, or unpinning a Session) stores the state without the map, and every parent link is gone without an error. Nothing else in the registry is affected: Workspace records, order, the archive set, and the pin set are written as before. The links are display grouping, so the callers that set them can set them again.
- Between an entity write that removes a Session from an account and the registry write that follows it, the map can name a Session on no account; consumers treat a child or parent they do not hold as no link, and the next start removes the entry if the second write never commits.
- Each `setSessionParent` call scans every Workspace's account for the two Sessions, which is linear in the number of accounted Sessions; the call is explicit and rare, so the registry keeps no index.
- Consumers that read the optional field carry a `?? {}` fallback, which should be one module-level constant so the fallback is referentially stable.

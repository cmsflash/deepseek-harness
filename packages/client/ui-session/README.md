---
description: "React and Slot adapters for Session Controller lists, interaction state, and per-session context."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-session

English | [中文](README.zh.md)

## Summary

Use this package to expose Session catalog, retain information, and unified UI status through standard Slot hooks. It materializes per-`SessionBinding` hooks and props, while `SessionProvider` can inherit an outer binding or bind an explicit `SessionReference`. It owns process-local pending-interaction and completion-reminder policy without owning Controller transport, history, or references.

Running status comes from Host list baselines or status events. Subagent catalog rows and retained subagent fallback rows do not establish running status; main view references still acknowledge completions.

## Table of Contents

- [Dependency waits](#dependency-waits)
- [Access Hooks](#access-hooks)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="dependency-waits"></a>
## Dependency waits

Domains publish dependency waits with `ctx.uiSession.provideDependencyWaits(source)`, an observable map from a Session to what it waits on outside the user and its Agent. A wait appears as that Session status's `dependencyWait` while its source lists it, compared by description, so an equal rebuilt wait notifies nobody. When two sources name one Session, the earlier registration wins; a source leaves with the plugin that provided it.

<a id="access-hooks"></a>
## Access Hooks

The package injects the Client `remoteAccess` service and publishes Session access Hooks over its `source()`: the root `useSessionAccess(sessionId, action)` answers on one Session resource, and the Session-scope `useAccess(action)` answers on the bound Session's resource; the `global` resource's answer is a different Hook, `useRemoteAccess(action)`, so neither shadows the other. `ctx.uiSession.whenAccess(sessionId, action, callback)` is the JS counterpart of `useSessionAccess`: it keeps the callback's effects installed while the current Peer may call `action` on that Session, with the semantics of `ctx.remoteAccess.whenAccess`. The SessionMaybe-scope `useAccess(action)` returns `undefined` while no Session is bound, which callers treat as not allowed; a decision on the `global` resource reads `useRemoteAccess` instead. Snapshot semantics belong to [`dsh-api-remote-access`](../../api/remote-access/README.md#client-face).

<a id="model-experience"></a>
## Model Experience

None, as this package adapts browser-side Session state and registers nothing model-facing.

#### KV Cache effect

None; Session selectors and Slot scopes do not assemble model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Pending interactions are process-local projections** — the owning Remote waterfall must replay an outstanding request after a browser reconnect.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

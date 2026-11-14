---
description: "Verified browser-side copy of Session stored log lines: IndexedDB storage, one downloader per origin, and copy-served history reads for the dsh web client."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-local-copy

English | [中文](README.zh.md)

## Summary

Use this package to keep a verified local copy of every ordinary thread's stored log lines in the browser's IndexedDB and to serve complete threads' history from that copy before the Host is asked: reopened tabs render at once even while offline, and one device-wide memory budget bounds what live Sessions hold. Reads the copy does not cover fall back to the Host unchanged. The plugin runs one worker per tab in a secure browser context and downloads in the background under an origin-wide lock.

## Table of Contents

- [What is stored and where](#what-is-stored-and-where)
- [Budgets and configuration](#budgets-and-configuration)
- [Download policy](#download-policy)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-is-stored-and-where"></a>
## What is stored and where

Every origin keeps its own `dsh-local-copy` IndexedDB database:

- `threads` — one record per thread: the header line and its link, the head seq and link, stored line bytes, chunk count, the Host cursor last seen, the copy state (`downloading`, `complete`, `unverifiable`, `paused`), the last problem, open and sync times, and the session-list activity its last download was made for.
- `chunks` — the stored lines as up-to-1 MiB UTF-8 chunk records keyed `[sessionId, firstSeq]`, with the end offset of every line and its 32 link bytes. Every write stores the chunk(s) and updates the thread record in one transaction, comparing the stored head first, so a tab that lost a race leaves the other tab's copy untouched.
- `meta` — schema version and the offline-replay migration marker.

A copy only ever holds lines the Host verified against its Session log chain: downloads check every line's link from the stored previous link, and live or resumed lines are appended only when they continue the stored head.

A storage error fails only the read or write it occurs in; a failed read reaches the page with the browser's error name (such as `UnknownError` or `QuotaExceededError`) as its code, and Sessions then read from the Host. The worker opens its database again after the browser closes the connection (iOS after suspension, or another tab opening a newer schema) and after a failed open, so neither leaves the tab without a copy until a reload.

A complete copy answers a Session's opening at once; a copy that does not yet hold the whole log answers it only while the Host is unreachable, with its opening page marked `partial`. The Session then reports `incompleteCopy` until a Host opening confirms the window, and Chat's offline notice adds "The saved copy of this thread is incomplete."

<a id="budgets-and-configuration"></a>
## Budgets and configuration

Defaults follow the device (coarse pointer plus a sub-600 px short side):

| Setting | Desktop | Phone |
| --- | --- | --- |
| `scope` | `all` | `opened` |
| `memoryBudgetBytes` | 104,857,600 | 26,214,400 |
| `diskBudgetBytes` | 0 (unlimited) | 1,073,741,824 |
| `chunkBytes` | 1,048,576 | 1,048,576 |
| `minPauseMs` | 100 | 300 |
| `warmFollowGraceMs` | 30,000 | 30,000 |
| `readerLoadGraceMs` | 30,000 | 30,000 |
| `enabled` | true | true |

Because the browser half of a plugin cannot be configured from a profile patch, the effective values are read from `localStorage['dsh.localCopy']` at startup: a JSON object with any of these fields, validated against the same schema; invalid values are ignored with a warning.

<a id="download-policy"></a>
## Download policy

One dedicated worker per tab downloads one thread's one chunk at a time under the origin-wide Web Lock `dsh-local-copy/download`, starting no earlier than three seconds after startup so page requests are never competed with. The queue order is: threads opened in this tab, then the newest-opened threads on this device, then (scope `all`) every other ordinary, unarchived Session from the session list, newest activity first. After each chunk the loop waits the larger of `minPauseMs` and four times its own busy time. A complete copy rejoins the queue when the session list reports activity its last download was not made for: a later prompt, a change of running state, or a projection watermark past the stored head. That refresh fetches only the lines after the stored head, checked from its link like any continuation, so a closed thread is current after each prompt and each turn end a page's list reports; during a turn the copy keeps the turn's start until the next such report or until the thread is opened. With scope `opened`, only threads opened on this device are refreshed.

Failures: a chain mismatch or an unverifiable line parks the thread as `unverifiable` and retries at most hourly (and immediately when the thread is opened); the Host refusing to serve lines, or answering another 4xx status, pauses it for ten minutes; network errors, 5xx, and 404, 401 or 403 (a restarting or re-authenticating Host's answers) back off from one second to five minutes; any other failure of a thread's round, such as a malformed response or a storage error, pauses that thread for ten minutes so the queue moves on, and opening the thread retries it at once. With `diskBudgetBytes` above zero, the worker makes room for every chunk before storing it by deleting whole copies least-recently opened first (never one opened in the last ten minutes) and parks the thread with a quota problem when the chunk still does not fit; a browser `QuotaExceededError`, raised by the write or by its aborted transaction, runs the same deletion (none without a budget) and retries the write once before parking. The queue skips a thread parked for quota until the thread is opened again. A thread's open time is refreshed on every open, so eviction always drops the least recently opened copy.

<a id="model-experience"></a>
## Model Experience

None, as the plugin stores and serves Session log lines in browser storage and registers nothing model-facing.

#### KV Cache effect

None; the plugin stores and serves stored log lines and assembles no provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- iOS ITP can delete the whole copy after seven days of Safari use without visiting the site; a Home Screen web app keeps a separate copy.
- Subagent children are not copied.
- The Desktop app is excluded (`dshDesktop` detect); browser storage only.
- Stored chunks are not compressed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

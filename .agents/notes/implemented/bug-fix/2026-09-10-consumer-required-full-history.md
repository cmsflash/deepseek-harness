# Agent Note: Full-detail readers preserve the loaded Session interval

Status: implemented

English | [中文](2026-09-10-consumer-required-full-history.zh.md)

## Problem

A collapsed history page intentionally omits step interiors. Trajectory cannot reconstruct tool records from summary figures, and reopening the Session at a smaller full-detail page budget discards history the reader already loaded. A recovery read can also see a durable assistant message before its live end frame permits that message to replace the streaming prefix.

## Decision

A Trajectory source subscription calls `Session.requireFullHistory()`. The requirement lasts for that Session object's lifetime and takes precedence over the Chat detail preference. This follows Conversation's monotonic target activation: an activated builder continues receiving updates after its visible component unmounts. Resolving a source without subscribing does not demand a read.

Detail changes preserve materialized events. Full-detail recovery uses `session.page` with `fromSeq` and the captured journal cursor to read exactly the loaded interval, without a message budget or a new follow connection. The Host validates the interval and the Client refuses a response that is not complete and dense. Only interiors covered by the captured pages enter the splice; unrelated durable tail events remain subject to the assistant stream's terminal-frame ordering.

Recovery retains the loaded head, older-page availability, and step accounts. Concurrent requests share one operation. A physical window replacement invalidates older responses; newly prepended omissions remain marked and receive a subsequent read. Trajectory withholds its timeline and table until the omissions are filled, and exposes failed recovery with an explicit Retry action rather than presenting partial records as complete.

This partially supersedes the preference-triggered window reopening in [digest paging](../architecture/2026-09-01-collapsed-step-digest-paging.md). That note remains the authority for elision, retention, and whole-step accounts.

## Alternatives considered

**Change the global preference and reopen follow.** This affects other Sessions, loses the loaded range, and reconstructs an active assistant prefix unnecessarily. A consumer requirement belongs to the Session it reads.

**Give Trajectory an independent history reader.** A second reader would duplicate cursor, connection, cancellation, and reconciliation ownership already held by the Session Controller.

**Downgrade after the component unmounts.** Conversation keeps previously activated targets current. Returning to compact transport while such a target remains active would make its cached snapshot incomplete again.

## Consequences

An explicitly requested full-detail view increases later paging traffic for that Session instance. Chat can still collapse its rendering, and a fresh Session instance whose selected view is Chat can use collapsed transport again. No model input, tool execution, or persisted Session generation changes merely because a view requires full detail.

Unit regressions cover exact intervals, failed and stale reads, concurrent paging, shared recovery, and the assistant commit ordering. The recorded-session [Trajectory scenario](../../../../snapshots/web/trajectory-full-detail/snapshot.yml) pins omitted tool recovery through the assembled browser and after a page reload.

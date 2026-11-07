# Agent Note: Resumable Session follow

Status: implemented

English | [中文](2026-11-03-resumable-session-follow.zh.md)

## Problem

Every `session/follow` reconnect, including each brief network drop and Host restart, sent a complete snapshot of up to 500 messages, although the browser already held all but the events written during the outage. The snapshot replaced the held window, so older pages the reader had loaded by scrolling up were dropped. A 3.8 MB snapshot dominates reconnection on a slow link, and compressing the WebSocket to shrink it adds about 8 ms per MB to an opening when the browser and Host share a machine (loopback comparison, Nov 3, 2026).

A cursor alone cannot continue a window safely. Live events reach followers up to 200 ms before they are written, so after a crash the Host reuses those seqs for different events, and a Session format migration renumbers events.

## Decision

The Host keeps a Session log chain for every log it holds: SHA-256 links over the exact stored bytes of the log's JSONL lines. The header link is `SHA-256("dsh-session-chain/1" ‖ headerLine)`; the link of the event at seq `n` is `SHA-256(link(n − 1) ‖ line(n))`, where a previous link enters as its 32 raw bytes and a line is the stored UTF-8 bytes of one record without its newline ([definition](../../../../packages/session/session-persistence/README.md#the-session-log-chain)). The JSONL backend computes links when it reads a log, from the raw bytes of each committed line, and when a write handle accepts an event: it encodes the event to its line once, links that `Buffer`, and later writes the same `Buffer`, so the link of a live event equals the link a later read computes. A cold read of an interrupted log links the turn closers it adds in memory with the same encoding the write path uses when the resumed Agent appends them, so their links equal the stored ones and an interrupted thread resumes like any other. Links are kept with the logs the Host already holds, a live Session's write handle and the cold-read caches, at 32 bytes per event (up to twice that while a write handle's buffer is still growing).

Every record that `follow`, `page`, and `events` serve, and every live event frame, carries `link` when the log has a chain; a record standing for withheld events carries the link of the last one. A reconnecting follow sends `resume: { afterSeq, link }`, naming the last seq its newest held record stands for and that record's link. The Host answers with a `resumed` opening that carries every event after `afterSeq` at full detail, with the current header, projection baseline, and Assistant baseline, when its link at `afterSeq` equals `link` and at most `followResumeEvents` events follow (Session Controller configuration, default 1,000; 0 disables resume). Every other case opens with a complete snapshot, exactly as without a resume point; a malformed resume point fails with `gateway/bad-request`. A follow that stays open across a promotion checks once, at its first live event, that the live log still has the opening's link at the opening cursor, and ends the generation otherwise, so the Client reconnects and gets a snapshot.

`RemoteJournalStream` owns the Client side for a domain that sets `resumeEntries`: it keeps the newest held entries, offers them to each reconnecting generation, accepts a `resumed` opening only after the cursor that generation was offered, and publishes a `resume` change with the new entries. Any snapshot opening replaces the window, including one whose cursor is behind the held window, because the Host log is the authority after a crash. `SessionEventStream` keeps one entry and offers its link; a newest record without a link opens with a snapshot, while a snapshot opening that ends at the offered seq with the offered link continues the held window instead of replacing it, so offline reading, which replays the opening it recorded, keeps the pages the reader loaded. A resumed reconnect keeps the Session's older pages, step digests and expanded turns, rebuilds live Assistant rows from the new baseline, and adds settlements staged for an attempt that ended during the outage.

Offline replay keys a `session/follow` record without the request's resume point and folds a resumed opening that continues the record into one snapshot, so the record still replays from its first item.

## Alternatives considered

**Compare the newest held events field by field.** A resume point listing the newest 16 events as `{ seq, time, type }` with the header's `version` and `createdAt` checks a few fields of the tail only: a log that kept those values but lost or changed an earlier event, or changed an event's content, would be joined to the held window. One link covers the header and every byte through `afterSeq`, and keeping links costs 32 bytes per event, up to twice that while a write handle's buffer is still growing.

**Link events only once they are written.** Live events reach followers up to 200 ms before their batch is written, so live frames would carry no link and a reconnect soon after a live event could not resume.

**Hash re-encoded events.** Re-encoding a decoded event need not reproduce the stored bytes of lines that another build or a format migration wrote, and a planned browser-side copy of each Session log, not built yet, will hash the stored text it receives; hashing stored bytes gives both one definition.

**Compress every opening.** permessage-deflate shrinks a snapshot to about a quarter and remains useful for remote clients, but it still resends what the browser holds and adds about 8 ms per MB to an opening when the browser and Host share a machine (loopback comparison, Nov 3, 2026): 29 ms for a 3.8 MB Session.

**Resume by cursor alone.** A bare seq cannot detect crash reuse or renumbering, so a resumed window could silently join two logs.

**Compose `observeEvent` and `events`.** Live Assistant frames exist only on `follow`, `observeEvent` has no cursor, and two calls lose the single read point that the header, events, projections and Assistant baseline share.

**Use a Host boot epoch.** An epoch detects a restart but not which events survived it, so every restart would force a snapshot; the link lets a reconnect resume across a restart whenever the held events were written.

**Append resumed events to the rendered window in place.** The Session republishes its window as one replacement so the Assistant fold, staged settlements and submission echoes rebuild from one list; reconnects are rare enough that this Client-side rebuild costs less than a second publication path.

## Consequences

A reconnect transfers only the events written during the outage plus the projection and Assistant baselines, and keeps the pages the reader loaded; after a Host restart it resumes whenever the held events were written. Each record grows by about 74 bytes for its link, about 2% of a large snapshot, and a cold read hashes every line, about 1.6 µs per 3.3 KB event. The Client does not verify links; it returns the Host's own link, and that planned browser-side copy will compute the same chain from the stored text. Records without a link cannot be resumed from: logs prepared or published by a format migration until their current generation is read again, and logs served without a persistence backend that keeps a chain. The projection baseline stays complete because the Client clears projection values at every new connection; its turn outline grows by about 200 bytes per turn. A resumed opening carries no older-history bound or step digests, so it never changes `hasMore`. A window survives offline reading only when the replayed opening ends at it; an offline copy that recorded live events after its opening replays that shorter opening, which replaces the window. A Host whose log lost or rewrote held events answers with a snapshot that can move the window backwards; earlier Clients failed such a reconnect as a protocol violation.

Opening a Session again resumes only while the Client still holds its window; a Session object released by navigation opens with a snapshot. This decision partially supersedes the reconnect rules of the [Session history and event transport](2026-08-18-session-history-and-event-transport.md) and [Session observations](2026-08-25-session-observations-and-projection-owned-client-state.md) notes, which keep their other decisions.

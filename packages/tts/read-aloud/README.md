# @deepseek-ai/dsh-read-aloud

English | [中文](README.zh.md)

Read-aloud audio for completed turns: a `turn/end` listener that synthesizes each turn's closing prose through [`ctx.tts`](../tts/README.md), a filesystem cache under the Harness home, and the `readAloud` Remote a browser plays it through.

Audio is regenerable presentation, never durable Session state. Nothing here appends to the Session log, `SESSION_FORMAT_VERSION` is untouched, and a cache miss is an ordinary outcome resolved by synthesizing again.

## Trigger

The service follows `session/event` and acts on `turn/end`. Three conditions each mean no audio and no request:

| Condition | Why |
|---|---|
| `reason.kind !== 'completed'` | An interrupted turn has no settled closing prose to read. |
| `session.header.origin === 'subagent'` | A subagent transcript has no playback surface, so synthesizing it would bill for audio nothing can play. |
| the closing message carries no text block | A step that only called tools has nothing addressed to a reader. |

Spoken text is the concatenation of the closing assistant message's `text` blocks. `reasoning` blocks are thinking traces rather than prose addressed to the reader, and `tool-call` blocks carry arguments; neither is ever sent to a provider. The turn's LAST `assistant/message` is its closing step — earlier steps of a multi-step turn end in tool calls rather than a reply.

## Storage

Artifacts live at `$DSH_HOME/cache/speech/<message-id>.mp3`, owner-only, published atomically through a staging file so a concurrent read never observes a partial write. Message ids are opaque and may not be filesystem-safe, so every key is percent-encoded. An artifact older than `ttlDays` reads as a miss and is deleted by the startup sweep.

## Remote (`readAloud`)

| Method | Semantics |
|---|---|
| `audio({ sessionId, messageId })` | Return base64 mp3 for one message. Serves the cache when it holds the artifact, otherwise synthesizes and stores it. `value.regenerated` says which happened. |

The Host resolves the spoken text from its own Session log, so a browser sends message identity and never prose. Failures are values, not throws: `session-not-found`, `message-not-found` (including a message that is not its turn's closing step), and `synthesis-failed` with provider detail.

A turn-end job and a playback request for the same message join one in-flight synthesis, so a race bills once.

## Config

| Field | Semantics |
|---|---|
| `ttlDays` | Days an artifact is served before it is swept. |
| `synthesizeOnTurnEnd` | Synthesize every completed turn as it ends. False leaves synthesis to the first playback request, trading latency for spend on turns nobody plays. |

## Model Experience

None, as synthesized audio is presentation that never enters the session log or a model request, so the model cannot observe whether a reply was read aloud.

#### KV Cache effect

None; nothing this package does touches the history tail.

## Known Limitations and Deferred Work

- **Always-on synthesis bills for audio nobody plays** — every completed turn is synthesized, and a working day produces hours of audio of which most is never played. `synthesizeOnTurnEnd: false` trades that spend for first-play latency; a foreground-only or per-session trigger is the finer lever and is not implemented.
- **The sweep runs only at startup** — a long-lived process retains expired artifacts on disk until it restarts, though they already read as misses. Expiry is enforced on read, so nothing stale is ever served.
- **No cache-size bound** — retention is by age alone. A burst of long turns inside the TTL window is bounded only by that window.
- **Chat view only** — the Remote addresses any finalized message, but only the Chat transcript's action strip offers playback; the trajectory and waterfall views render no control.

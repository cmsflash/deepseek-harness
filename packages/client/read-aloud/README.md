# @deepseek-ai/dsh-client-read-aloud

English | [中文](README.zh.md)

Per-message read-aloud plugin, browser half: one play/stop button contributed as the `speech` entry (order 20) of the `conversation.chat.assistant-actions` strip. The strip is declared by `ui-conversation` and rendered inside the finalized assistant message's IconActions row, after the feedback controls, so the button inherits that row's chrome and hover behavior. Only finalized messages reach the slot — an interruption-frozen partial carries no `messageId` and therefore no control. The strip renders once per turn, on the closing assistant message that owns the turn's IconActions row.

One `SpeechPlayer` per Session backs every message control in that Session, which is what enforces the single-stream rule: starting one reply stops whatever was playing, so two replies never overlap.

Audio arrives through `ctx.remote.readAloud`. The Host resolves spoken text from the Session log by `messageId`, so this half sends message identity and never prose — no conversation surface has to carry the text, and `AssistantActionOwnerProps` is unchanged. Because the Host synthesizes each turn's audio when the turn ends, a click normally plays an artifact that already exists; a miss regenerates and is an ordinary outcome rather than an error.

A load superseded by a later click is discarded, so a slow synthesis cannot resurrect playback the user already moved on from. A connection reset stops playback: a dropped transport cannot be recovered mid-stream, and audio outliving it would keep speaking into a disconnected UI.

The `/client` exports are the plugin body (`apply`/`inject`), the `MessageSpeechAction` component, the `SpeechPlayer` class, and the injected face types.

## Model Experience

None, as read-aloud is presentation that never enters the append-only Session log or the model context; the model cannot observe whether a reply was played.

#### KV Cache effect

None; playback touches no request prefix.

## Known Limitations and Deferred Work

- **No playback controls beyond play and stop** — no seek, speed, or resume-from-position. Stopping discards position, so replaying restarts the reply.
- **Failure is reported on the control, not in prose** — a failed load turns the button red with a tooltip; there is no retry affordance beyond clicking again, and the underlying reason (missing provider, gateway error) is not surfaced to the user.
- **Chat view only** — the trajectory and waterfall views render no playback control even though their assistant nodes carry the same `messageId`.
- **No cross-tab coordination** — a second tab plays independently, so the same reply can speak twice on one machine.

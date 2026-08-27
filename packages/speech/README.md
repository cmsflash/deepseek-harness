# speech/ — speech synthesis capability family

English | [中文](README.zh.md)

This family turns text into audio behind one provider-neutral service, plus the consumer that reads completed turns aloud in the Web GUI.

| Package | Role | ctx key |
|---|---|---|
| [`speech/`](speech/README.md) | Defines speech provider registration, selection, and the resolve-then-synthesize policy | `ctx.speech` |
| [`speech-openai-compatible/`](speech-openai-compatible/README.md) | Provides synthesis through an OpenAI-shaped gateway | registers on `ctx.speech` |
| [`speech-cache/`](speech-cache/README.md) | Synthesizes each completed turn and serves the cached audio to a browser | `ctx.speechCache` |

Synthesized audio is regenerable presentation: it never enters the Session log, so no durable format carries it and a cache miss simply synthesizes again.

The [read-aloud decision](../../.agents/notes/implemented/feature/2026-08-14-assistant-reply-read-aloud.md) records why audio is a cache rather than an attachment, and what the always-on trigger costs.

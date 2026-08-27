# Agent Note: Read-aloud of assistant replies

Status: implemented

English | [中文](2026-08-14-assistant-reply-read-aloud.zh.md)

## Problem

A completed turn's prose is the part of an agent transcript a human most often wants without reading: a summary of what happened and what to do next. The Web GUI presents it as text only, so consuming it requires eyes on the screen.

Speech is presentation, not model input, so it never enters the model context or the Session log. The design question is therefore not whether the log can carry audio, but where synthesized audio lives, when it is produced, and what it costs to produce it for every completed turn.

## Decision

A `ctx.speech` capability seam synthesizes the closing prose of every completed turn as soon as that turn ends, and the Web GUI plays the finished artifact instead of converting on demand.

### Capability seam

Three roles, per the [capability-seam rationale](../../implemented/architecture/2026-06-13-capability-seams.md):

- **Service Definition** `dsh-speech` owns `ctx.speech`, the request/spec split, and the audio vocabulary. It resolves a request into a spec explicitly, so no provider hides a default inside `synthesize()`.
- **Service Provider** `dsh-speech-openai-compatible` calls `/audio/speech`, registering one provider per configured route ([route design](../architecture/2026-08-25-speech-openai-compatible-routes.md)). The Web bundle pins the LiteLLM route: MiniMax is not OpenAI-compatible at the vendor API (`/v1/t2a_v2`, not `/v1/audio/speech`), so the gateway's dedicated adapter is the integration point rather than an OpenAI base-URL override.
- **Consumers** are `dsh-speech-cache`, the host-side `turn/end` listener that produces audio and owns the `speechCache` Remote, and `dsh-client-ui-message-speech`, the browser plugin that plays it.

### Trigger and text selection

The host listens for `turn/end` and synthesizes the turn's closing assistant message. `turn/end` carries `{ turn, reason }`, so interrupted turns are skipped by reason rather than by inspecting content.

Spoken text is the concatenation of `type: "text"` blocks of that message. `reasoning` and `tool-call` blocks are excluded: thinking traces are not addressed to the reader, and tool arguments are not prose. A message with no text block produces no audio.

The host resolves the text from the Session log by `messageId`, the way `dsh-message-feedback` resolves its target. The browser sends an identifier, never the prose, so `AssistantActionOwnerProps` keeps carrying `messageId` alone and `ui-conversation` is unchanged.

Subagent sessions are excluded. Their turns have no user-facing playback surface, and including them would synthesize roughly 50,000 characters per day that nothing can play.

### Storage

Audio is a regenerable cache, not durable Session state, so it lives under `$DSH_HOME/cache/speech/` keyed by `messageId` and is swept by age on startup. Nothing is appended to the Session log, `SESSION_FORMAT_VERSION` is untouched, and no durable format review is required.

A cache miss is an ordinary outcome: the browser requests synthesis and plays the result. Expiry, eviction, and a cold machine therefore share one path, and the retention window can change without a migration.

### Configuration

Every deployment-varying value is a validated `Config` field, per the no-hardcoded-tunables rule: `model`, `voice`, `bitrate`, `ttlDays`, and `maxChars`. The Web bundle ships `minimax/speech-2.6-hd` at 64 kbps with a 7-day TTL, pinned to the `litellm` route.

Bitrate is a pure storage lever on MiniMax, which honors it; OpenAI's own models ignore it and return 128 kbps regardless. MiniMax bills `usage_characters`, the input count, so audio quality has no price effect; the vendor's own response example returns 111,789 bytes for 6.931 seconds at 128 kbps, which is constant-bitrate mp3 to within 1%, so bytes scale exactly with the setting. Latency is unaffected in any way a listener notices: synthesis time tracks text length, and the transfer difference is a few hundred kilobytes on a local network.

64 kbps rather than 32 is the shipped default because LiteLLM's MiniMax adapter documents `64000, 128000, 192000, 256000` for mp3. 32,000 is a MiniMax-documented value that this adapter does not list, so the lowest setting proven through this path is 64 kbps. A deployment that verifies 32 kbps end to end can set it and halve storage again.

The model is pinned to a `2.6` identifier because LiteLLM's price map has no entry for `speech-2.8-*`; those models work but report zero cost, which would silently break spend accounting.

`maxChars` bounds one request. MiniMax accepts 10,000 characters synchronously, and a longer closing message is truncated rather than split, because a partial reading is a better failure than an unbounded bill.

### Package manifests carry the generated artifact's imports

`dsh-speech-cache` declares `zod` even though no file under `src` imports it: Typert emits the `./remote` codecs with a top-level `import { z } from 'zod'`, that artifact is inlined into the Client bundle importing it, and a bundler can only inline a module pnpm linked for a declared dependency. `scripts/check-workspace-constraints.ts` now asserts this for every package exporting the canonical `./remote` pair, because the convention held across five packages with nothing enforcing it ([postmortem](../../../../docs/postmortem/0005-undeclared-zod-broke-web-plugin-boot.md)).

`tsconfig.base.json` maps `@deepseek-ai/dsh-client-ui-message-speech` explicitly. Client package names prefix their group directory, so the generic `@deepseek-ai/dsh-*` wildcard cannot reach them and `verify-cordis-config` requires the entry.

## Measured cost

Figures below come from this machine on 2026-08-14: the DSH Session logs, the OpenCode desktop and dev SQLite stores, and the LiteLLM console.

Volume, treating combined past usage across all three installations as the DSH forecast, counting main-thread closing messages only: **523,842 characters per day**.

| | per day | per year | share of daily spend |
|---|---|---|---|
| MiniMax HD ($100/M chars) | $52.38 | $19,120 | **10.1%** |
| MiniMax turbo ($60/M) | $31.43 | $11,472 | 6.3% |
| OpenAI tts-1 ($15/M) | $7.86 | $2,868 | 1.7% |

The denominator is measured, not modeled: the LiteLLM console reports **$3,255.50 over seven days**, or $465/day. The blended Anthropic rate there is $1.25 per 1M tokens, roughly twelve times below list input price, because prompt caching dominates. Token counts multiplied by list prices overstate this baseline about sixfold and must not be used.

At 16.2 characters per second — the rate implied by MiniMax's own 112-character, 6.931-second response example — the same volume is **9.0 hours of audio per day**:

| bitrate | per day | 7-day steady state |
|---|---|---|
| 32 kbps (not offered by the LiteLLM adapter) | 129 MB | 0.90 GB |
| 64 kbps (shipped default) | 259 MB | **1.81 GB** |
| 128 kbps (MiniMax default) | 517 MB | 3.62 GB |

Session logs grow about 8.6 MB per day compressed under the same forecast, so audio at 64 kbps is roughly thirty times the log growth rate and about 97% of new bytes per day. The TTL, not the byte count, is what keeps that bounded.

## Alternatives considered

**Browser `speechSynthesis` instead of a server seam.** Zero cost, zero keys, offline. Rejected on quality: OS voices are robotic, and the feature exists to be pleasant to listen to. It also needs the spoken text in the browser, which would mean widening `AssistantActionOwnerProps` and stripping Markdown client-side — strictly more coupling than the server design.

**Generalize `AttachmentStore` to audio.** The attachment seam is image-shaped in every method and type, and `ImageAttachmentRef` carries `width`/`height`. Generalizing it would touch the definition, the local provider, and about a dozen consumers including the API proxy and Session export, and would put regenerable bytes into the durable attachment path. Rejected as a larger change that buys durability the feature does not want.

**Synthesize on first play.** Cheapest, and it pays only for audio someone hears. Rejected because it reintroduces the latency the always-on trigger exists to remove: the first press of Play would wait for a full synthesis round trip.

**MiniMax turbo, or OpenAI tts-1.** Turbo halves the cost at lower quality; tts-1 is a sixth of the cost and would suit English-only reading. Both lose to the explicit instruction to use MiniMax's best models. The measured content is 0.00% CJK, so MiniMax's multilingual and emotional range is unused capability being paid for — worth revisiting after listening to both.

**`/tmp` rather than `$DSH_HOME/cache`.** Simpler and self-cleaning. Rejected because macOS purges `/tmp` on boot, so every restart would re-pay for recent replays; `$DSH_HOME/cache/speech/` stays inspectable and deletable while surviving reboots.

## Testing

Package suites pin the seam's selection table and the explicit `resolve` step, the provider's request mapping and every failure arm, the cache's trigger rules and store semantics, and the browser plugin's registration, single-stream playback, and disposal.

Behavior the tests hold in place:

- A completed non-subagent turn produces a cached artifact with no user action, and the strip plays it without a synthesis round trip.
- An interrupted turn, a turn whose closing message carries no text block, and a subagent turn each produce no audio and no request.
- A cache miss regenerates and plays; expiry, eviction, and a cold machine share that one path.
- `reasoning` and `tool-call` content never reaches the provider, pinned against a message carrying all three block kinds.
- A turn-end job and a playback request for one message join a single in-flight synthesis, so a race bills once.
- Disposing the owning fiber removes the `turn/end` listener, the provider registration, and the slot entry.

Two arms carry `v8 ignore` justifications rather than contrived triggers: the staging-cleanup rejection needs the staging file to vanish between a failed rename and its unlink, and the stale-generation arms around `play()` need a still-pending audio promise superseded by a later toggle. The element-event guards cover the same supersession rule deterministically.

## Consequences

Read-aloud costs nothing structurally: audio never enters the Session log, so `SESSION_FORMAT_VERSION`, the attachment path, and durable replay are untouched, and the retention window changes without a migration. The host resolving text by `messageId` keeps `AssistantActionOwnerProps` carrying identity alone, so `ui-conversation` is unchanged and no conversation surface has to carry prose.

**The recurring cost is material.** MiniMax HD adds about 10% to current spend, $19,120 per year at the measured forecast, for audio that is mostly never played — 9 hours per day exceeds any plausible listening. `synthesizeOnTurnEnd: false` trades that spend for first-play latency; a foreground-only or per-session trigger is the finer lever and is not implemented. Bitrate is not a cost lever at all: billing is by input characters, so a quieter file costs the same.

**The speech rate comes from one vendor example.** 16.2 characters per second is derived from the single 112-character, 6.931-second response in MiniMax's API reference, not from a documented rate, and it does not hold for CJK. Every duration and byte figure inherits that uncertainty. The provider records `extra_info.audio_size` and `audio_length` when a backend reports them, so the estimate can be replaced with measurement.

**Character billing is not character count.** MiniMax bills a CJK character as two. Measured content is 0.00% CJK, so this is currently free, but a shift to Chinese output roughly doubles cost against the same character count.

**Volume forecasting rests on a short window.** The measured corpora span 6–11 days with heavy burst variance, and combined totals across three installations are not deduplicated, so migrated threads may be double-counted. The daily rates are order-of-magnitude.

**Vendor rates differ by region.** MiniMax's domestic price list (¥2/¥3.5 per 10k characters) is roughly half the international list ($60/$100 per 1M). The figures here use the international list, which matches LiteLLM's price map and this deployment.

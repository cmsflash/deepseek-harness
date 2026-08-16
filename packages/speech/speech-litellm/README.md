# @deepseek-ai/dsh-speech-litellm

English | [中文](README.zh.md)

Registers a gateway-backed `SpeechProvider` with `ctx.speech`, under the id `litellm`. It does not own the `ctx.speech` key — it registers INTO the seam's registry, exactly as `@deepseek-ai/dsh-web-search-exa` registers into `ctx.web`. The key is owned by [`@deepseek-ai/dsh-speech`](../speech/README.md).

## Why a gateway rather than a vendor adapter

The gateway exposes one OpenAI-shaped `POST /audio/speech` for every speech vendor it routes, so a vendor whose native API differs is reachable without a per-vendor adapter here. MiniMax is the motivating case: its own endpoint is `/v1/t2a_v2`, not `/v1/audio/speech`, so pointing an OpenAI client at a MiniMax base URL fails — the gateway's dedicated adapter is what makes the route work.

## Config

| Field | Default | Semantics |
|---|---|---|
| `apiKey` | `$LITELLM_API_KEY` | Gateway credential. Empty makes the provider unavailable, so the seam reports `SPEECH_PROVIDER_UNAVAILABLE` rather than failing per request. |
| `baseURL` | `$LITELLM_BASE_URL`, else `http://127.0.0.1:4000` | Gateway base; `/audio/speech` is appended. |
| `timeoutMs` | 120000 | Request deadline. Synthesis of a long reply takes longer than a chat completion. |

The credential is read from the launch environment because the product trusts the project it is launched in; the managed credential store is not involved.

## Request mapping

The seam's `SpeechSpec` becomes the gateway's OpenAI-shaped body: `model`, `input`, `response_format: 'mp3'`, and `voice` when the spec names one. `bitrate` rides `extra_body`, which the gateway forwards to the vendor verbatim — the OpenAI speech schema has no bitrate field, and MiniMax reads it from `audio_setting`.

Every failure — non-2xx, empty body, transport error — becomes `SpeechError` `SPEECH_REQUEST_FAILED` with the status and any response detail in the message. An empty body is a failure rather than a cached silent artifact.

## Model Experience

None, as this provider is reached only through `ctx.speech`, which contributes no prompt or schema, and no synthesized audio reaches a model request.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **No usage passthrough** — the OpenAI-shaped response body is audio bytes with no usage envelope, so `billedCharacters` and `durationMs` are omitted even when the vendor reports them. Recovering them needs a gateway response header or a vendor-native call.
- **Model identifiers are unvalidated** — an unknown model reaches the gateway and fails there. This is deliberate: the gateway owns its route table, and mirroring it here would go stale.
- **Spend tracking depends on the gateway's price map** — a model missing from it synthesizes normally but reports zero cost. Pin a model the gateway prices, or patch its map, when spend accounting matters.

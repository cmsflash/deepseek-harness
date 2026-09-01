# @deepseek-ai/dsh-openai-tts

English | [中文](README.zh.md)

Registers one `SpeechProvider` per configured route with `ctx.tts`, each under its route's map key. It does not own the `ctx.tts` key — it registers INTO the seam's registry, exactly as `@deepseek-ai/dsh-web-search-exa` registers into `ctx.web`. The key is owned by [`@deepseek-ai/dsh-tts`](../tts/README.md).

## Why one package for every route

OpenAI's `POST /audio/speech` and a gateway in front of other vendors take the same request and return the same reply, so a route differs only by base URL and credential. One package hosts them all through a `providers:` map, following [`@deepseek-ai/dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.md) rather than a package per vendor.

A gateway route additionally reaches vendors whose native API differs. MiniMax is the motivating case: its own endpoint is `/v1/t2a_v2`, not `/v1/audio/speech`, so pointing an OpenAI client at a MiniMax base URL fails — the gateway's dedicated adapter is what makes the route work.

## Config

`providers` is a required map from provider id to route. Each route:

| Field | Default | Semantics |
|---|---|---|
| `apiKeyEnv` | — | Environment reference holding the credential. |
| `apiKey` | — | Literal credential, for a deployment that uses no reference. Wins over `apiKeyEnv`. |
| `baseURL` | `https://api.openai.com/v1` | Route base; `/audio/speech` is appended. |
| `baseURLEnv` | — | Environment reference holding the base URL, for a route whose host varies by deployment. |
| `timeoutMs` | 120000 | Request deadline. Synthesis of a long reply takes longer than a chat completion. |

```yaml
providers:
  litellm:
    apiKeyEnv: LITELLM_API_KEY
    baseURLEnv: LITELLM_BASE_URL
  openai:
    apiKeyEnv: OPENAI_API_KEY
```

A route whose credential resolves empty still registers and reports `available() === false`, so a deployment that pins it is told the route is unusable rather than unregistered. Credentials are read from the launch environment because the product trusts the project it is launched in; the managed credential store is not involved.

Registering more than one usable route without setting the seam's `provider` makes selection ambiguous — `SPEECH_PROVIDER_AMBIGUOUS` — because no route is a defensible default.

## Request mapping

The seam's `SpeechSpec` becomes the OpenAI-shaped body: `model`, `input`, `voice`, and `response_format: 'mp3'`. `bitrate` rides `extra_body`, which a gateway forwards to the vendor verbatim — the OpenAI speech schema has no bitrate field, and MiniMax reads it from `audio_setting`.

`voice` is always sent. The route rejects a request without one, and answers it with an opaque 500 rather than a 4xx, so an omitted voice is indistinguishable from a dead route.

Every failure — non-2xx, empty body, transport error — becomes `SpeechError` `SPEECH_REQUEST_FAILED` with the status and any response detail in the message. An empty body is a failure rather than a cached silent artifact.

## Model Experience

None, as this provider is reached only through `ctx.tts`, which contributes no prompt or schema, and no synthesized audio reaches a model request.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **`bitrate` is advisory, not portable** — it reaches the vendor as `extra_body`. MiniMax honors it; OpenAI's own models ignore it and return 128 kbps mp3 regardless. The seam's field name promises more than every route delivers.
- **No usage passthrough** — the OpenAI-shaped response body is audio bytes with no usage envelope, so `billedCharacters` and `durationMs` are omitted even when the vendor reports them. Recovering them needs a response header or a vendor-native call.
- **Model identifiers are unvalidated** — an unknown model reaches the route and fails there. This is deliberate: the route owns its model table, and mirroring it here would go stale.
- **Voice identifiers are unvalidated and vendor-specific** — a voice valid on one route may be rejected by another, and the failure surfaces only at synthesis. Changing `provider` generally means changing `model` and `voice` together.
- **Spend tracking depends on the gateway's price map** — a model missing from it synthesizes normally but reports zero cost. Pin a model the gateway prices, or patch its map, when spend accounting matters.

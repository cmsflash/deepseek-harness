# Agent Note: one speech provider package for every OpenAI-compatible route

Status: implemented

English | [中文](2026-08-25-openai-tts-routes.zh.md)

## Problem

`dsh-openai-tts` named a vendor in its package identity while implementing a wire format. Serving OpenAI's own TTS meant a second package — `dsh-speech-openai` — whose provider would differ from the first only by base URL and credential, since both speak `POST /audio/speech` with the same request and reply. A package per vendor multiplies packages by the count of hosts speaking one format.

Separately, the seam could not produce a working request. `SpeechSpec.voice` was optional and both `resolve()` and the provider omitted the field when unset, but an OpenAI-shaped `/audio/speech` route rejects a request that carries no voice. Every synthesis call failed against a real route with no voice configured, and the route answers a malformed request with an opaque 500 rather than a 4xx, so the failure was indistinguishable from a dead endpoint and was originally diagnosed as a broken gateway.

## Decision

One package, `dsh-openai-tts`, hosts every OpenAI-shaped route through a required `providers:` map from provider id to route config, following `dsh-llm-pi-ai`'s established multi-provider shape rather than a package per vendor. `apply` registers one `OpenAiTtsProvider` per entry, keyed by the map key, so the seam's existing selection table governs which route runs.

A route resolves its credential from `apiKey` or the `apiKeyEnv` reference, and its host from `baseURL`, the `baseURLEnv` reference, or the public OpenAI API. `baseURLEnv` exists because cordis.yml has no `${VAR}` interpolation, so a deployment-varying host must be a named reference exactly as the credential is. A route whose credential resolves empty registers anyway and reports `available() === false`, so pinning it yields `SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE` rather than `CONFIGURED_MISSING`.

`TtsRuntimeConfig.voice` and `SpeechSpec.voice` are required. `resolve()` fills the voice from the request or the deployment config, and the provider always sends it. The default lives in deployment config rather than a `?? 'alloy'` inside the provider, per the explicit-over-implicit rule: voice vocabularies are vendor-specific, so no library value is portable enough to inherit silently.

`bitrate` stays a required seam field but is documented as advisory: it reaches the vendor through `extra_body`, which MiniMax honors and OpenAI ignores.

## Alternatives considered

- **A second `dsh-speech-openai` package** — rejected. Its provider would be a near-copy of the gateway one, and the duplication grows with each host speaking the same format. The differences that matter are configuration, not code.
- **A per-vendor adapter interface inside the package** — rejected as unowned abstraction. Every route in evidence speaks one wire format; a vendor whose API genuinely differs (MiniMax's `/v1/t2a_v2`) is already reached through a gateway adapter, which is why the gateway route exists at all.
- **Defaulting `voice` to `'alloy'` in the provider** — rejected. It hides deployment policy in a provider, and the value is not portable: it happens to work on both routes tested here, but a vendor with its own vocabulary would fail at synthesis with the default looking correct in config.
- **Moving `bitrate` to per-route config** — rejected for now. It is genuine deployment policy that the seam applies uniformly, and demoting it would let two routes disagree about stored audio weight for one deployment. Documented as advisory instead.

## Consequences

- Serving OpenAI TTS is configuration, not code: add an `openai` route with a credential. No key exists on this machine, so that route registers unavailable until one is supplied.
- A deployment registering more than one usable route must set the seam's `provider`, or selection reports `SPEECH_PROVIDER_AMBIGUOUS`. The Web bundle pins `litellm` because its `minimax/speech-2.6-hd` model resolves only through the gateway — `provider`, `model`, and `voice` move together.
- `voice` becoming required is a breaking config change for any deployment that omitted it. Such a deployment was already failing every request, so no working configuration breaks.
- The provider's error text says "speech route" rather than "speech gateway", since a route may be a vendor API directly.

## Testing

Package suites pin per-route registration under the map key, the public-OpenAI base default, credential and base resolution through environment references, literal-key precedence, an unavailable route registering rather than vanishing, and disposal removing every route's contribution. The seam suite pins that `resolve()` always produces a voice.

`tests/route.e2e.ts` synthesizes through a live gateway on both vendor families and self-skips without `LITELLM_API_KEY`. A local stub cannot substitute: a stub accepts any body, so it exercises the seam's wiring while accepting the request fields only a vendor rejects. Dropping `voice` from the provider fails both vendor cases in that suite.

The suite also pins an unroutable model. The gateway advertises models its account cannot route and answers them with the same opaque 500 a malformed request gets, so `SPEECH_REQUEST_FAILED` must cover both rather than the audio path storing a JSON error body.

`extra_body.bitrate` moves MiniMax output size well outside the repeat-request noise floor and leaves OpenAI output inside it, which is the measurement behind calling it advisory.

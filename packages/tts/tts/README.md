# @deepseek-ai/dsh-tts

English | [中文](README.zh.md)

The **`TtsRuntime`** (`ctx.tts`) defines WHAT speech synthesis the harness has — turn text into audio — over multiple providers, without binding callers to one vendor's request format.

This package owns the Service Definition role of the speech capability:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-tts` (this) | Service Definition: the service, provider registry, selection policy, `resolve()` policy step, request/audio vocabulary, the `SpeechError` taxonomy |
| `@deepseek-ai/dsh-openai-tts` | Provider: an OpenAI-shaped `/audio/speech` gateway |
| `@deepseek-ai/dsh-read-aloud` | Consumer: turn-end synthesis, the audio cache, and the browser Remote |

## Service API (`ctx.tts`)

| Member | Semantics |
|---|---|
| `registerProvider(provider)` | Register a backend. Throws `SpeechError` `SPEECH_DUPLICATE_PROVIDER` on a duplicate id. Returns a disposer. Disposed with the calling fiber. |
| `resolve(request)` | Apply deployment policy and return the complete `SpeechSpec`. Throws `SPEECH_EMPTY_TEXT` on blank text. |
| `synthesize(request, signal?)` | Resolve the request, select a provider, and synthesize. Policy and selection failures reject rather than throw synchronously, so one `catch` covers every failure. |

## Defaulting is one explicit step

`resolve(request): SpeechSpec` is the only place deployment policy is applied, so a provider always receives a complete spec and never supplies a default of its own. It fills the model, bitrate, and voice, and truncates text past `maxChars` — a partial reading is a better failure than an unbounded bill, and `SpeechSpec.truncated` records that it happened.

## Selection

Selection never depends on registration, config, or HMR order. `synthesize()` resolves the provider at execution time:

| Situation | Execution |
|---|---|
| configured id registered and `available()` | runs that provider |
| configured id not registered | `SPEECH_PROVIDER_CONFIGURED_MISSING` |
| configured id registered but unavailable | `SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE` |
| no id, exactly one registered usable provider | runs it |
| no id, no usable provider | `SPEECH_PROVIDER_UNAVAILABLE` |
| no id, multiple usable providers | `SPEECH_PROVIDER_AMBIGUOUS` |

A provider's `available()` is a cheap local check (credential presence, parseable config) and must not make network calls.

## Config

Every field is required with no library default, because each one varies by deployment and carries a cost.

| Field | Semantics |
|---|---|
| `model` | Provider-routed model identifier, for example `minimax/speech-2.6-hd`. |
| `bitrate` | Requested mp3 bitrate in bits per second. Vendors bill by input characters, so this trades stored bytes against audio quality and nothing else. Advisory: it reaches the vendor as `extra_body`, which MiniMax honors and OpenAI ignores. |
| `maxChars` | Maximum characters per request; longer text is truncated rather than split. |
| `provider` | Optional explicit provider id; omitted auto-selects a single usable provider. |
| `voice` | Voice passed to the provider when a request names none. Required: an OpenAI-shaped route rejects a request carrying no voice, and the vocabulary is vendor-specific, so no value is portable enough to inherit silently. |

## Vocabulary

`SpeechRequest` (`text`, `voice?`) → `SpeechSpec` (`text`, `model`, `bitrate`, `voice`, `truncated`) → `SpeechAudio` (`data`, `mediaType`, `billedCharacters?`, `durationMs?`). `billedCharacters` is recorded rather than derived because a vendor may count a CJK character as two. `SpeechMediaType` is a closed union owned here. See `src/types.ts` for the full contracts and the `SpeechError` code taxonomy.

## Model Experience

None, as speech is presentation: no prompt section, tool schema, or session event originates here, and no synthesized audio reaches a model request.

#### KV Cache effect

None; nothing this package does touches the history tail.

## Known Limitations and Deferred Work

- **No streaming** — `synthesize()` resolves once with complete audio. Incremental playback would need a chunked result type and a provider that supports it; the current consumer synthesizes whole finished replies, where streaming buys nothing.
- **mp3 only in practice** — `SpeechMediaType` admits wav and flac, but `bitrate` is expressed in mp3 terms and the shipped provider requests mp3. A provider returning another container is accepted, with bitrate meaning left to that provider.
- **No usage reporting from the shipped provider** — `billedCharacters` and `durationMs` are optional and the gateway provider omits them, so per-request spend must be read from the gateway's own accounting.
- **No observation surface** — no provider-change event and no capability-status query; availability is observed by calling `synthesize()` and routing the thrown `SpeechError` codes.

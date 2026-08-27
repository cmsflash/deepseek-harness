# Speech

English | [中文](speech.zh.md)

The speech synthesis seam — a [capability seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) split across packages: Service Definition ([dsh-speech](../../packages/speech/speech), `ctx.speech` + the provider registry), Service Provider ([dsh-speech-openai-compatible](../../packages/speech/speech-openai-compatible)), and Consumer ([dsh-speech-cache](../../packages/speech/speech-cache), which reads completed turns aloud). Speech is **one optional capability**, not part of the agent-loop spine, so its vocabulary lives here rather than in [core.md](core.md).

Source: [`packages/speech/speech/src/types.ts`](../../packages/speech/speech/src/types.ts)

## Request, spec, audio

Defaulting is an explicit step, not a hidden fallback: `resolve(request)` turns the caller's `SpeechRequest` into a complete `SpeechSpec`, and a provider only ever sees the spec. That keeps model, bitrate, voice, and the input bound in one owner, and records truncation rather than silently shortening a request.

```ts type-equiv
/**
 * One synthesis request as a caller states it. A provider never reads this
 * directly: {@link SpeechRuntime.resolve} turns it into a {@link SpeechSpec}
 * so every defaulting decision happens at one explicit step.
 */
interface SpeechRequest {
  /** Plain text to speak. Markdown is the caller's to strip. */
  readonly text: string
  /** Provider-specific voice identifier; the deployment's configured voice applies when absent. */
  readonly voice?: string
}
```

```ts type-equiv
/** One synthesis request after the seam has applied deployment policy. */
interface SpeechSpec {
  /** Plain text to speak, already truncated to the configured bound. */
  readonly text: string
  /** Provider-routed model identifier. */
  readonly model: string
  /**
   * Requested mp3 bitrate in bits per second. Advisory: MiniMax honors it,
   * OpenAI's own models ignore it and return 128 kbps regardless.
   */
  readonly bitrate: number
  /**
   * Provider-specific voice identifier. Always present: an OpenAI-shaped
   * `/audio/speech` route rejects a request without one.
   */
  readonly voice: string
  /** True when {@link SpeechRequest.text} exceeded the bound and was cut. */
  readonly truncated: boolean
}
```

`bitrate` is a storage lever, not a price lever: vendors bill by input characters, so a quieter file costs the same as a heavier one. It is advisory rather than guaranteed — it reaches the vendor through `extra_body`, which MiniMax honors and OpenAI ignores.

```ts type-equiv
/** Synthesized audio plus what the provider reported about it. */
interface SpeechAudio {
  /** Encoded audio bytes. */
  readonly data: Uint8Array
  /** Container format of {@link SpeechAudio.data}. */
  readonly mediaType: SpeechMediaType
  /**
   * Characters the provider billed, when it reports them. MiniMax counts a CJK
   * character as two, so this is not `text.length` and is recorded rather than
   * derived.
   */
  readonly billedCharacters?: number
  /** Audio duration in milliseconds, when the provider reports it. */
  readonly durationMs?: number
}
```

## Providers and selection

```ts type-equiv
/** A synthesis backend registered into {@link SpeechRuntime}. */
interface SpeechProvider {
  /** Registry key; also the id a deployment configures to pin this provider. */
  readonly id: string
  /** Whether this provider can run now (credentials present, route reachable). */
  available(): boolean
  /**
   * Synthesize one resolved spec.
   * @param spec - the seam-resolved request.
   * @param signal - optional cancellation forwarded from the caller.
   * @returns the encoded audio and any usage the backend reported.
   */
  synthesize(spec: SpeechSpec, signal?: AbortSignal): Promise<SpeechAudio>
}
```

`available()` is a cheap local check and must not make network calls. Selection resolves at execution time and never depends on registration order: a configured id must be registered and available, and without one exactly one usable provider is required. The failure branches (`SPEECH_PROVIDER_CONFIGURED_MISSING`, `SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE`, `SPEECH_PROVIDER_UNAVAILABLE`, `SPEECH_PROVIDER_AMBIGUOUS`) reject with a `SpeechError` carrying that code; [the package README](../../packages/speech/speech/README.md) holds the full table.

## Audio is not session state

Synthesized audio never enters the session log. The consumer stores it in a filesystem cache keyed by `MessageId` and swept by age, so a miss is an ordinary outcome resolved by synthesizing again, and `SESSION_FORMAT_VERSION` is unaffected. That is why read-aloud needs no durable format and no attachment record: the log already holds the text, and audio is a pure function of it.

## Playback wire vocabulary

The `speechCache` Remote addresses audio by identity, never by prose: a browser sends the session and message, and the host recovers the spoken text from its own log.

```ts type-equiv
/** Request for one message's spoken audio. */
interface SpeechAudioRequest {
  /** Session owning the addressed message. */
  readonly sessionId: SessionId
  /** The finalized assistant message to read aloud. */
  readonly messageId: MessageId
}
```

```ts type-equiv
/** Audio delivered to a browser, base64-encoded for JSON transport. */
interface SpeechAudioValue {
  /** Base64 of the encoded audio bytes. */
  readonly data: string
  /** Container format of the decoded bytes. */
  readonly mediaType: 'audio/mpeg'
  /** True when the audio was synthesized to answer this request. */
  readonly regenerated: boolean
}
```

Failures are values rather than throws, so a browser branches on a code instead of parsing a message: `session-not-found`, `message-not-found` (which also covers a message that is not its turn's closing step), and `synthesis-failed` carrying provider detail.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxspeech--speechruntime"></a>

### `ctx.speech` — `SpeechRuntime`

The speech synthesis service, registered as `ctx.speech`.

Selection semantics (resolved at execution time, never order-dependent):

- A configured id that is registered and `available()` → that provider.
- A configured id not registered → `SPEECH_PROVIDER_CONFIGURED_MISSING`.
- A configured id registered but unavailable → `SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE`.
- No id configured, exactly one registered usable provider → that provider.
- No id configured, multiple usable providers → `SPEECH_PROVIDER_AMBIGUOUS`.
- No id configured, no usable provider → `SPEECH_PROVIDER_UNAVAILABLE`.

```ts cordis-catalog
/**
 * Register a synthesis provider.
 * @param provider - the provider; its `id` is the registry key.
 * @returns the disposer that unregisters the provider.
 * @throws {@link SpeechError} `SPEECH_DUPLICATE_PROVIDER` when the id is taken.
 */
registerProvider(provider: SpeechProvider): () => void

/**
 * Apply deployment policy to one request. This is the only place defaults are
 * filled, so a provider always receives a complete spec.
 * @param request - the caller's text and optional voice.
 * @returns the resolved spec, with `truncated` set when text exceeded `maxChars`.
 * @throws {@link SpeechError} `SPEECH_EMPTY_TEXT` when the text is blank.
 */
resolve(request: SpeechRequest): SpeechSpec

/**
 * Resolve one request and synthesize it through the selected provider.
 *
 * Policy and selection failures surface as rejections rather than synchronous
 * throws, so one `catch` covers every way synthesis can fail.
 *
 * @param request - the caller's text and optional voice.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns the encoded audio and any usage the backend reported.
 * @throws {@link SpeechError} when no provider can run or the backend fails.
 */
async synthesize(request: SpeechRequest, signal?: AbortSignal): Promise<SpeechAudio>
```

Source: [`packages/speech/speech/src/index.ts`](../../packages/speech/speech/src/index.ts)

<a id="ctxspeechcache--speechcacheservice"></a>

### `ctx.speechCache` — `SpeechCacheService`

Cached read-aloud audio for finalized assistant messages.

The Host resolves spoken text from the Session log by `messageId`, so a browser sends identity rather than prose and no conversation surface has to carry the text.

```ts cordis-catalog
/**
 * Read one message's audio, synthesizing it when the cache does not hold it.
 * @param request - the Session and message to read aloud.
 * @returns base64 audio, or an explicit failure.
 */
@Remote('audio') async audio(request: SpeechAudioRequest): Promise<SpeechAudioResult>
```

Source: [`packages/speech/speech-cache/src/index.ts`](../../packages/speech/speech-cache/src/index.ts)
<!-- END GENERATED cordis-surface -->

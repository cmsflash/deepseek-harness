# Speech

[English](speech.md) | 中文

语音合成 seam —— 一个跨包拆分的[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)：Service Definition（[dsh-speech](../../packages/speech/speech)，`ctx.speech` 加提供方注册表）、Service Provider（[dsh-speech-litellm](../../packages/speech/speech-litellm)），以及 Consumer（[dsh-speech-cache](../../packages/speech/speech-cache)，朗读已完成的轮次）。语音是**一项可选能力**，不属于 agent loop 主干，因此它的词汇放在这里而非 [core.md](core.md)。

来源：[`packages/speech/speech/src/types.ts`](../../packages/speech/speech/src/types.ts)

## 请求、spec 与音频

默认值是显式步骤，而非隐藏回退：`resolve(request)` 把调用方的 `SpeechRequest` 变成完整的 `SpeechSpec`，提供方只会看到 spec。这让模型、码率、音色与输入上限归于同一个所有者，并记录截断而非悄悄缩短请求。

```ts type-equiv
/**
 * One synthesis request as a caller states it. A provider never reads this
 * directly: {@link SpeechRuntime.resolve} turns it into a {@link SpeechSpec}
 * so every defaulting decision happens at one explicit step.
 */
interface SpeechRequest {
  /** Plain text to speak. Markdown is the caller's to strip. */
  readonly text: string
  /** Provider-specific voice identifier; the provider's own default applies when absent. */
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
  /** Requested mp3 bitrate in bits per second. */
  readonly bitrate: number
  /** Provider-specific voice identifier, when the caller or deployment named one. */
  readonly voice?: string
  /** True when {@link SpeechRequest.text} exceeded the bound and was cut. */
  readonly truncated: boolean
}
```

`bitrate` 是存储杠杆而非价格杠杆：厂商按输入字符计费，因此更轻的文件与更重的文件价格相同。

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

## 提供方与选择

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

`available()` 是廉价的本地检查，不得发起网络调用。选择在执行时解析，绝不依赖注册顺序：配置的 id 必须已注册且可用，未配置时则要求恰有一个可用提供方。各失败分支（`SPEECH_PROVIDER_CONFIGURED_MISSING`、`SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE`、`SPEECH_PROVIDER_UNAVAILABLE`、`SPEECH_PROVIDER_AMBIGUOUS`）以带该代码的 `SpeechError` reject；完整表格见[包 README](../../packages/speech/speech/README.md)。

## 音频不是会话状态

合成音频绝不进入会话日志。Consumer 把它存入以 `MessageId` 为键、按时间清扫的文件系统缓存，因此未命中是通过再次合成解决的普通结果，`SESSION_FORMAT_VERSION` 也不受影响。这正是朗读不需要持久格式、也不需要附件记录的原因：日志已经持有文本，而音频是它的纯函数。

## 播放的传输词汇

`speechCache` Remote 按身份而非正文寻址音频：浏览器发送会话与消息，宿主从自己的日志恢复朗读文本。

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

失败是值而非抛出，因此浏览器按代码分支而不必解析消息：`session-not-found`、`message-not-found`（也涵盖并非其轮次收尾步骤的消息），以及携带提供方细节的 `synthesis-failed`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Source: [`packages/speech/speech/src/index.ts:70`](../../packages/speech/speech/src/index.ts)

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

Source: [`packages/speech/speech-cache/src/index.ts:65`](../../packages/speech/speech-cache/src/index.ts)
<!-- END GENERATED cordis-surface -->

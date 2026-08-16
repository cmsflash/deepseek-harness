# @deepseek-ai/dsh-speech-litellm

[English](README.md) | 中文

以 `litellm` 为 id，向 `ctx.speech` 注册一个网关支撑的 `SpeechProvider`。它不拥有 `ctx.speech` 键——它注册进 seam 的注册表，正如 `@deepseek-ai/dsh-web-search-exa` 注册进 `ctx.web`。该键由 [`@deepseek-ai/dsh-speech`](../speech/README.md) 拥有。

## 为何用网关而非厂商适配器

网关为它路由的每一家语音厂商暴露同一个 OpenAI 形态的 `POST /audio/speech`，因此原生 API 不同的厂商无需在此写各自的适配器即可触达。MiniMax 正是促成这一设计的案例：它自己的端点是 `/v1/t2a_v2` 而非 `/v1/audio/speech`，因此把 OpenAI 客户端指向 MiniMax base URL 会失败——是网关的专用适配器让这条路由可用。

## 配置

| 字段 | 默认值 | 语义 |
|---|---|---|
| `apiKey` | `$LITELLM_API_KEY` | 网关凭据。为空时提供方不可用，于是 seam 报告 `SPEECH_PROVIDER_UNAVAILABLE`，而不是每次请求都失败。 |
| `baseURL` | `$LITELLM_BASE_URL`，否则 `http://127.0.0.1:4000` | 网关基址；`/audio/speech` 会被追加其后。 |
| `timeoutMs` | 120000 | 请求截止时间。长回复的合成比一次对话补全更耗时。 |

凭据从启动环境读取，因为产品信任它被启动于其中的项目；受管凭据存储不参与此处。

## 请求映射

seam 的 `SpeechSpec` 变为网关的 OpenAI 形态请求体：`model`、`input`、`response_format: 'mp3'`，以及 spec 指定音色时的 `voice`。`bitrate` 搭乘 `extra_body`，网关会原样转发给厂商——OpenAI 的语音 schema 没有码率字段，而 MiniMax 从 `audio_setting` 读取它。

所有失败——非 2xx、空响应体、传输错误——都变成 `SpeechError` `SPEECH_REQUEST_FAILED`，消息中带上状态码与响应细节。空响应体是失败，而不是一个被缓存下来的无声产物。

## Model Experience

无，因为本提供方只经 `ctx.speech` 触达，而后者不贡献任何提示词或 schema，也没有合成音频到达模型请求。

#### KV Cache effect

无。

## Known Limitations and Deferred Work

- **不透传用量** —— OpenAI 形态的响应体是音频字节，没有用量信封，因此即便厂商报告了 `billedCharacters` 与 `durationMs` 也会被省略。要取回它们需要网关的响应头或厂商原生调用。
- **模型标识符不做校验** —— 未知模型会被送到网关并在那里失败。这是刻意的：网关拥有自己的路由表，在此镜像一份只会过期。
- **花费统计依赖网关的价格表** —— 价格表中缺失的模型能正常合成但报告零成本。需要花费核算时，请固定一个网关已定价的模型，或修补它的价格表。

# @deepseek-ai/dsh-speech-openai-compatible

[English](README.md) | 中文

为每一条配置的路由向 `ctx.speech` 注册一个 `SpeechProvider`，各自以其路由的 map 键为 id。它不拥有 `ctx.speech` 键——它注册进 seam 的注册表，正如 `@deepseek-ai/dsh-web-search-exa` 注册进 `ctx.web`。该键由 [`@deepseek-ai/dsh-speech`](../speech/README.zh.md) 拥有。

## 为何一个包容纳所有路由

OpenAI 的 `POST /audio/speech` 与位于其他厂商之前的网关接受相同的请求、返回相同的响应，因此一条路由之间的差异只有 base URL 与凭据。一个包通过 `providers:` map 容纳它们全部，遵循 [`@deepseek-ai/dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.zh.md) 的做法，而不是每家厂商一个包。

网关路由还能触达原生 API 不同的厂商。MiniMax 正是促成这一设计的案例：它自己的端点是 `/v1/t2a_v2` 而非 `/v1/audio/speech`，因此把 OpenAI 客户端指向 MiniMax base URL 会失败——是网关的专用适配器让这条路由可用。

## 配置

`providers` 是从提供方 id 到路由的必填 map。每条路由：

| 字段 | 默认值 | 语义 |
|---|---|---|
| `apiKeyEnv` | —— | 持有凭据的环境引用。 |
| `apiKey` | —— | 字面量凭据，供不使用引用的部署使用。优先于 `apiKeyEnv`。 |
| `baseURL` | `https://api.openai.com/v1` | 路由基址；`/audio/speech` 会被追加其后。 |
| `baseURLEnv` | —— | 持有基址的环境引用，供主机随部署而变的路由使用。 |
| `timeoutMs` | 120000 | 请求截止时间。长回复的合成比一次对话补全更耗时。 |

```yaml
providers:
  litellm:
    apiKeyEnv: LITELLM_API_KEY
    baseURLEnv: LITELLM_BASE_URL
  openai:
    apiKeyEnv: OPENAI_API_KEY
```

凭据解析为空的路由仍会注册，并报告 `available() === false`，于是固定了它的部署被告知该路由不可用，而不是未注册。凭据从启动环境读取，因为产品信任它被启动于其中的项目；受管凭据存储不参与此处。

注册多条可用路由却未设置 seam 的 `provider` 会让选择变得有歧义——`SPEECH_PROVIDER_AMBIGUOUS`——因为没有哪条路由是站得住脚的默认值。

## 请求映射

seam 的 `SpeechSpec` 变为 OpenAI 形态的请求体：`model`、`input`、`voice` 与 `response_format: 'mp3'`。`bitrate` 搭乘 `extra_body`，网关会原样转发给厂商——OpenAI 的语音 schema 没有码率字段，而 MiniMax 从 `audio_setting` 读取它。

`voice` 始终发送。路由会拒绝不带音色的请求，并以不透明的 500 而非 4xx 作答，因此省略音色与路由失效无法区分。

所有失败——非 2xx、空响应体、传输错误——都变成 `SpeechError` `SPEECH_REQUEST_FAILED`，消息中带上状态码与响应细节。空响应体是失败，而不是一个被缓存下来的无声产物。

## Model Experience

无，因为本提供方只经 `ctx.speech` 触达，而后者不贡献任何提示词或 schema，也没有合成音频到达模型请求。

#### KV Cache effect

无。

## Known Limitations and Deferred Work

- **`bitrate` 是建议性的，并不通用** —— 它以 `extra_body` 抵达厂商。MiniMax 会遵从；OpenAI 自家模型忽略它，无论如何都返回 128 kbps 的 mp3。seam 的字段名承诺了超出每条路由实际兑现的东西。
- **不透传用量** —— OpenAI 形态的响应体是音频字节，没有用量信封，因此即便厂商报告了 `billedCharacters` 与 `durationMs` 也会被省略。要取回它们需要响应头或厂商原生调用。
- **模型标识符不做校验** —— 未知模型会被送到路由并在那里失败。这是刻意的：路由拥有自己的模型表，在此镜像一份只会过期。
- **音色标识符不做校验且因厂商而异** —— 在一条路由上有效的音色可能被另一条拒绝，且该失败只在合成时暴露。更改 `provider` 通常意味着 `model` 与 `voice` 要一并更改。
- **花费统计依赖网关的价格表** —— 价格表中缺失的模型能正常合成但报告零成本。需要花费核算时，请固定一个网关已定价的模型，或修补它的价格表。

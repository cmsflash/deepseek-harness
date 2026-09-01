# Agent Note：一个语音提供方包容纳所有 OpenAI 兼容路由

Status: implemented

[English](2026-08-25-openai-tts-routes.md) | 中文

## Problem

`dsh-openai-tts` 在包身份中写入了厂商名，实现的却是一种线格式。要服务 OpenAI 自家的 TTS 就意味着第二个包 `dsh-speech-openai`，而它的提供方与第一个的差异只有 base URL 与凭据——两者都以相同的请求与响应讲 `POST /audio/speech`。每厂商一个包，会让包数量随讲同一种格式的主机数量成倍增长。

另有一处问题：seam 无法产出可用的请求。`SpeechSpec.voice` 是可选的，`resolve()` 与提供方在其未设置时都会省略该字段，但 OpenAI 形态的 `/audio/speech` 路由会拒绝不带音色的请求。在未配置音色的情况下，针对真实路由的每一次合成调用都失败；而路由以不透明的 500 而非 4xx 回应畸形请求，因此该失败与端点失效无法区分，最初被诊断为网关损坏。

## Decision

一个包 `dsh-openai-tts` 通过必填的 `providers:` map（从提供方 id 到路由配置）容纳所有 OpenAI 形态的路由，遵循 `dsh-llm-pi-ai` 既有的多提供方形态，而不是每厂商一个包。`apply` 为每个条目注册一个 `OpenAiTtsProvider`，以 map 键为 id，因此由 seam 既有的选择表决定哪条路由运行。

路由从 `apiKey` 或 `apiKeyEnv` 引用解析凭据，从 `baseURL`、`baseURLEnv` 引用或 OpenAI 公开 API 解析主机。`baseURLEnv` 之所以存在，是因为 cordis.yml 没有 `${VAR}` 插值，所以随部署而变的主机必须像凭据一样是具名引用。凭据解析为空的路由仍会注册并报告 `available() === false`，于是固定它会得到 `SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE` 而非 `CONFIGURED_MISSING`。

`TtsRuntimeConfig.voice` 与 `SpeechSpec.voice` 改为必填。`resolve()` 从请求或部署配置填入音色，提供方始终发送它。默认值位于部署配置，而不是提供方内部的 `?? 'alloy'`，遵循显式优于隐式规则：音色词汇表因厂商而异，没有哪个库内值通用到可以静默继承。

`bitrate` 仍是 seam 的必填字段，但被记录为建议性的：它经 `extra_body` 抵达厂商，MiniMax 遵从而 OpenAI 忽略。

## Alternatives considered

- **第二个包 `dsh-speech-openai`** —— 否决。它的提供方几乎是网关那个的副本，且这份重复会随每一台讲同种格式的主机而增长。真正有差异的是配置，不是代码。
- **在包内做每厂商适配器接口** —— 作为无主抽象否决。现有证据中的每条路由都讲同一种线格式；API 确实不同的厂商（MiniMax 的 `/v1/t2a_v2`）已经通过网关适配器触达，这正是网关路由存在的理由。
- **在提供方内把 `voice` 默认为 `'alloy'`** —— 否决。它把部署策略藏进提供方，且该值并不通用：它恰好在此处测试的两条路由上有效，但拥有自有词汇表的厂商会在合成时失败，而配置看上去仍然正确。
- **把 `bitrate` 下放到每路由配置** —— 暂时否决。它是 seam 统一施加的真实部署策略，下放会让同一部署下的两条路由对存储音频体积各执一词。改为记录其建议性。

## Consequences

- 服务 OpenAI TTS 是配置而非代码：添加一条带凭据的 `openai` 路由即可。本机没有密钥，因此在提供密钥前该路由注册为不可用。
- 注册了多条可用路由的部署必须设置 seam 的 `provider`，否则选择会报告 `SPEECH_PROVIDER_AMBIGUOUS`。Web bundle 固定 `litellm`，因为它的 `minimax/speech-2.6-hd` 模型只经网关可解析——`provider`、`model` 与 `voice` 要一并移动。
- `voice` 改为必填对任何省略它的部署都是破坏性配置变更。这类部署本就每次请求都失败，因此没有可用配置被破坏。
- 提供方的错误文本从「speech gateway」改为「speech route」，因为一条路由可能直接就是厂商 API。

## Testing

包内测试固定：按 map 键的每路由注册、OpenAI 公开基址默认值、经环境引用解析凭据与基址、字面量密钥优先、不可用路由仍注册而非消失，以及 dispose 移除每条路由的贡献。seam 测试固定 `resolve()` 始终产出音色。

`tests/route.e2e.ts` 在实时网关上对两个厂商族做合成，并在缺少 `LITELLM_API_KEY` 时自行跳过。本地 stub 无法替代它：stub 接受任何请求体，因此它只检验 seam 的接线，却会接受只有厂商才会拒绝的请求字段。把 `voice` 从提供方去掉，会让该套件的两个厂商用例都失败。

该套件还固定了一个不可路由的模型。网关会公布其账号无法路由的模型，并以与畸形请求相同的不透明 500 作答，因此 `SPEECH_REQUEST_FAILED` 必须覆盖两者，而不是让音频路径存下一个 JSON 错误体。

`extra_body.bitrate` 使 MiniMax 输出体积的变化明显超出重复请求的噪声底，而 OpenAI 输出的变化落在噪声底之内——这正是称其为建议性的测量依据。

# @deepseek-ai/dsh-speech

[English](README.md) | 中文

**`SpeechRuntime`**（`ctx.speech`）定义 harness 具备怎样的语音合成能力——把文本变成音频——覆盖多个提供方，且不把调用方绑定到某一家厂商的请求格式。

本包承担语音能力的 Service Definition 角色：

| 包 | 角色 |
|---|---|
| `@deepseek-ai/dsh-speech`（本包） | Service Definition：服务、提供方注册表、选择策略、`resolve()` 策略步骤、请求／音频词汇，以及 `SpeechError` 分类 |
| `@deepseek-ai/dsh-speech-litellm` | 提供方：OpenAI 形态的 `/audio/speech` 网关 |
| `@deepseek-ai/dsh-speech-cache` | Consumer：轮次结束时合成、音频缓存，以及浏览器 Remote |

## 服务 API（`ctx.speech`）

| 成员 | 语义 |
|---|---|
| `registerProvider(provider)` | 注册一个后端。id 重复时抛出 `SpeechError` `SPEECH_DUPLICATE_PROVIDER`。返回 disposer，随调用方 fiber 释放。 |
| `resolve(request)` | 应用部署策略并返回完整的 `SpeechSpec`。文本为空时抛出 `SPEECH_EMPTY_TEXT`。 |
| `synthesize(request, signal?)` | 解析请求、选择提供方并合成。策略与选择失败以 reject 返回而非同步抛出，因此一个 `catch` 覆盖所有失败。 |

## 默认值只有一个显式步骤

`resolve(request): SpeechSpec` 是唯一应用部署策略的位置，因此提供方总是收到完整 spec，自己绝不补默认值。它填入模型、码率与音色，并截断超过 `maxChars` 的文本——读出一部分比无上限的账单更可接受，而 `SpeechSpec.truncated` 记录这件事发生过。

## 选择

选择绝不依赖注册、配置或 HMR 顺序。`synthesize()` 在执行时解析提供方：

| 情形 | 执行 |
|---|---|
| 配置的 id 已注册且 `available()` | 运行该提供方 |
| 配置的 id 未注册 | `SPEECH_PROVIDER_CONFIGURED_MISSING` |
| 配置的 id 已注册但不可用 | `SPEECH_PROVIDER_CONFIGURED_UNAVAILABLE` |
| 未配置 id，恰有一个已注册且可用的提供方 | 运行它 |
| 未配置 id，没有可用提供方 | `SPEECH_PROVIDER_UNAVAILABLE` |
| 未配置 id，有多个可用提供方 | `SPEECH_PROVIDER_AMBIGUOUS` |

提供方的 `available()` 是廉价的本地检查（凭据是否存在、配置能否解析），不得发起网络调用。

## 配置

每个字段都是必填且没有库级默认值，因为它们都随部署变化且各自带来成本。

| 字段 | 语义 |
|---|---|
| `model` | 提供方路由的模型标识符，例如 `minimax/speech-2.6-hd`。 |
| `bitrate` | 请求的 mp3 码率（比特每秒）。厂商按输入字符计费，因此它只在存储字节与音频质量之间权衡。 |
| `maxChars` | 单次请求的最大字符数；更长的文本被截断而非切分。 |
| `provider` | 可选的显式提供方 id；省略时自动选择唯一可用的提供方。 |
| `voice` | 可选的默认音色，在请求未指定时传给提供方。 |

## 词汇

`SpeechRequest`（`text`、`voice?`）→ `SpeechSpec`（`text`、`model`、`bitrate`、`voice?`、`truncated`）→ `SpeechAudio`（`data`、`mediaType`、`billedCharacters?`、`durationMs?`）。`billedCharacters` 是记录而非推导，因为厂商可能把一个 CJK 字符算作两个。`SpeechMediaType` 是本包拥有的封闭联合。完整契约与 `SpeechError` 代码分类见 `src/types.ts`。

## Model Experience

无，因为语音属于呈现：本包不产生任何提示词区块、工具 schema 或会话事件，也没有任何合成音频到达模型请求。

#### KV Cache effect

无；本包所做的一切都不触碰历史尾部。

## Known Limitations and Deferred Work

- **不支持流式** —— `synthesize()` 一次性返回完整音频。渐进播放需要分块的结果类型和支持它的提供方；当前 Consumer 合成的是已完成的整段回复，流式在此没有收益。
- **实践上仅 mp3** —— `SpeechMediaType` 允许 wav 与 flac，但 `bitrate` 以 mp3 语义表达，且交付的提供方请求 mp3。返回其他容器的提供方会被接受，码率含义由该提供方自行决定。
- **交付的提供方不报告用量** —— `billedCharacters` 与 `durationMs` 是可选的，而网关提供方不返回它们，因此单次请求的花费需从网关自身的账目读取。
- **没有观测面** —— 没有提供方变更事件，也没有能力状态查询；可用性只能通过调用 `synthesize()` 并根据抛出的 `SpeechError` 代码分支来观察。

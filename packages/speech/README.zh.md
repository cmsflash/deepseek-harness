# speech/ — 语音合成能力家族

[English](README.md) | 中文

本家族在一个提供方无关的服务背后把文本转为音频，并包含在 Web GUI 中朗读已完成轮次的 Consumer。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`speech/`](speech/README.md) | 定义语音提供方的注册、选择，以及先 resolve 再合成的策略 | `ctx.speech` |
| [`speech-litellm/`](speech-litellm/README.md) | 通过 OpenAI 形态的网关提供合成 | 注册到 `ctx.speech` |
| [`speech-cache/`](speech-cache/README.md) | 合成每个已完成轮次并把缓存音频提供给浏览器 | `ctx.speechCache` |

合成音频是可重新生成的呈现内容：它绝不进入会话日志，因此没有任何持久格式承载它，缓存未命中只需再次合成。

[朗读决策](../../.agents/notes/implemented/feature/2026-08-14-assistant-reply-read-aloud.md)记录了音频为何是缓存而非附件，以及 always-on 触发的代价。

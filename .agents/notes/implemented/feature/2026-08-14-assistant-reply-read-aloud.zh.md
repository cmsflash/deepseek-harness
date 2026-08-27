# Agent Note: Read-aloud of assistant replies

Status: implemented

[English](2026-08-14-assistant-reply-read-aloud.md) | 中文

## Problem

一个已完成 turn 的正文，正是人最常希望不用眼睛去读的部分：它总结发生了什么、下一步该做什么。Web GUI 只以文本呈现它，因此消费这段内容必须盯着屏幕。

语音属于呈现，不是模型输入，因此它绝不进入模型上下文或 Session 日志。于是设计问题不在于日志能否承载音频，而在于合成后的音频存放在哪里、何时产生，以及为每个已完成 turn 生成它的代价是多少。

## Decision

一个 `ctx.speech` capability seam 在每个 turn 结束时立即合成该 turn 的收尾正文，Web GUI 播放已完成的产物，而不是即时转换。

### Capability seam

三个角色，依照 [capability-seam 依据](../../implemented/architecture/2026-06-13-capability-seams.zh.md)：

- **Service Definition** `dsh-speech` 拥有 `ctx.speech`、request/spec 拆分以及音频词汇。它显式地把 request 解析为 spec，因此没有任何 provider 把默认值藏进 `synthesize()`。
- **Service Provider** `dsh-speech-openai-compatible` 调用 `/audio/speech`，为每一条配置的路由注册一个提供方（[路由设计](../architecture/2026-08-25-speech-openai-compatible-routes.zh.md)）。Web bundle 固定 LiteLLM 路由：MiniMax 在厂商 API 层面并不兼容 OpenAI（是 `/v1/t2a_v2`，不是 `/v1/audio/speech`），因此集成点是网关的专用适配器，而非用 OpenAI base-URL 覆盖。
- **Consumers** 是 `dsh-speech-cache`（宿主侧产生音频的 `turn/end` 监听器，并拥有 `speechCache` Remote）与 `dsh-client-ui-message-speech`（浏览器侧播放它的插件）。

### 触发与文本选取

宿主监听 `turn/end`，合成该 turn 的收尾 assistant 消息。`turn/end` 携带 `{ turn, reason }`，因此被打断的 turn 依 reason 跳过，而不是靠检查内容。

朗读文本是该消息中 `type: "text"` 块的拼接。`reasoning` 与 `tool-call` 块被排除：思考轨迹不是写给读者的，工具参数也不是正文。没有 text 块的消息不产生音频。

宿主按 `messageId` 从 Session 日志解析文本，方式与 `dsh-message-feedback` 解析其目标一致。浏览器发送标识符而非正文，因此 `AssistantActionOwnerProps` 仍旧只携带 `messageId`，`ui-conversation` 无需改动。

Subagent 会话被排除。它们的 turn 没有面向用户的播放界面，纳入它们每天将多合成约 5 万字符而无处播放。

### 存储

音频是可重新生成的缓存，不是持久的 Session 状态，因此它位于 `$DSH_HOME/cache/speech/`，以 `messageId` 为键，并在启动时按时间清扫。Session 日志不追加任何内容，`SESSION_FORMAT_VERSION` 不受影响，也不需要持久格式评审。

缓存未命中是普通结果：浏览器请求合成并播放结果。于是过期、驱逐与冷机器共用同一条路径，保留窗口的调整也无需迁移。

### 配置

每个随部署变化的值都是经校验的 `Config` 字段，遵循「插件中不写死可调参数」规则：`model`、`voice`、`bitrate`、`ttlDays` 与 `maxChars`。Web bundle 交付 `minimax/speech-2.6-hd`、64 kbps、7 天 TTL，并固定 `litellm` 路由。

码率在 MiniMax 上是纯粹的存储杠杆——它遵从该设置；OpenAI 自家模型忽略它，无论如何都返回 128 kbps。MiniMax 按 `usage_characters`（输入字符数）计费，因此音频质量对价格没有影响；厂商自己的响应示例在 128 kbps 下为 6.931 秒返回 111,789 字节，误差在 1% 以内即恒定码率 mp3，因此字节数严格随该设置线性缩放。延迟也不会有听感上的差别：合成耗时取决于文本长度，而传输差异在本地网络上只是几百 KB。

默认交付 64 kbps 而非 32，是因为 LiteLLM 的 MiniMax 适配器为 mp3 记载的取值是 `64000, 128000, 192000, 256000`。32,000 是 MiniMax 记载但该适配器未列出的取值，因此经这条路径验证过的最低设置是 64 kbps。端到端验证过 32 kbps 的部署可以设置它，把存储再减半。

模型固定在 `2.6` 标识符上，因为 LiteLLM 的价格表没有 `speech-2.8-*` 条目；那些模型能工作但报告零成本，会悄悄破坏支出核算。

`maxChars` 约束单次请求。MiniMax 同步接口接受 10,000 字符，更长的收尾消息会被截断而非切分，因为读出一部分比无上限的账单更可接受。

### 包清单要承载生成产物的 import

`dsh-speech-cache` 声明了 `zod`，尽管 `src` 下没有任何文件 import 它：Typert 生成的 `./remote` 编解码器首行是 `import { z } from 'zod'`，该产物会被内联进 import 它的 Client bundle，而打包器只能内联 pnpm 为已声明依赖建立链接的模块。`scripts/check-workspace-constraints.ts` 现在对每个导出规范 `./remote` 对的包断言这一点，因为该约定已在五个包中成立却无任何检查（[事故复盘](../../../../docs/postmortem/0005-undeclared-zod-broke-web-plugin-boot.zh.md)）。

`tsconfig.base.json` 显式映射了 `@deepseek-ai/dsh-client-ui-message-speech`。client 包名以其分组目录为前缀，因此通用的 `@deepseek-ai/dsh-*` 通配符无法覆盖它们，`verify-cordis-config` 要求该条目。

## 实测成本

以下数字来自本机 2026-08-14：DSH Session 日志、OpenCode 桌面版与 dev 版的 SQLite 存储，以及 LiteLLM 控制台。

用量口径为把三处安装的历史合并用量作为 DSH 的预测，且只统计主线程收尾消息：**每天 523,842 字符**。

| | 每天 | 每年 | 占每日支出比例 |
|---|---|---|---|
| MiniMax HD（$100/M 字符） | $52.38 | $19,120 | **10.1%** |
| MiniMax turbo（$60/M） | $31.43 | $11,472 | 6.3% |
| OpenAI tts-1（$15/M） | $7.86 | $2,868 | 1.7% |

分母是实测而非推算：LiteLLM 控制台显示**七天 $3,255.50**，即每天 $465。其中 Anthropic 的混合单价为每 1M token $1.25，约为标价输入价的十二分之一，因为 prompt 缓存占主导。用 token 数乘以标价会把这个基线高估约六倍，不可采用。

按每秒 16.2 字符——即 MiniMax 自己那条 112 字符、6.931 秒响应示例所隐含的语速——同样的用量是**每天 9.0 小时音频**：

| 码率 | 每天 | 7 天稳态 |
|---|---|---|
| 32 kbps（LiteLLM 适配器未提供） | 129 MB | 0.90 GB |
| 64 kbps（交付默认） | 259 MB | **1.81 GB** |
| 128 kbps（MiniMax 默认） | 517 MB | 3.62 GB |

同一预测下 Session 日志压缩后每天增长约 8.6 MB，因此 64 kbps 的音频约为日志增长速率的三十倍，占每日新增字节约 97%。真正把它约束住的是 TTL，而不是单文件大小。

## Alternatives considered

**改用浏览器 `speechSynthesis` 而非服务端 seam。** 零成本、零密钥、可离线。因质量被否决：操作系统音色机械，而这个功能存在的意义就是听起来舒服。它还需要把朗读文本送到浏览器，这意味着扩宽 `AssistantActionOwnerProps` 并在客户端剥离 Markdown——耦合严格多于服务端方案。

**把 `AttachmentStore` 泛化到音频。** attachment seam 的每个方法与类型都是图片形状，`ImageAttachmentRef` 还携带 `width`/`height`。泛化它要改动 Service Definition、本地 provider 以及约十余个消费者（含 API proxy 与 Session 导出），并把可重新生成的字节放进持久附件路径。作为更大的改动、且买到的是本功能并不想要的持久性，予以否决。

**首次播放时才合成。** 最省钱，且只为真被听到的音频付费。因为它重新引入了 always-on 触发本要消除的延迟而否决：第一次按下播放要等一次完整的合成往返。

**MiniMax turbo，或 OpenAI tts-1。** turbo 以更低质量把成本减半；tts-1 只要六分之一成本，且适合纯英文朗读。二者都输给「使用 MiniMax 最好模型」这一明确指令。实测内容 CJK 占比 0.00%，因此 MiniMax 的多语言与情感表现力是在为用不到的能力付费——在试听两者之后值得重新评估。

**用 `/tmp` 而非 `$DSH_HOME/cache`。** 更简单且自动清理。因 macOS 在开机时清空 `/tmp` 而否决：那样每次重启都要为近期重播重新付费；`$DSH_HOME/cache/speech/` 既能在重启后留存，又易于查看和删除。

## Testing

各包测试固定了 seam 的选择表与显式 `resolve` 步骤、提供方的请求映射与每条失败分支、缓存的触发规则与存储语义，以及浏览器插件的注册、单流播放与释放。

测试守住的行为：

- 已完成的非 subagent 轮次无需任何用户操作即产出缓存产物，且操作条播放它时没有合成往返。
- 被打断的轮次、收尾消息没有 text 块的轮次、subagent 的轮次，三者各自既不产音频也不发请求。
- 缓存未命中会重新生成并播放；过期、驱逐与冷机器共用这一条路径。
- `reasoning` 与 `tool-call` 内容绝不到达提供方，并以同时含三种块的消息固定这一点。
- 同一条消息的轮次结束任务与播放请求合流到同一次在途合成，因此竞争只计费一次。
- 销毁所属 fiber 会移除 `turn/end` 监听器、提供方注册与 slot 条目。

有两条分支采用 `v8 ignore` 说明而非人为构造触发：暂存清理的 reject 需要暂存文件在 rename 失败与 unlink 之间消失，而 `play()` 周围的陈旧代次分支需要一个仍在挂起的音频 promise 被后续 toggle 取代。元素事件的守卫已确定性地覆盖同一条取代规则。

## Consequences

朗读在结构上没有代价：音频绝不进入会话日志，因此 `SESSION_FORMAT_VERSION`、附件路径与持久重放都不受影响，保留窗口的调整也无需迁移。宿主按 `messageId` 解析文本使 `AssistantActionOwnerProps` 仍只携带身份，因此 `ui-conversation` 保持不变，也没有任何对话界面需要携带正文。

**持续成本可观。** 在实测预测下 MiniMax HD 使支出增加约 10%、每年 $19,120，而其中大部分音频从不被播放——每天 9 小时超出任何合理的收听量。`synthesizeOnTurnEnd: false` 用首次播放延迟换掉这笔花费；更精细的杠杆是仅前台或按会话触发，目前未实现。码率完全不是成本杠杆：计费按输入字符计，文件更小并不更便宜。

**语速取自单条厂商示例。** 每秒 16.2 字符是从 MiniMax API 参考中那条 112 字符、6.931 秒的响应推导而来，并非记载的语速，且不适用于 CJK。所有时长与字节数字都继承这一不确定性。提供方在后端报告时会记录 `extra_info.audio_size` 与 `audio_length`，以便用实测替换估算。

**计费字符数不等于字符数。** MiniMax 把一个 CJK 字符按两个计费。实测内容 CJK 占比 0.00%，因此目前不受影响，但若输出转向中文，同样的字符数成本约翻倍。

**用量预测基于很短的窗口。** 实测语料仅覆盖 6–11 天且波动剧烈，三处安装的合并总量未做去重，因此迁移过的会话可能被重复计入。这些每日速率属于数量级估计。

**厂商价格因区域而异。** MiniMax 国内价目（每万字符 ¥2/¥3.5）约为国际价目（每 1M 字符 $60/$100）的一半。此处数字采用国际价目，与 LiteLLM 价格表及本部署一致。

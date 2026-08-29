# @deepseek-ai/dsh-read-aloud

[English](README.md) | 中文

已完成轮次的朗读音频：一个 `turn/end` 监听器经 [`ctx.tts`](../tts/README.zh.md) 合成每个轮次的收尾正文，一个位于 Harness home 下的文件系统缓存，以及浏览器据以播放的 `readAloud` Remote。

音频是可重新生成的呈现内容，绝非持久的会话状态。本包不向会话日志追加任何内容，`SESSION_FORMAT_VERSION` 不受影响，缓存未命中是通过再次合成解决的普通结果。

## 触发

服务跟随 `session/event` 并在 `turn/end` 时动作。以下三种情形各自意味着不产音频、不发请求：

| 情形 | 原因 |
|---|---|
| `reason.kind !== 'completed'` | 被打断的轮次没有可朗读的、已定稿的收尾正文。 |
| `session.header.origin === 'subagent'` | subagent 记录没有播放界面，合成它等于为无处播放的音频付费。 |
| 收尾消息没有 text 块 | 只调用了工具的步骤没有面向读者的内容。 |

朗读文本是收尾 assistant 消息中 `text` 块的拼接。`reasoning` 块是思考轨迹而非写给读者的正文，`tool-call` 块携带参数；两者都绝不发送给提供方。轮次的**最后**一条 `assistant/message` 是它的收尾步骤——多步轮次的较早步骤以工具调用结束，而非以回复结束。

## 存储

产物位于 `$DSH_HOME/cache/speech/<message-id>.mp3`，仅所有者可访问，经暂存文件原子发布，因此并发读取绝不会看到写了一半的文件。消息 id 是不透明的，可能不适合作文件名，因此每个键都做百分号编码。超过 `ttlDays` 的产物读取时视为未命中，并由启动清扫删除。

## Remote（`readAloud`）

| 方法 | 语义 |
|---|---|
| `audio({ sessionId, messageId })` | 返回一条消息的 base64 mp3。缓存持有产物时直接提供，否则合成并存储。`value.regenerated` 说明发生的是哪一种。 |

宿主从自己的会话日志解析朗读文本，因此浏览器发送消息身份而非正文。失败是值而非抛出：`session-not-found`、`message-not-found`（包括并非其轮次收尾步骤的消息），以及带提供方细节的 `synthesis-failed`。

同一条消息的轮次结束任务与播放请求会合流到同一次在途合成，因此竞争只计费一次。

## 配置

| 字段 | 语义 |
|---|---|
| `ttlDays` | 产物被提供的天数，超期即被清扫。 |
| `synthesizeOnTurnEnd` | 在每个轮次结束时立即合成。为 false 时把合成推迟到首次播放请求，以延迟换取不为无人播放的轮次付费。 |

## Model Experience

无，因为合成音频属于呈现，绝不进入会话日志或模型请求，因此模型无法观察某条回复是否被朗读。

#### KV Cache effect

无；本包所做的一切都不触碰历史尾部。

## Known Limitations and Deferred Work

- **always-on 合成会为无人播放的音频付费** —— 每个已完成轮次都会被合成，而一个工作日会产生数小时音频，其中大部分从不被播放。`synthesizeOnTurnEnd: false` 用首次播放延迟换掉这笔花费；更精细的杠杆是仅前台或按会话触发，目前未实现。
- **清扫只在启动时运行** —— 长期运行的进程会把过期产物留在磁盘上直到重启，尽管它们读取时已视为未命中。过期在读取时强制执行，因此绝不会提供陈旧内容。
- **没有缓存大小上限** —— 保留仅按时间计。TTL 窗口内的长轮次突发只受该窗口约束。
- **仅 Chat 视图** —— Remote 可寻址任何已定稿消息，但只有 Chat 记录的操作条提供播放；trajectory 与 waterfall 视图不渲染控件。

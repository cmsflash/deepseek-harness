# @deepseek-ai/dsh-client-read-aloud

[English](README.md) | 中文

逐消息朗读插件的浏览器半边：一个播放／停止按钮，作为 `conversation.chat.assistant-actions` 条带的 `speech` 条目（order 20）贡献进去。该条带由 `ui-conversation` 声明，渲染在已定稿 assistant 消息的 IconActions 行内、反馈控件之后，因此按钮继承该行的外观与悬停行为。只有已定稿消息会到达该插槽——被打断而冻结的部分回复没有 `messageId`，因此没有控件。条带每个轮次渲染一次，位于持有该轮次 IconActions 行的收尾 assistant 消息上。

每个会话一个 `SpeechPlayer` 支撑该会话中的所有消息控件，这正是单流规则的执行方式：开始播放一条回复会停止正在播放的内容，因此两条回复绝不重叠。

音频经 `ctx.remote.readAloud` 到达。宿主按 `messageId` 从会话日志解析朗读文本，因此这一半发送的是消息身份而非正文——没有任何对话界面需要携带该文本，`AssistantActionOwnerProps` 保持不变。由于宿主在轮次结束时就合成了该轮次的音频，点击通常播放的是已经存在的产物；未命中会重新生成，属于普通结果而非错误。

被后续点击取代的加载会被丢弃，因此缓慢的合成无法让用户已经翻过去的播放复活。连接重置会停止播放：断开的传输无法在流中恢复，而比传输活得更久的音频会对着已断开的 UI 继续说话。

`/client` 导出为插件主体（`apply`/`inject`）、`MessageSpeechAction` 组件、`SpeechPlayer` 类，以及注入的 face 类型。

## Model Experience

无。朗读属于呈现，绝不进入只追加的会话日志或模型上下文；模型无法观察某条回复是否被播放。

#### KV Cache effect

无；播放不触碰任何请求前缀。

## Known Limitations and Deferred Work

- **除播放与停止外没有其他控制** —— 没有拖动进度、倍速或断点续播。停止会丢弃位置，因此重放会从头开始。
- **失败呈现在控件上而非文案中** —— 加载失败会把按钮变红并显示 tooltip；除再次点击外没有重试入口，底层原因（缺少提供方、网关错误）也不会呈现给用户。
- **仅 Chat 视图** —— trajectory 与 waterfall 视图不渲染播放控件，尽管它们的 assistant 节点携带相同的 `messageId`。
- **没有跨标签页协调** —— 第二个标签页独立播放，因此同一条回复可能在一台机器上被朗读两次。

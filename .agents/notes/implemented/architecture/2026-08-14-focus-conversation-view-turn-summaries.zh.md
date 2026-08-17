# Agent Note: 以增量 Focus 视图阅读长会话，而非折叠 Chat

Status: implemented

[English](2026-08-14-focus-conversation-view-turn-summaries.md) | 中文

## 问题

长会话的 Chat 转录被已结束的中间过程主导。阅读它意味着滚过工具调用与此前的助手正文，才能看到 agent 当下在做什么。所需的阅读方式是：完整呈现最新一轮——在它仍是工具调用轮时就可见，而不是等它结束之后——同时把更早的每一轮压缩为能回答"那一轮花了什么"的数字：轮次与调用次数、变更行数、耗时与 token。

诱人的实现是在既有 Chat 视图内折叠行。这在插件中不可达，而 slot 系统在构造上就说明了这一点：`conversation.chat.node` 是由 chat 视图条目**声明**的 keyed slot，声明即占有，对已存在 key 的第二次注册会在加载时抛错。`visibility: 'hidden'` 由各 Definition 对自己的 Node 持有，因此任何插件都无法隐藏他人的行。于是就地折叠意味着修改 `ChatView` 的排序、分页锚点与底部跟随逻辑及其 web 快照——为增加一种可选阅读方式，而改动所有人都在读的既有转录。

## 决定

该阅读方式以 `@deepseek-ai/dsh-client-ui-focus` 交付：一个增量的 `conversation.view` 列表条目（id `focus`，order 5），与 chat、trajectory 并列，沿用 `ui-trajectory` 的先例。Chat 不作修改。标签选择本就按会话持久保存在 chat store 中，因此该模式只需选择一次，无需逐轮重选；移除 bundle 行即可去掉标签页，对转录毫无影响。

该视图自持渲染与算术。它经 `useSession` 读取与目标无关的 `ConversationNode` 兼容流以及引擎持有的轮次时间线，并且**不**注册 Conversation Definition：本插件不引入业务事件族，因此没有任何东西需要 Definition 去装配——它只是 Chat Definition 已产出结果的第二个读者。轮次归属遵循日志顺序，工具结果归属于其前方最近一个助手步所在的轮次；先于窗口内任何步的结果被丢弃，而非错误归属。最新一轮的切片从该轮自身的 `turn/start` seq 开始，因此边界来自引擎而非由 node 种类推断；当该 start 已被翻页移出窗口时，退化为按步识别。

变更行数是派生的，而非新记录的。write 与 edit 工具本就返回携带整份前后镜像的已应用 `card:'diff'` 结果视图，因此折叠是逐文件的行多重集差分。这些视图跨进程传输且只有 `card` 字段经 schema 校验，因此逐条校验并跳过畸形条目——这也正是 `ui-tool` 的 `narrowDiffs` 存在的原因。

单轮成本被有意省略。harness 中不存在任何模型定价，且 provider 适配器在客户端可见之前就丢弃了端点上报的花费：`llm-deepseek` 的 `mapUsage` 构造仅含 token 的 `TokenUsage`，`llm-pi-ai` 将其目录的 `ModelCost` 归零并注明没有消费者报告花费。展示成本需先有价格来源，因此这些行显示 token 计数，而不是 harness 并不具备的费率。

## 考虑过的替代方案

- **在既有 Chat 视图内折叠轮次**：否决——在插件中不可达（见上文 keyed slot 占有），且要做到就得为一种可选模式修改既有 `ChatView` 的滚动/分页逻辑及其快照。用户要求的是插件。
- **注册相竞争的 `conversation.chat.node` renderer**：否决——keyed slot 按设计对重复 key 抛错；该冲突是组合模型在表态，而不是需要绕过的障碍。
- **新增 host 侧逐轮投影**：推迟——它能让数字从窗口范围变为整个日志范围，但为一个呈现特性引入持久投影单元及其持久化。该视图改为在 UI（明确提示加分页控件）与 README 中声明其窗口范围。
- **复用 `sessionStats`/`tokenUsage` 作为行数据**：否决——两者都是整会话总量且无逐轮拆分，无法回答某一轮花了什么。
- **在插件中提供可配置价格表**：暂否——那会让每行的主要数字依赖手工维护、且会与真实账单静默偏离的费率；定价属于了解模型的 provider 一侧，而非视图。

## 影响

- Chat、trajectory 与所有既有 Chat Definition 均未改动；该标签页纯为增量，可独立移除。
- 所有数字在构造上以窗口为范围，因为已加载的历史窗口是分页的，且 compaction 会重写它。当更早历史尚未加载时，指标带渲染截断提示与分页控件；`turn/start` 落在窗口外的轮次不报告耗时。
- 最新一轮渲染的是简化转录（正文、推理、终端卡片、原始参数），而非 chat 视图完整的 keyed 工具卡片、图片与逐消息操作，因为那些 renderer 属于 chat 所声明的 slot。富卡片始终只隔一个标签页。
- 变更行数只覆盖发出 diff 卡片的工具，且把移动的行计为未变。
- 日后加入成本是数据问题而非视图问题：这些行已携带价格来源需要相乘的 token 分桶。

# Agent Note: Chat 将一个 turn 中已结束的 step 折叠为一行可展开摘要

Status: implemented

[English](2026-08-14-chat-collapses-settled-steps.md) | 中文

## 问题

长 turn 的转录被中间过程主导。本仓库中一轮用户提问经常花费 150 次以上模型调用，阅读它意味着滚过每一个已结束的工具调用才能看到 agent 当下在做什么。所需的阅读方式是：最新一次模型调用保持与今天完全一致的渲染——包括流式期间——并把更早的调用压缩成一行，报告它们的开销。

这里的粒度来自日志本身，且极易搞错。一个 `turn` 是一轮用户提问（`agent-loop` 中的 `turn/start` → `turn/end`）；其中每个 `step` 是一次模型调用及其工具调用。按 turn 折叠回答的是错误的问题：它把整整一轮藏进一行，却对其中的 150 个 step 毫无作用。

## 决定

`ChatView` 按 `(turn, step)` 对其已排序的行分组，并为每个 turn 渲染一个 `CollapsedStepsRow` 取代该 turn 的非末位 step。每个 turn 的最高 step 始终正常渲染，因此流式期间进行中的 step 保持可见，只有当更晚的 step 开启后它才进入折叠分组。不携带 step 坐标的行——发起的用户消息、turn 尾部——永不折叠。

展开以 turn 为单位、全有或全无：展开时标记行保留，并兼作把分组折回的控件；被恢复的行走与其它所有行相同的 `ChatNodeSeat`。阅读者的展开状态是组件本地的，且刻意不持久化，因为它是阅读位置而非偏好设置。

该行为放在 Chat 视图内部，而非第二个视图。一个 keyed slot 只能由恰好一个 entry 渲染：`renderSlot` 的授权检查渲染方 entry 上的 `entry.children?.[key]`，不会向上遍历祖先；而对已声明 key 的二次声明会在加载时抛错。`conversation.chat.node` 由 chat 视图 entry 声明，并由 `ui-tool`、`ui-goal`、`ui-workflow-run` 填充，因此任何同级视图都无法分派这些 renderer。放在这里可让展开后的分组在构造上与未折叠的转录完全一致，并且对插件日后并入 `ChatNodeDataMap` 的 renderer 种类继续有效。

`collapseSettledSteps` 偏好在持久化的 `ui-conversation` 设置段中默认**关闭**，因此在阅读者启用之前，组装后的转录毫无变化。`ComposerSubmissionPolicy` 本就持有该设置段的 scope 与采纳订阅，因此该偏好搭它的车，而不是另开一个订阅。

该行在一处开放：`conversation.chat.collapsedMetric` 是一个 list slot，其条目渲染在所有内置指标之后。采用「贡献者置后」而非共享 `order` 空间，是因为该行拥有日后可能新增的指标，而共享空间会在新增时静默打乱外部贡献者的位置。展开控件与指标条为同级，因此贡献的指标不会嵌套进 button。正是这一点让成本展示能够作为仓库外插件交付。

## 考虑过的替代方案

- **独立的 `Focus` 视图标签页**：实现后否决——出于上述原因它无法复用 Chat 的 renderer，于是手写了近似实现，把工具调用渲染得比 Chat *更差*；其按 turn 的粒度也折叠了错误的单位。
- **把 node slot 声明上移到 `conversation.session`**：否决——授权在渲染方 entry 上检查，因此在祖先上声明只授权该祖先，而非其下的各视图 entry。
- **把 `ChatNodeSeat` 导入另一个视图包**：否决——它的 `renderSlot` prop 按 entry 绑定，因此从未声明该 key 的 entry 使用会抛出 `SlotOwnershipError`；何况这还违反跨包导入规则。
- **把 renderer 复制进第二个包**：否决——需在 `ui-conversation` 与 `ui-tool` 之间复制约 4600 行，必然漂移，且对日后贡献的 renderer 种类视而不见。
- **逐 step 展开**：否决——阅读者要么想要该轮的结果，要么想要它的完整细节；逐 step 开关又把这个特性想要消除的扫描带了回来。

## 影响

- 默认输出不变：偏好关闭时，`ChatView` 与此前完全一样地映射快照顺序，因此既有 web 快照依然有效。
- 折叠分组的数字以窗口为范围，因为已加载的历史窗口是分页的，且 compaction 会重写它。翻页载入更早的 step 会改变这些数字。
- 行数来自 write 与 edit 本就返回的已应用 `card:'diff'` 结果视图，并逐条校验，因为这些视图跨进程传输且只有 `card` 经过 schema 校验。由不发出 diff 卡片的工具所做的改动不计入行数。
- 该行本身不展示成本。`TokenUsage.costUsd` 承载已计价调用的美元金额（[决策](2026-08-24-token-usage-carries-billed-cost.zh.md)），因此该指标可由贡献者经 `conversation.chat.collapsedMetric` 提供，而不在此处计算。

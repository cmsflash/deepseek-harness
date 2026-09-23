# Agent Note: 在会话、轮次与子代理三个范围显示计费成本

Status: implemented

[English](2026-09-11-billed-cost-display.md) | 中文

## 问题

每次已计价的模型调用都会把 `costUsd` 记录在其 `assistant/message` 的 usage 上（[TokenUsage 承载计费成本](../architecture/2026-08-24-token-usage-carries-billed-cost.zh.md)），但 GUI 中没有任何界面显示它。为用量显示供数的三个折叠都丢弃了该字段：`tokenUsage` 会话投影只累加四个 token 桶，`deriveTurnTokenUsage` 只归一化同样的四个桶加上推理与路由，子代理 lineage 菜单只读取投影的桶。插件无法弥补这一缺口。投影是 Host 折叠，客户端没有扩展点；轮次尾部与用量 pill 是内建渲染器；唯一可达的 slot `conversation.chat.collapsedMetric` 收到的是折叠计数与隐藏节点键，而非 usage。

## 决定

`TokenUsageProjection` 与 `TurnTokenUsage` 新增两个必填字段：`costUsd`，即每次已计价尝试的成本之和；`unpricedCalls`，即提供方未公布价格的计费尝试数。未计价的尝试对总和贡献零、对计数贡献一。`tokenUsage` 单元的 `stateVersion` 升至 3，使投影缓存从日志重建。轮次折叠拒绝负数或非有限的成本，如同它拒绝畸形计数。

三处显示读取这些字段。Composer 下方的会话用量 pill 在缓存命中段之后追加美元总额，并在其对话框中新增 `费用` 行；轮次尾部的用量 pill 追加该轮总额并新增同一行；lineage 菜单中的子代理行把子会话的总额放在其 token 计数旁。在可用的用量显示中，数字始终存在：所有调用都没有价格的会话显示 `$0.0000`，而当计数非零时，每个对话框的 `费用` 行都会追加 `（N 次调用未计价）`，让读者能区分部分总和与完整总和。金额在一美元以下保留四位小数，一美元及以上保留两位，使不足一美分的轮次仍可分辨。

轮次页脚通过[轮次结束记录的历史元数据](../architecture/2026-09-22-turn-usage-history-metadata.zh.md)接收记账，因此折叠或分页读取详情不会改变其数值或可用性。

## 考虑过的替代方案

**任一尝试未计价时隐藏数字。** pill 上缺席的一段读起来像缺失的功能，而非被扣留的总额，且大多数经 DeepSeek 路由的会话将永远不显示成本。对话框行上的计数在不隐藏数字的前提下承载了同样的提示。

**由插件填充 `conversation.chat.collapsedMetric`。** 该 slot 的 owner props 只携带计数与节点键；贡献者必须重新读取 Session，而 slot 契约禁止这样做，且该数字会重复轮次尾部减去可见最后一步的结果。

**在折叠步骤行上显示美元数字。** 该行总结的是过程而非计费，且已有六个数字；本轮成本在其尾部 pill 中一键可达。加入它需要在 `StepDigest` 及其合并规则中做第四处折叠改动。

**侧栏或工作区总额。** 会话行刻意保持精简，而工作区范围的花费是对目录的聚合而非行装饰；那是一个独立的视图。

## 影响

每个会话都在读者思考的每个范围显示美元数字；DeepSeek 路由或 pi-ai 目录之外的网关模型贡献零，并计入对话框的 `（N 次调用未计价）` 提示。父会话的总额不含其子会话，因为每个子会话是独立日志。既有会话在下次打开时通过投影重建获得这些数字，不运行迁移。[投影测试](../../../../packages/llm/token-meter/tests/token-usage-projection.spec.ts)固定了求和、逐次尝试替换与未计价计数；[轮次折叠测试](../../../../packages/llm/token-meter/tests/turn-usage.spec.ts)固定了跨尝试的同一规则与畸形成本拒绝；ui-chat 与 ui-subagent 的组件规格固定了 pill 段、对话框行与未计价提示。

# Agent Note: 完整详情读取保留已加载的 Session 区间

Status: implemented

[English](2026-09-10-consumer-required-full-history.md) | 中文

## Problem

折叠历史页有意省略 step 的内部事件。Trajectory 无法从汇总数字重建工具记录，而使用更小的完整详情消息预算重新打开 Session，会丢弃读者已经加载的历史。补充读取还可能先看到持久化的 assistant 消息，随后其 live end 帧才允许该消息替换正在流式显示的内容。

## Decision

订阅 Trajectory 数据源时调用 `Session.requireFullHistory()`。这一要求持续到该 Session 对象的生命周期结束，并优先于 Chat 的详情偏好。这与 Conversation 的单调目标激活一致：可见组件卸载后，已激活的构建器仍然接收更新。仅解析数据源而不订阅，不触发读取要求。

详情切换保留已物化的事件。完整详情恢复向 `session.page` 提供 `fromSeq` 和捕获的日志游标，精确读取已加载区间，不使用消息预算，也不建立新的 follow 连接。Host 验证区间，Client 拒绝不完整或不连续的响应。只有捕获页覆盖的内部事件会被插入；无关的持久化尾部事件仍遵守 assistant 流的终止帧顺序。

恢复保留已加载的头部、更早历史是否存在的状态，以及 step 账目。并发请求共享同一次操作。物理窗口替换会使较早的响应失效；并发前置加载带来的新缺失项保留标记，并由后续读取补全。在缺失事件填满前，Trajectory 不显示时间线和表格；恢复失败时明确显示错误和 Retry 操作，而不是把部分记录当作完整结果。

本决策部分替代[摘要分页](../architecture/2026-09-01-collapsed-step-digest-paging.zh.md)中偏好变更触发窗口重开的做法。该笔记仍拥有省略、保留以及完整 step 账目的规则。

## Alternatives considered

**修改全局偏好并重开 follow。** 这会影响其他 Session，丢失已加载区间，并无谓地重建活动 assistant 的流式内容。消费者的要求应属于它读取的 Session。

**让 Trajectory 独立读取历史。** 第二个读取器会重复 Session Controller 已有的游标、连接、取消和对账职责。

**组件卸载后降低详情级别。** Conversation 持续更新已经激活的目标；该目标仍处于活动状态时改回折叠传输，会再次让其缓存快照变得不完整。

## Consequences

显式请求完整详情视图，会增加该 Session 实例后续分页的传输量。Chat 仍可折叠显示；新建的 Session 实例若选择 Chat，仍可使用折叠传输。视图要求完整详情本身不会改变模型输入、执行工具或改变已持久化的 Session 代际。

单元回归覆盖精确区间、失败和过期读取、并发分页、共享恢复，以及 assistant 提交顺序。录制 Session 驱动的 [Trajectory 场景](../../../../snapshots/web/trajectory-full-detail/snapshot.yml)通过组装后的浏览器固定省略工具事件的恢复行为及页面刷新后的表现。

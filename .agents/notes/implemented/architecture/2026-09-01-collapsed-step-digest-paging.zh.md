# Agent Note: 历史分页省略被折叠的 step，并以 digest 描述它们

Status: implemented

[English](2026-09-01-collapsed-step-digest-paging.md) | 中文

## 问题

把一个 turn 中已结束的 step 折叠起来，只是对阅读者隐藏了它们，但它们的每一个事件仍然照发，因此分页开销毫无变化：阅读者能看到的 transcript（文本记录）只是该页所承载内容的一小部分，而回溯更早的历史要点击很多次 `load earlier`。

在本仓库的六份真实会话日志上测量，一个 turn 的非末位 step 按字节占日志的 87–97%（中位数 ≈ 96%）。在最大的一份上——58 个 turn、21,655 个事件、13.76 MB——折叠阅读者真正看的 step 只占载荷的 4.6%。一页 50 条消息承载了 3,243 个事件和 1.23 MB，却只展示 **7 个 turn**，而回到该会话顶部需要 9 页。

## 决策

`session.history` 接受 `stepDetail: 'full' | 'collapsed'`。在 `collapsed` 下，host 把一个可省略的 step 只作为它的 `step/start` / `step/end` 边界外加一个 `StepDigest` 下发，扣住内部内容，直到 `session.expandSteps` 来取。这些页把 `PAGE_MESSAGES`（50）换成 `COLLAPSED_PAGE_MESSAGES`（300），因为目的是回溯得更远，而不是发送更小的响应。

**边界永不省略。** 正是这一点让 seq 范围保持为一段连续区间：窗口在 Conversation Definition 读取的坐标系中不留空洞，`loadOlder` 的连续性断言在页尾依然成立，而 assembler 只增加 `spliceInterior`——Match 按 seq 合并，且展开所能到达的每个 Context 都已持有自己的 start Match，因为一个 Step 的 `step/start` 随该页一同到达。

**只有阅读者不在看的 step 才可省略。** 该 turn 的最高 step 被保留，携带该 turn 收尾 assistant 文本的 step 同样被保留：`turn-tail` 从那条消息中取出收尾消息、分支锚点和延迟数字，因此省略它所在的 step 会削弱一个已结束 turn 的页脚，而不只是隐藏 step。在被测会话上，这在 56 个 turn 中的 2 个上多保留了一个 step。

保留与否在整个事件范围上决定，而不是在单页上决定，因此被拆到多页的 turn 在每一页上都保留相同的完整 step；按页决定会让页边界改变哪个 step 算作某个 turn 的最后一个，相邻的两页于是会对同一个 turn 给出不一致的答案。

**`expandSteps` 以客户端的窗口头部为界**（`fromSeq`）。一个 turn 常常在展示它的那一页之前就已开始，它更早的 step 属于客户端尚未加载的页；返回它们会把事件拼接到头部以下，使 `baseSeq` 描述一个客户端已不再连续持有的范围。

**digest 就是摘要行上的那些数字，且在展开之后依然成立。** 一个 digest 描述整个 step，由 host 侧在整份日志上计算，因此加载该 step 的事件不会改变它的开销。Session 保留两张映射：`stepDigests`（仍被扣住——驱动「打开即取」的标记）与 `stepAccounts`（收到的全部账目，含已展开的 turn）。该行折叠账目，并在折叠已加载节点时跳过任何已被账目覆盖的 step，因此两个来源永远不会把同一份工作计两次。没有这一拆分，该行会在展开时无声缩水——折叠时 55 个 step / 25.5M token，展开后 33 个 / 15.3M。

摘要行的锚点在任何行发出之前、在整个渲染顺序上解析，并且依据节点**种类**（该 turn 的第一条 assistant 行或 tool 行）。以第一条携带 step 坐标的行作锚点会把标记放到发起消息之上，因为引擎按日志位置分配 step Location，于是那条消息和任何上下文注入也都携带一个；而在遍历行的过程中解析锚点，则会让展开操作移动该行。

`DEFAULT_COLLAPSE_SETTLED_STEPS` 交付为 `true`，因此该偏好现在选择的是一种取数策略，而不只是一种呈现方式。

## 考虑过的替代方案

- **对已结束的 step 丢弃 `assistant/chunk`。** 它占日志的 39%，且在有了 `assistant/message` 之后纯属流式残留（1,307 个 step 中只有 4 个真正需要用 chunk 重建）。由所有者推迟，作为一项可独立进行、且同样有利于未折叠默认路径的改动。
- **照发被省略的事件，改在客户端隐藏。** 这正是本记录所取代的既有行为；它解决的是阅读，而不是分页。
- **下发完整的 step，由客户端汇总。** 否决：客户端只能折叠它已加载的内容，因此这些数字会以窗口为范围，并随阅读者翻页而改变——而这恰恰是 digest 存在的目的所要消除的性质。
- **按 step 而非按 turn 展开。** 否决：turn 才是阅读者打开的单位，而按 step 请求会让一次手势产生成倍的往返。

## 后果

- 在被测会话上，一页在字节数相当（1.20 MB 对 1.23 MB）的情况下承载 18 个 turn 而不是 7 个，回到顶部需要 4 页而不是 9 页。
- 折叠页剩下的体量是 `request/header`（每个事件 141 KB，没有 step 坐标，因此永不可省略）：占一份被测折叠页的 67%。它是任何进一步收益的约束瓶颈，本次未作改动。
- 展开一个 turn 的代价是一次按该 turn 大小计的请求：在被测会话上 p50 为 151 KB，p90 为 528 KB，最大 2.15 MB。
- subagent 的 transcript 整份分页；catalog 子视图没有需要服务的折叠阅读者。
- 摘要行的数字不再以窗口为范围，这使 [step 折叠记录](2026-08-14-chat-collapses-settled-steps.zh.md)中对应的那条后果作废。

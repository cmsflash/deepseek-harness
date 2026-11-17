# Agent Note: 会话父子关联保存在 Workspace 注册表中

Status: implemented

[English](2026-11-13-session-parent-links.md) | 中文

## 问题

一个智能体项目以会话树的形式运行：管理会话启动其他会话，后者又可以管理自己的会话。Workspace 分组界面把一个 Workspace 的所有会话列成一排平铺的行，因此这棵树只能通过会话标题中的命名约定看出来。分组界面需要一份持久记录来说明一个会话位于哪个会话之下，浏览器之外的调用方也需要一种设置它的方式。

## 决策

- 关联是 [Workspace 注册表](../../../../packages/workspace/workspace/README.zh.md)中的注册表全局状态：`sessionParents`，从子会话 id 指向其所嵌套会话 id 的映射，与归档集合和置顶集合一同保存在 `workspace` 领域的全局状态中。该字段默认为空，领域版本保持为 2。
- `WorkspaceRegistry.setSessionParent(sessionId, parentSessionId | undefined)` 设置或清除一条关联。[Workspace 控制器](../../../../packages/api/workspace-controller/README.zh.md)以 `workspace/setSessionParent` 提供它，返回完整映射，在 `workspace/follow` 的 baseline 中包含该映射，并在每次对它的已提交变更之后发送 `parents` 帧。没有任何会话事件、工具或提示词携带这一关联，因此模型看不到它。
- 设置关联时，以下情况拒绝且不写入：子会话以自身为父（`self`）、子会话已是父会话的祖先（`cycle`）、两个会话属于不同 Workspace（`cross-workspace`）、任一会话来源为子代理（`subagent`），或其中一个不在任何 Workspace 的 `sessionIds` 中（`unaccounted`）。这些都以带相应原因的 `workspace/session-parent-invalid` 失败；未知会话以 `session/not-found` 失败。因此不属于任何 Workspace 的会话不能被嵌套。
- 不查看归档状态：管理会话会归档已完成的会话，而它们在树中的位置必须保留，因此已归档会话可以建立关联，归档也不改变任何关联。
- 任一会话离开其 Workspace 的持久记账时关联即结束。删除 Workspace 时，其会话的关联在把它移出顺序的那次全局状态写入中移除。`detachSession` 或对被过滤候选的清理只改动一条表记录，没有任何写入能把它与全局状态合并，因此实体上报被移除的 id，注册表在随后的一次写入中移除它们的关联；该写入失败时记入日志。启动时注册表移除任一端不在任何持久记账中的全部关联，这也修复了这两次写入之间的崩溃或失败。
- `sessionParents` 在 `WorkspaceBaseline` 和 `WorkspaceSnapshot` 中是可选的，尽管 Host 和基于 Remote 的 Client 模型总是提供它。Client 模型只在某个条目变化时才替换其 `sessionParents` 对象，因此消费方可以按其对象身份做记忆化。

## 考虑过的替代方案

**会话日志或会话头部。** 头部字段或会话事件会使关联成为已发布会话格式、其导出和链式哈希的一部分，而日志中的任何内容都可能进入模型可见的上下文。关联是调用方可以重新设置的显示分组，因此它应与注册表已拥有的其他分组状态放在一起。

**每条 Workspace 记录上的字段。** 把一个 Workspace 的会话关联存进它自己的记录，可以让解除挂接或清理在同一次写入中移除它们。但这也会把一个映射拆到多条记录中，把映射加入 `Workspace` 实体的写入路径，并偏离归档集合与置顶集合的存储和推送方式。两次写入加启动修复的生命周期代价更小。

**提高 `workspace` 领域版本。** 没有该字段的构建将完全拒绝打开注册表。这会把显示分组的静默丢失变成 Host 无法启动，比丢失本身更糟。

**为关联单设一个存储领域。** 没有该功能的构建永远不会打开它，因此关联能在这些构建下保留。但这增加了第二个持久所有者，其生命周期必须跨两个领域与 Workspace 记账对齐，而只要为同一主目录服务的每个构建都保留该功能，就能避免这种情况。

**在 `WorkspaceBaseline` 和 `WorkspaceSnapshot` 上使用必填的 `sessionParents`。** 类型会如实表达 Host 总是发送它，但功能之外 9 个 Client 包的测试中有 24 处手写的 `WorkspaceSnapshot` 字面量都必须修改，携带此类字面量的每个下游分支也是如此。读取方改用 `?? {}`。

**保留已删除 Workspace 的关联。** Workspace 被删除后，没有任何操作会把会话送回某个 Workspace 的记账，包括重新添加同一目录，因此保留下来的关联永远无法显示。

## 影响

- 早于 `sessionParents` 的构建解析注册表状态时不含该字段，并将其丢弃。这样的构建打开由带该功能的构建写过的主目录后，它下一次写入注册表全局状态时（创建、删除或重排 Workspace，归档、取消归档、置顶或取消置顶会话）存入的状态不含该映射，所有父子关联随之消失且不报错。注册表的其他内容不受影响：Workspace 记录、顺序、归档集合和置顶集合照常写入。关联是显示分组，因此设置它们的调用方可以重新设置。
- 在实体写入把会话移出记账与随后的注册表写入之间，映射可能指向不在任何记账中的会话；消费方把自己未持有的子会话或父会话视为没有关联，如果第二次写入始终未提交，下一次启动会移除该条目。
- 每次 `setSessionParent` 调用都会为两个会话扫描每个 Workspace 的记账，耗时与已记账会话数成线性关系；该调用是显式且少见的，因此注册表不维护索引。
- 读取该可选字段的消费方带有 `?? {}` 回退，它应是一个模块级常量，使回退的引用保持稳定。

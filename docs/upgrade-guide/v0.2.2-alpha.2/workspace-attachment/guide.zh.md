---
kind: upgrade-guide
description: "Workspace 跟随消费方必须整体应用注册表提交，旧写入方会丢弃汇报附属状态。"
---

# Workspace 汇报附属状态与注册表提交

[English](guide.md) | 中文

## 变更

Workspace 的 `follow` 对有变化的全局提交发送 `registry` 增量，不再分别发送 `order`、`archived`、`pinned` 或 `parents` 增量。其 `value` 一起携带 `workspaceIds`、`archivedSessionIds`、`pinnedSessionIds`、`sessionParents` 和 `detachedSessionIds`。拒绝未知帧类型的消费方必须与 Host 一起更新。

持久化数组 `detachedSessionIds` 对已有数据默认为空：历史会话仍附属，不执行回填。脱离的 Report 保留视觉父级，但改向用户汇报。不含该字段的构建会在下一次 Workspace 全局状态写入时丢弃它；不保证安全降级。

## 迁移

1. 发布前备份 Harness home。一起升级该 home 的所有写入方；设置附属状态后，不要用旧构建打开它。
2. 更新自定义 `workspace/follow` 消费方，原子地应用 `registry` 增量中的所有字段。baseline 缺少 `detachedSessionIds` 时默认为 `[]`。父级与附属状态的一元响应只是回执，不是完整的关系快照；显示状态应读取有序流。
3. 使用匹配构建重新加载浏览器 Client。在隔离的测试 home 中，通过 `workspace/setSessionAttachment({ request: { sessionId, parentSessionId, attachment: 'detached' } })` 设置附属状态，其中 `parentSessionId` 是预期的当前父级。确认返回的脱离集合、未改变的父子关联，以及重启后保留的状态。清除父级必须在同一个注册表增量中移除标记。
4. 必须回退时，使用匹配构建恢复发布前的备份，不要让旧写入方静默清除附属状态。

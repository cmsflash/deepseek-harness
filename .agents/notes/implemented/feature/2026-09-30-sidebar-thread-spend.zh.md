# Agent Note: 以线程花费作为 Session 行末尾的数字

Status: implemented

[English](2026-09-30-sidebar-thread-spend.md) | 中文

## 问题

侧栏中每个 Session 行的末尾显示距最近一次提示词的时间。排序已经体现了新近程度，因此该标签重复了列表位置已表达的信息；而 Session 的花费只有打开后才能看到：Composer 的用量 pill 显示父会话自身日志，每个子代理的总额位于 lineage 菜单中。想按成本比较线程的读者必须逐一打开并自行累加其子会话。

现有数字不适合逐行求和，原因有二。分叉的日志以源会话的事件开头，因此 `tokenUsage` 会在每个分叉中再次计入源会话的调用；在一份实测历史中，同一长线程的三个分叉各自报告超过 $2,000，其中自身工作只有 $27 至 $880。此外，子代理的调用位于其自己的日志中，因此父会话的 `tokenUsage` 不含它们。

## 决定

**视图选项 → 显示内容**提供**最近活动**（既有的相对时间）与**总费用**。该选择保存在浏览器本地，与其他视图选项一起持久化，不改变排序或搜索；该选项出现之前持久化的值按最近活动读取。悬浮卡片总是显示两项数字。

总费用即线程花费：Session 自身的花费，加上经不间断的 subagent 谱系可达的每个 Session 自身的花费。分叉行只计入分叉点之后发生的调用；源会话保留自己的总额，因此在分叉树上不会有调用被计两次。

自身花费来自新的 token-meter 投影单元 `ownTokenUsage`。它把 `tokenUsage` 折叠（包括同一次尝试的替换与重试边界）只应用于 Session 精确分叉切点及之后的事件，`init` 以 `inheritedEventCount` 接收该切点。未继承任何事件的 Session 中它等于 `tokenUsage`。它是独立的键，而不是对 `tokenUsage` 的修改，因为 Composer 与 lineage 显示依赖后者的含义。

未计价的调用贡献零，没有用量值的行显示 `$0`；行内不带未计价标记。该单元格在低于 $10 时显示美分，$999 及以下显示整美元，更高时以 `K` 表示千，并使用等宽数字。

## 考虑过的替代方案

**沿谱系累加 `tokenUsage`。** 每个分叉继承的前缀会按分叉数各计一次，使分叉行显示其祖先的花费而非自身花费，并夸大任何包含多个分支的总额。

**在客户端减去分叉继承的总额。** 客户端看到的是源会话当前的总额，而不是其在分叉点的总额，也看不到已归档或删除的源会话。只有对分叉自身日志的折叠知道切点。

**标记含未计价调用的行。** `+` 或短横可以区分部分和，但该行被设计为读作一个单纯的数字；Composer 对话框的 `（N 次调用未计价）` 提示仍是展示这一区别的位置。

**为冷分叉提供缓存行。** 列表会跳过已播种 Session 的 projection-cache 行，因为头部不携带补全缓存身份所需的分叉切点。按其余身份字段匹配可以在不打开冷分叉的情况下显示其花费，但这会放宽一条有文档的缓存规则；该项被推迟，因此冷分叉的自身花费按 `$0` 计。

**工作区或侧栏总额。** [计费成本 Note](2026-09-11-billed-cost-display.zh.md) 把聚合总额作为独立视图否决了。本次改动保持这一界线：每行显示其自身线程，任何分组头都不汇总其成员。

## 影响

无需打开即可按成本比较各行。线程的数字包含其全部委派工作，因此自身花费很少但运行昂贵子代理的父会话显示其实际成本。分叉的数字是其自身的工作。

仍有两处缺口。分叉未加载到 Host 中时，其自身花费按 `$0` 计，其行只显示其 subagent 的花费，因为列表只为未继承事件的 Session 提供缓存值。在 `ownTokenUsage` 出现之前写入检查点的缓存行只携带 `tokenUsage`，客户端将其读作自身花费；这是精确的，因为此类行只会为未播种的 Session 进入列表。[投影测试](../../../../packages/llm/token-meter/tests/token-usage-projection.spec.ts)固定了分叉切点与检查点恢复；ui-workspace 的 [lineage](../../../../packages/client/ui-workspace/tests/subagent-lineage.client.spec.ts)、[tree](../../../../packages/client/ui-workspace/tests/tree.client.spec.ts)、[row](../../../../packages/client/ui-workspace/tests/rows.client.spec.tsx) 与 [browser](../../../../packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx) 规格固定了求和、格式化与持久化的选项。

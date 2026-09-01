# Agent Note：按模型记忆推理强度

Status: implemented

[English](2026-09-01-per-model-reasoning-effort-memory.md) | 中文

本记录建立在[适配器自有的推理强度能力](2026-07-24-adapter-owned-reasoning-effort-capabilities.zh.md)之上：那份记录拥有强度词表及其校验，本记录只补充选择器预选哪一档。

## 问题

编排器的模型座位在每次切换模型时都会重置推理强度。`ModelSelect` 的 `choices` memo 仅根据 `model.reasoning?.defaultEffort` 构造候选选择，模型列表的点击处也只传 `{provider, model}`；因此用户在某个模型上选定的非默认档位，一旦切走就会丢失，切回来又变回适配器默认值。`/model` 弹窗的 `selectionOf` 规则相同：保留当前路由自身的强度，但其余每一行都重置。

已有两处记忆，都覆盖不了这件事。会话当前的 `ModelSelection` 是一个 `(provider, model, effort)` 三元组，通过 Host 每步记录的 request header 持久化；`agent-default-model` 再存一个三元组，作为后续会话的全局默认。两者描述的都是**当前**选择，都没有表达用户在当前未使用的某个模型上偏好哪一档——而切换模型时要预选的恰恰是它。

## 决定

某条精确路由上最后选定的强度属于用户偏好，因此存放在 Host 设置文档中：`ui-model-selection` 命名空间下的 `rememberedEfforts` 字典，把 `provider/model` 映射到强度 id。选择强度时写入该路由的条目；选择模型时读取它，替代适配器默认值提交。

命名空间由本包的 node 半边注册——此前它只是一个空 apply，仅用于让插件出现在 Loader 中。这样整个特性由一个包拥有：区段、两条读取路径和写入，且无需改动 host、线路或 schema。`settings.describe`/`mutate` 与命名空间无关，`ctx.settingsScope.bind` 基于共享的 describe 镜像派生出按命名空间的 scope，而 `ui-permission-presets` 已经示范了这一模式。另一个显而易见的位置是在 `ModelCatalogModel` 上加字段，但那会波及 `sessions.ts`、zod schema、`api-remotes`、fake API 和 RPC schema 用例，只为存一个 Host 侧无人读取的值。

`EffortMemory` 在该 scope 上同时拥有读写两个方向，`apply` 构造一个实例供两个入口共享，因此在编排器中选定的档位会在 `/model` 中预选，反之亦然。

三条规则让这份记忆是建议性的而非权威的，与目录既有的处理方式一致：

- **词表归适配器所有。** 当记住的 id 不在该模型当前的 `reasoning.efforts` 中时，回退到声明的默认值，因为适配器会在不同版本间重命名或删除档位。缺少这道检查，过期 id 会被带进 `selectModel`，让用户请求的切换失败。
- **只记录已被接受的档位。** `chooseEffort` 在 Host 返回成功之后才记录，因此被拒绝的强度不会被预选进一个必然再次失败的选择。
- **写入失败不影响切换。** 此时选择已经在 Host 上生效；被拒绝的设置写入会被吞掉，下一次选择基于重新加载的状态改写。

`null` 表示显式选择"提供方默认"，与"没有该键因而没有任何选择"不同：当模型未声明默认值时，强度面板会提供一行"提供方默认"，把两者合并会让选择它变成无操作。该区段保留最近写入的 200 条路由——它会随着每个曾被选中的模型累积条目，而每次 describe 都会整体读取；重新选择某条路由会重新插入，使其计为最近使用。

该区段刻意不注册任何设置行。它是由程序管理的状态，其有意义的编辑动作就是选择器本身；而设置表单只渲染显式注册的 `settings.general.item` 贡献，因此它得以持久保存，又不必成为用户需要理解的表单项。

## 影响

选择器在用户切换到某个模型时，预选他们上次在该模型上运行的档位，并跨会话、跨浏览器、跨 Host 重启保持。选择机制的其余部分未变：Host 仍校验每一个提交的强度，会话日志仍记录请求实际使用的值，`agent-default-model` 仍拥有新会话的默认值。

`ui-model-selection` 的 node 半边现在有了实际行为，因此只组合浏览器行而不组合 node 行的部署不会注册命名空间。此时 scope 报告 `unavailable`，`effortFor` 读到空记忆，选择器的表现与本次改动之前完全一致——使用适配器默认值，不记住任何内容。

slot 注入面新增了 `effortFor` 与 `rememberEffort`，因此每个 `ModelSelect` 构造点都要提供这两项。本包的设置依赖是一条服务注入（`settingsScope`），这使浏览器半边依赖设置插件已被组合；manifest、tsconfig 与 bundle 声明都记录了这条边。

有一处缺口仍然存在，README 已记录：该区段没有设置行，因此纠正一条错误条目要靠重新选择该档位或编辑设置文档。增加设置行意味着渲染一个由不透明路由键构成的字典，那比选择器本身更糟。

## 备选方案

**浏览器本地记忆（`localStorage`）。** `createSnapshotStore` 支持持久化，且完全不需要 Host。否决理由是插件自身的约定就是"host 保持唯一事实来源，store 只是一份共享回显"——在 Host 目录之外再立一个浏览器本地事实，正是那句注释要防止的分叉。它也无法满足催生该特性的场景：一个不能随用户去到另一台浏览器的偏好算不上"记住"。

**放在 `ModelDirectory` 里的按会话记忆。** 最省事，却错得不易察觉：`ModelDirectory` 是按会话的浏览器内存，因此这份映射会在页面刷新时消失，却能挺过 Host 重启。这与用户对"记住"的持久性预期恰好相反。

**在 Host 的 `selectModel` 处理器中记录。** 写入距离 `saveDefaultModelSelection` 只有一行，而且能覆盖将来所有客户端。否决理由是读取仍需抵达浏览器，这意味着新增线路字段及其完整的 schema 波及，只为存一个仅选择器消费的值。

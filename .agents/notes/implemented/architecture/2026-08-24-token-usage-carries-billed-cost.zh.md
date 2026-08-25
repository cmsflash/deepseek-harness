# Agent Note: TokenUsage 承载调用的计费成本

Status: implemented

[English](2026-08-24-token-usage-carries-billed-cost.md) | 中文

## 问题

Harness 中没有任何东西能说出一轮对话花了多少钱。`TokenUsage` 只承载计数，因此每一个消费方——会话日志、转录、日后任何预算控制——都只能报告 token，永远报告不了金额。

数据本就存在，只是被丢弃了。pi-ai 会按其模型目录为每次调用计价，并把结果以美元放在 `Usage.cost` 上；而 `mapUsage` 只复制了四个 token 字段，把它丢掉了。

第一个缺口背后还藏着第二个。`catalogModels()` 以配置的路由名为键，因此网关路由——例如代理 Anthropic 与 DeepSeek 的 `litellm`——匹配不到任何 catalog provider，每个模型都解析为 `cost: NO_COST`，即便 pi-ai 能精确计价的模型也总计为零。

## 决定

`TokenUsage` 新增可选的 `costUsd`，由 `llm-pi-ai` 的 `mapUsage` 把 pi-ai 的 `cost.total` 复制进来。当提供方未公布价格时该字段缺席而非为零，因为零是在断言这次调用免费。

成本搭乘既有 `assistant/message` 事件的 `usage` 字段，因此天然可持久化、可重放，无需新增事件。客户端本就把 `usage` 以 `unknown` 原样转发，因此无需改动传输格式。

`originCost()` 为 id 指明了来源的网关模型（`anthropic/claude-opus-5`）解析价格，`resolveRouteModels` 在已安装条目之后、`NO_COST` 之前查询它。前缀标识了网关实际转发到的模型，而该模型公布的价格正是网关的计费依据。未带前缀的 id、未知来源或未知模型保持无价，而不做猜测。

## 考虑过的替代方案

- **读取网关自己的 `x-litellm-response-cost` 响应头**：否决——pi-ai 持有 HTTP 响应，且在生成路径上不暴露任何响应头，因此这需要包装全局 `fetch`、给第三方库打补丁，或再发一次计费请求。以六组真实 token 规模（小、中、约 1M token、长输出、缓存写、缓存读）对着真实 LiteLLM 网关实测，pi-ai 计算出的美元金额每一组都与网关计费响应头完全一致，因此该响应头并不能提供目录之外的任何信息。
- **在路由 profile 中支持逐模型配置价格**：暂时否决——目前没有消费方需要目录之外的价格，而无价模型如实报告为无价即可。没有现实消费方的可配置性，是基于臆测做出的公开选择。
- **单独的 `cost/recorded` 会话事件**：否决——成本是单次模型调用的属性，而 `assistant/message` 已经承载了该次调用的 usage。并行事件需要自建关联，还可能与紧邻的 usage 互相矛盾。

## 影响

- pi-ai 不为其模型计价的路由不报告成本。这体现为字段缺席，而不是 `$0.00`。
- 成本由目录价格推算，而非来自提供方账单。目录价格过期会产生一个笃定却错误的数字；该金额是估算，只有在价格恰好吻合时才等于实际。
- `llm-deepseek` 未作改动，不报告成本。它需要针对自己的价格来源做同样的映射。
- 该数字对任何 `TokenUsage` 消费方可用，包括折叠 step 行的 `conversation.chat.collapsedMetric` slot——仓库外插件无需再改动核心即可填充它。

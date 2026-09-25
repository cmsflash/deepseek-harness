---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-08-24-token-usage-cost-usd

[English](2026-08-24-token-usage-cost-usd.md) | 中文

## 概述

为每个持久化的 TokenUsage 增加可选的计费成本字段 costUsd。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-08-24-token-usage-cost-usd
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-14-image-offload"
    after: "bef90cc515a7c3b08a8328786a55a0c9dc30b0583ddd8473e1dda78a9fdc1eb4"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-14-image-offload"
    after: "6a30a3bb71634af11a0eebeaebe7fe610bdf4a30a0052f55689fc0a97289544e"
    decision: same-version
  - root: "event:compaction/summary"
    previous: "2026-09-14-image-offload"
    after: "2d5fe0553c2b0440f10ace516f058448060a4b10141d348bb19fd75326202e46"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有日志仍然有效：该字段在 assistant/attempt 与 assistant/message 的流式分块和消息用量上，以及 compaction/summary 的用量上均为可选。报告单次调用成本的提供方写入它；读取方把缺失视为成本未知而非零，成本展示只累加存在的值。模型可见输入不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/llm-pi-ai/tests/adapter.spec.ts packages/llm/llm-pi-ai/tests/convert.spec.ts packages/session/session-format-v0-to-v1/tests/legacy.spec.ts packages/session/session-format-v0-to-v1/tests/validation.spec.ts packages/session/session-persistence-jsonl/tests/v0-released-writer-variants.spec.ts：186 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。

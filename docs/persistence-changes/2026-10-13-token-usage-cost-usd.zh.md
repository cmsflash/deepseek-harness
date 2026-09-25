---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-13-token-usage-cost-usd

[English](2026-10-13-token-usage-cost-usd.md) | 中文

## 概述

为每个持久化的 TokenUsage 新增可选的计费成本 costUsd。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-13-token-usage-cost-usd
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "39aea4918333186466d0ef13e5e330d432c2e5f679709684037119207b9ec39a"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "b33384cad1bb37fde7462b897a6147555998e990aeff8240758b606bee2ba568"
    decision: same-version
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "b2200ff436821da1fac464f76fa7e4b90dd3b4def5a5aa906562850dde0b1314"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有日志仍然有效：该字段在 assistant/attempt 与 assistant/message 的流式分块和消息用量上，以及 compaction/summary 的用量上均为可选。报告单次调用成本的提供方写入它；读取方把缺失视为成本未知而非零，成本展示只累加存在的值。已发布的 V0 用量将其作为非负有限数接受，V1 到 V4 的各迁移边原样保留它。模型可见输入不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/llm-pi-ai/tests/adapter.spec.ts packages/llm/llm-pi-ai/tests/convert.spec.ts packages/llm/llm-pi-ai/tests/catalog.spec.ts packages/llm/llm-pi-ai/tests/loader-composition.spec.ts packages/session/session-format-v0-to-v1/tests/legacy.spec.ts packages/session/session-format-v0-to-v1/tests/validation.spec.ts packages/session/session-persistence-jsonl/tests/v0-released-writer-variants.spec.ts：271 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。

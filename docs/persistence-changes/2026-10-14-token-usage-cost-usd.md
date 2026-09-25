---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-14-token-usage-cost-usd

English | [中文](2026-10-14-token-usage-cost-usd.zh.md)

## Summary

Adds the optional billed cost, costUsd, to every persisted TokenUsage.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-14-token-usage-cost-usd
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
## Compatibility

Existing logs remain valid: the field is optional on assistant/attempt and assistant/message stream chunks and message usage, and on compaction/summary usage. Providers that report a per-call cost write it; readers treat absence as unknown cost, never as zero, and cost displays sum only present values. Released V0 usage admits it as a non-negative finite number, and the V1-to-V4 edges carry it unchanged. No model-visible input changes.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/llm-pi-ai/tests/adapter.spec.ts packages/llm/llm-pi-ai/tests/convert.spec.ts packages/llm/llm-pi-ai/tests/catalog.spec.ts packages/llm/llm-pi-ai/tests/loader-composition.spec.ts packages/session/session-format-v0-to-v1/tests/legacy.spec.ts packages/session/session-format-v0-to-v1/tests/validation.spec.ts packages/session/session-persistence-jsonl/tests/v0-released-writer-variants.spec.ts: 276 tests passed.

<a id="dev-note"></a>
## Dev Note

None.

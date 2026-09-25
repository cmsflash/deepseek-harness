---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-08-24-token-usage-cost-usd

English | [中文](2026-08-24-token-usage-cost-usd.zh.md)

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
## Compatibility

Existing logs remain valid: the field is optional on assistant/attempt and assistant/message stream chunks and message usage, and on compaction/summary usage. Providers that report a per-call cost write it; readers treat absence as unknown cost, never as zero, and cost displays sum only present values. No model-visible input changes.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/llm-pi-ai/tests/adapter.spec.ts packages/llm/llm-pi-ai/tests/convert.spec.ts packages/session/session-format-v0-to-v1/tests/legacy.spec.ts packages/session/session-format-v0-to-v1/tests/validation.spec.ts packages/session/session-persistence-jsonl/tests/v0-released-writer-variants.spec.ts: 186 tests passed.

<a id="dev-note"></a>
## Dev Note

None.

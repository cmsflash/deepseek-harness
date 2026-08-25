# Agent Note: TokenUsage carries the call's billed cost

Status: implemented

English | [中文](2026-08-24-token-usage-carries-billed-cost.zh.md)

## Problem

Nothing in the Harness could say what a turn cost. `TokenUsage` carried counts only, so every consumer — the session log, the transcript, any future budget control — could report tokens and never money.

The data was already present and discarded. pi-ai prices every call against its model catalog and publishes the result on `Usage.cost` in dollars; `mapUsage` copied the four token fields and dropped it.

A second gap hid behind the first. `catalogModels()` is keyed by the configured route name, so a gateway route — `litellm` fronting Anthropic and DeepSeek — matches no catalog provider, every model resolves `cost: NO_COST`, and the total is zero even for models pi-ai prices precisely.

## Decision

`TokenUsage` gains an optional `costUsd`, and `llm-pi-ai`'s `mapUsage` copies pi-ai's `cost.total` into it. The field is absent rather than zero when the provider publishes no rates, because zero is a claim that the call was free.

Cost rides the existing `assistant/message` event's `usage` field, so it is durable and replayable with no new event. The client already forwards `usage` verbatim as `unknown`, so no wire change was needed.

`originCost()` resolves rates for a gateway model whose id names its origin (`anthropic/claude-opus-5`), and `resolveRouteModels` consults it after the installed entry and before `NO_COST`. The prefix identifies the model the gateway forwards to, and its published rates are what the gateway bills against. An unprefixed id, an unknown origin, or an unknown model stays unpriced rather than guessed.

## Alternatives considered

- **Read the gateway's own `x-litellm-response-cost` header.** Rejected: pi-ai owns the HTTP response and surfaces no headers on the generate path, so this needs wrapping global `fetch`, patching a third-party library, or a second billing request. Measured against a live LiteLLM gateway on six real token profiles — small, mid, ~1M-token, long-output, cache-write, and cache-read — pi-ai's computed dollars matched the gateway's billed header exactly in every case, so the header buys nothing the catalog does not already give.
- **Make rates configurable per model in the route profile.** Rejected for now: no consumer needs a rate the catalog lacks, and an unpriced model is honestly reported as unpriced. Configurability without a current consumer is a public choice made on speculation.
- **A separate `cost/recorded` session event.** Rejected: cost is an attribute of one model call, and `assistant/message` already carries that call's usage. A parallel event would need its own correlation and could disagree with the usage beside it.

## Consequences

- A route whose models pi-ai does not price reports no cost. That is visible as absence, not as `$0.00`.
- Cost is derived from catalog rates, not from a provider invoice. A stale catalog rate produces a confidently wrong number; the figure is an estimate that happens to be exact when the rates match.
- `llm-deepseek` is untouched and reports no cost. It would need the same mapping against its own price source.
- The number is available to any `TokenUsage` consumer, including the collapsed-step row's `conversation.chat.collapsedMetric` slot, which an out-of-tree plugin can fill without further core changes.

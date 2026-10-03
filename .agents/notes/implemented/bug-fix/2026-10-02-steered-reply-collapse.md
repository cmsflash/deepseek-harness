# Agent Note: Preserve replies when steering continues the same backend turn

Status: implemented

English | [中文](2026-10-02-steered-reply-collapse.zh.md)

## Problem

A backend turn can consume steered human input after it has produced an answer. The collapsed-steps reading mode kept only each turn's highest step, so it hid that answer inside the turn's single summary row, left the steer without a visible reply before it, and placed the later work's summary above the steer. Counting model calls from visible assistant rows also missed requests that produced only tool calls, with their tokens and time.

## Decision

Chat partitions each turn into response groups at human `user` and `steering` rows, using the step that claimed the input; a row logged before its step started belongs to the turn's next step. Context injections stay inside their group. A group keeps its highest assistant/tool step and its latest text-carrying step visible. Its other assistant/tool rows and its context rows fold behind a summary placed at its first hidden row, and that summary has an independent `turn:startStep` disclosure identity.

History elision retains, over the whole log, the last assistant step and last text-carrying step before each human `user/message`, as well as each turn's highest and closing steps. Injected context retains nothing. `session.expandSteps` still loads one backend turn; loading it opens only the group the reader selected.

Model calls, tokens, and time of loaded steps come from each step's published assistant data, which includes tool-only requests. Host accounts take precedence for the steps they cover, stay hidden after expansion, and are never counted again from loaded events. Contributed figures receive the group identity, materialized hidden node keys, and recorded counts; a counted step need not have a visible node.

This replaces the per-turn grouping and visible-row step counting of the [original collapse decision](../architecture/2026-08-14-chat-collapses-settled-steps.md), which retains the rationale for reusing Chat's renderer slot, disclosure lifetime, and contribution ordering. The [digest-paging decision](../architecture/2026-09-01-collapsed-step-digest-paging.md) still owns bounded fetches, whole-log retention, and account lifetime.

## Alternatives considered

**End the backend turn on every human steer.** Steering intentionally continues an active driver run. Changing durable lifecycle semantics to repair presentation would affect model scheduling, goals, and every other client.

**Keep every text-carrying intermediate step.** That keeps narration as well as answers and defeats the collapsed reading mode. Human inputs delimit responses without provider-specific message phases.

**Fix only the renderer.** A collapsed history page withholds the earlier answer before the renderer receives it. Retention and rendering must agree.

## Consequences

Earlier replies stay readable during continued work and after reopening history. Each summary describes one response, and expanding one group fetches events for the whole turn while other groups stay closed. Disclosure state stays local to the mounted view, and paging still limits the history available for accounting.

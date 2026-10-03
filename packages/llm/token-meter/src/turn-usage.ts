import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { AssistantMessage, TokenUsage } from '@deepseek-ai/dsh-llm/types'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** One provider/model route that contributed a billed request attempt. */
export interface TurnTokenUsageRoute {
  readonly provider: string
  readonly model: string
}

/** Exact provider-reported token accounting for every attempt in one completed Turn. */
export interface TurnTokenUsage {
  /** Sum of uncached prompt input across all attempts. */
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  /** Exact aggregate prompt plus output total across all attempts. */
  readonly totalTokens: number
  /** Present only when every attempt reported the bucket. */
  readonly cacheReadTokens?: number
  /** Present only when every attempt reported the bucket. */
  readonly cacheWriteTokens?: number
  /** Output subset, present only when every attempt reported it. */
  readonly reasoningTokens?: number
  /** Present only when every billed attempt has provider/model attribution. */
  readonly routes?: readonly TurnTokenUsageRoute[]
  /** Sum of every priced attempt's `costUsd`; unpriced attempts contribute zero. */
  readonly costUsd: number
  /** Attempts that reported usage without a `costUsd`. */
  readonly unpricedCalls: number
}

interface NormalizedAttempt {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly route?: TurnTokenUsageRoute
  readonly costUsd?: number
}

type AttemptState =
  | { readonly kind: 'idle' }
  | {
    readonly kind: 'open'
    readonly turn: number
    readonly step: number
    readonly sample?: TokenUsage
  }
  | {
    readonly kind: 'finishClosed'
    readonly turn: number
    readonly step: number
  }
  | {
    readonly kind: 'settled'
    readonly turn: number
    readonly step: number
    readonly by: 'message' | 'retry'
  }

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isCost(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function safeSum(values: readonly number[]): number | undefined {
  let total = 0
  for (const value of values) {
    total += value
    if (!Number.isSafeInteger(total)) return undefined
  }
  return total
}

function messageRoute(message: AssistantMessage): TurnTokenUsageRoute | undefined {
  const { provider, model } = message.source
  return provider.length > 0 && model.length > 0 ? { provider, model } : undefined
}

function streamUsage(stream: SessionEvent<'assistant/message'>['data']['stream']): TokenUsage | undefined {
  return lastAssistantStreamChunk(stream, 'usage')?.usage
}

function normalizeUsage(usage: TokenUsage, route?: TurnTokenUsageRoute): NormalizedAttempt | undefined {
  const {
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens, costUsd,
  } = usage
  if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined
  if (cacheReadTokens !== undefined && !isCount(cacheReadTokens)) return undefined
  if (cacheWriteTokens !== undefined && !isCount(cacheWriteTokens)) return undefined
  if (costUsd !== undefined && !isCost(costUsd)) return undefined
  if (reasoningTokens !== undefined && (!isCount(reasoningTokens) || reasoningTokens > outputTokens)) {
    return undefined
  }

  const knownPrompt = safeSum([
    inputTokens,
    ...cacheReadTokens === undefined ? [] : [cacheReadTokens],
    ...cacheWriteTokens === undefined ? [] : [cacheWriteTokens],
  ])
  if (knownPrompt === undefined) return undefined

  let exactTotal: number
  if (totalTokens !== undefined) {
    if (!isCount(totalTokens)) return undefined
    const exactPrompt = totalTokens - outputTokens
    if (!isCount(exactPrompt) || exactPrompt < knownPrompt) return undefined
    if (cacheReadTokens !== undefined && cacheWriteTokens !== undefined && exactPrompt !== knownPrompt) {
      return undefined
    }
    exactTotal = totalTokens
  } else {
    if (cacheReadTokens === undefined || cacheWriteTokens === undefined) return undefined
    const derivedTotal = safeSum([knownPrompt, outputTokens])
    if (derivedTotal === undefined) return undefined
    exactTotal = derivedTotal
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: exactTotal,
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
    ...route === undefined ? {} : { route },
    ...costUsd === undefined ? {} : { costUsd },
  }
}

function addOptional(total: number | undefined, value: number | undefined): number | undefined {
  return total === undefined || value === undefined ? undefined : safeSum([total, value])
}

function sameAttempt(
  state: Exclude<AttemptState, { kind: 'idle' }>,
  turn: number,
  step: number,
): boolean {
  return state.turn === turn && state.step === step
}

/**
 * Incrementally fold one Turn's durable attempt lifecycle into exact token accounting.
 *
 * Retains only lifecycle state, running totals, and distinct routes, not events or
 * completed attempts. Instances never reset. Missing lifecycle boundaries,
 * incomplete attempt usage, unsafe counts, non-finite aggregate costs, or
 * contradictory exact totals make the whole disclosure unavailable.
 */
export class TurnUsageAccumulator {
  private state: AttemptState = { kind: 'idle' }
  private turn: number | undefined
  private sawEnd = false
  private invalid = false
  private attemptCount = 0
  private inputTokens = 0
  private outputTokens = 0
  private totalTokens = 0
  private cacheReadTokens: number | undefined = 0
  private cacheWriteTokens: number | undefined = 0
  private reasoningTokens: number | undefined = 0
  private routes: Map<string, TurnTokenUsageRoute> | undefined = new Map()
  private costUsd = 0
  private unpricedCalls = 0

  /**
   * Consume a Turn-local event in durable order; invalidity is permanent.
   * Events outside `turn/start` through `turn/end` invalidate even a completed result.
   * @param event - Next durable event for this Turn.
   */
  append(event: SessionEvent): void {
    if (this.invalid) return
    if (event.type === 'turn/start') {
      if (this.turn !== undefined || this.state.kind !== 'idle') this.invalid = true
      else this.turn = event.data.turn
      return
    }
    const turn = this.turn
    if (turn === undefined) {
      this.invalid = true
      return
    }
    if (event.type === 'turn/end') {
      if (event.data.turn !== turn || this.state.kind !== 'idle' || this.sawEnd) this.invalid = true
      else this.sawEnd = true
      return
    }
    if (this.sawEnd) {
      this.invalid = true
      return
    }
    if (event.type === 'step/start') {
      if (event.data.turn !== turn || this.state.kind !== 'idle') this.invalid = true
      else this.state = { kind: 'open', turn, step: event.data.step }
      return
    }
    if (event.type === 'llm/retry-started') {
      if (event.data.turn !== turn
        || this.state.kind !== 'settled'
        || this.state.by !== 'retry'
        || !sameAttempt(this.state, event.data.turn, event.data.step)) this.invalid = true
      else this.state = { kind: 'open', turn, step: event.data.step }
      return
    }
    if (event.type === 'assistant/attempt') {
      if (event.data.turn !== turn
        || this.state.kind !== 'open'
        || !sameAttempt(this.state, event.data.turn, event.data.step)) {
        this.invalid = true
        return
      }
      const sample: TokenUsage | undefined = streamUsage(event.data.stream) ?? this.state.sample
      this.state = { kind: 'open', turn, step: event.data.step, ...(sample === undefined ? {} : { sample }) }
      if (!this.closeOpen()) this.invalid = true
      else this.state = { kind: 'finishClosed', turn, step: event.data.step }
      return
    }
    if (event.type === 'assistant/message') {
      if (event.data.turn !== turn
        || this.state.kind !== 'open'
        || !sameAttempt(this.state, event.data.turn, event.data.step)) {
        this.invalid = true
        return
      }
      const sample = event.data.usage ?? streamUsage(event.data.stream)
      if (sample !== undefined) this.state = { ...this.state, sample }
      if (!this.closeOpen(messageRoute(event.data.message))) this.invalid = true
      else this.state = { kind: 'settled', turn, step: event.data.step, by: 'message' }
      return
    }
    if (event.type === 'llm/retry') {
      if (event.data.turn !== turn || this.state.kind === 'idle'
        || !sameAttempt(this.state, event.data.turn, event.data.step)) {
        this.invalid = true
        return
      }
      if (this.state.kind === 'settled' || (this.state.kind === 'open' && !this.closeOpen())) this.invalid = true
      if (!this.invalid) this.state = { kind: 'settled', turn, step: event.data.step, by: 'retry' }
      return
    }
    if (event.type === 'step/end') {
      if (event.data.turn !== turn || this.state.kind === 'idle'
        || !sameAttempt(this.state, event.data.turn, event.data.step)) {
        this.invalid = true
        return
      }
      if (this.state.kind === 'open' && !this.closeOpen()) this.invalid = true
      if (!this.invalid) this.state = { kind: 'idle' }
    }
  }

  /**
   * Read accounting without changing the accumulated lifecycle.
   * @returns exact usage after a valid `turn/end`, or undefined for incomplete,
   * invalid, or zero-attempt turns.
   */
  result(): TurnTokenUsage | undefined {
    if (this.invalid || !this.sawEnd || this.state.kind !== 'idle' || this.attemptCount === 0) return undefined
    return {
      uncachedInputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.totalTokens,
      ...this.cacheReadTokens === undefined ? {} : { cacheReadTokens: this.cacheReadTokens },
      ...this.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: this.cacheWriteTokens },
      ...this.reasoningTokens === undefined ? {} : { reasoningTokens: this.reasoningTokens },
      ...this.routes === undefined ? {} : { routes: [...this.routes.values()] },
      costUsd: this.costUsd,
      unpricedCalls: this.unpricedCalls,
    }
  }

  private closeOpen(route?: TurnTokenUsageRoute): boolean {
    if (this.state.kind !== 'open' || this.state.sample === undefined) return false
    const normalized = normalizeUsage(this.state.sample, route)
    if (normalized === undefined) return false
    const inputTokens = safeSum([this.inputTokens, normalized.inputTokens])
    const outputTokens = safeSum([this.outputTokens, normalized.outputTokens])
    const totalTokens = safeSum([this.totalTokens, normalized.totalTokens])
    if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return false
    this.inputTokens = inputTokens
    this.outputTokens = outputTokens
    this.totalTokens = totalTokens
    this.attemptCount += 1
    this.cacheReadTokens = addOptional(this.cacheReadTokens, normalized.cacheReadTokens)
    this.cacheWriteTokens = addOptional(this.cacheWriteTokens, normalized.cacheWriteTokens)
    this.reasoningTokens = addOptional(this.reasoningTokens, normalized.reasoningTokens)
    if (normalized.route === undefined) this.routes = undefined
    else this.routes?.set(`${normalized.route.provider}\0${normalized.route.model}`, normalized.route)
    if (normalized.costUsd === undefined) this.unpricedCalls += 1
    else this.costUsd += normalized.costUsd
    return Number.isFinite(this.costUsd)
  }
}

/**
 * Fold one complete Turn's durable attempt lifecycle into exact token accounting.
 *
 * No attempt is inferred from a usage sample. Any missing lifecycle boundary,
 * incomplete attempt usage, unsafe count, non-finite aggregate cost, or
 * contradictory exact total makes the whole disclosure unavailable.
 * @param events - Turn-local durable events from `turn/start` through `turn/end`.
 * @returns exact aggregate usage, or undefined when it cannot be proven.
 */
export function deriveTurnTokenUsage(events: readonly SessionEvent[]): TurnTokenUsage | undefined {
  const accumulator = new TurnUsageAccumulator()
  for (const event of events) accumulator.append(event)
  return accumulator.result()
}

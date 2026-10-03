import { TurnUsageAccumulator } from '@deepseek-ai/dsh-token-meter/turn-usage'
import type { TurnTokenUsage } from '@deepseek-ai/dsh-token-meter/turn-usage'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Whole-turn accounting over one ordered history source. */
export class HistoryTurnUsage {
  private current: { readonly turn: number; readonly usage: TurnUsageAccumulator } | undefined

  /**
   * Consume one durable event without retaining its body.
   * @param event - next durable event at the history source's sequence cut.
   * @returns accounting at turn/end, null for unavailable accounting, or undefined before an end.
   */
  append(event: SessionEvent): TurnTokenUsage | null | undefined {
    if (event.type === 'turn/start' && this.current?.turn !== event.data.turn) {
      this.current = { turn: event.data.turn, usage: new TurnUsageAccumulator() }
    }
    this.current?.usage.append(event)
    if (event.type !== 'turn/end') return undefined
    const usage = this.current?.usage.result() ?? null
    this.current = undefined
    return usage
  }
}

/**
 * Select complete-turn usage only for end records present in the page.
 * @param page - events whose turn-end records are being served.
 * @param scope - complete source prefix through the requested history cut.
 * @returns summaries keyed by their end sequence and the fold ready for later live events.
 */
export function historyTurnUsage(page: readonly SessionEvent[], scope: readonly SessionEvent[]): {
  readonly byEnd: ReadonlyMap<number, TurnTokenUsage | null>
  readonly continuation: HistoryTurnUsage
} {
  const ends = new Set(page.filter(event => event.type === 'turn/end').map(event => event.seq))
  const byEnd = new Map<number, TurnTokenUsage | null>()
  const continuation = new HistoryTurnUsage()
  for (const event of scope) {
    const usage = continuation.append(event)
    if (usage !== undefined && ends.has(event.seq)) byEnd.set(event.seq, usage)
  }
  return { byEnd, continuation }
}

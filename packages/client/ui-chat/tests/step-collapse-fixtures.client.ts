import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * Publish each turn's steps with their assistant data, as the Assistant
 * Definition's Location data does. A step's start seq is `step * 10`.
 * @param nodes - all materialized test nodes.
 * @param extra - assistant data of steps that render no node, keyed `turn:step`.
 * @returns the turn/step facts the step-collapse fold reads.
 */
export function timelineOf(
  nodes: readonly ChatConversationViewNode[],
  extra: ReadonlyMap<string, unknown> = new Map(),
): ConversationTimelineSnapshot {
  const turns = new Map<number, Map<number, unknown>>()
  const touch = (turn: number, step: number, data: unknown): void => {
    let steps = turns.get(turn)
    if (steps === undefined) turns.set(turn, steps = new Map<number, unknown>())
    if (!steps.has(step) || data !== undefined) steps.set(step, data)
  }
  for (const node of nodes) {
    if (node.location.kind !== 'step') continue
    touch(node.location.turn.turn, node.location.step.step, node.kind === 'assistant-step' ? node.data : undefined)
  }
  for (const [key, data] of extra) {
    const [turn, step] = key.split(':').map(Number) as [number, number]
    touch(turn, step, data)
  }
  return {
    turnOrder: [...turns.keys()],
    turns: new Map([...turns].map(([turn, steps]) => [turn, {
      turn,
      status: 'closed',
      steps: [...steps].sort(([left], [right]) => left - right).map(([step, data]) => ({
        turn, step, start: { seq: step * 10 }, status: 'closed',
        data: { get: (key: string) => (key === 'assistant-step' ? data : undefined) },
      })),
    }])),
  } as unknown as ConversationTimelineSnapshot
}

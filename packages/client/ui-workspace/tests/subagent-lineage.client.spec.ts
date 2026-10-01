import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { indexSubagentDescendants, ownCostUsd } from '../src/client/subagent-lineage.ts'

const sid = (id: string): SessionId => id as SessionId
const usage = (costUsd: number): TokenUsageProjection => ({
  uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd, unpricedCalls: 0,
})

describe('UI Workspace descendant projection', () => {
  it('counts nested running descendants and stops at ordinary forks', () => {
    const root = { id: sid('root'), running: false }
    const child = { id: sid('child'), parentId: root.id, origin: 'subagent' as const, running: true }
    const leaf = { id: sid('leaf'), parentId: child.id, origin: 'subagent' as const, running: false }
    const fork = { id: sid('fork'), parentId: child.id, running: false }
    const result = indexSubagentDescendants(Object.fromEntries(
      [root, child, leaf, fork].map(item => [item.id, item]),
    ))
    expect(result.get(root.id)).toEqual({ count: 2, runningCount: 1, costUsd: 0 })
    expect(result.get(child.id)).toEqual({ count: 1, runningCount: 0, costUsd: 0 })
    expect(result.has(fork.id)).toBe(false)
  })

  it('terminates cycles and retains missing-parent aggregates', () => {
    const a = { id: sid('a'), parentId: sid('b'), origin: 'subagent' as const, running: false }
    const b = { id: sid('b'), parentId: sid('a'), origin: 'subagent' as const, running: false }
    const orphan = { id: sid('orphan'), parentId: sid('missing'), origin: 'subagent' as const, running: true }
    const result = indexSubagentDescendants({ [a.id]: a, [b.id]: b, [orphan.id]: orphan })
    expect(result.get(a.id)?.count).toBe(2)
    expect(result.get(b.id)?.count).toBe(2)
    expect(result.get(sid('missing'))).toEqual({ count: 1, runningCount: 1, costUsd: 0 })
  })

  it('sums each descendant\'s own spend into every ancestor', () => {
    const root = { id: sid('root'), running: false, projectionValues: { ownTokenUsage: usage(1) } }
    const child = {
      id: sid('child'), parentId: root.id, origin: 'subagent' as const, running: false,
      projectionValues: { ownTokenUsage: usage(0.25), tokenUsage: usage(9) },
    }
    const leaf = {
      id: sid('leaf'), parentId: child.id, origin: 'subagent' as const, running: false,
      projectionValues: { tokenUsage: usage(0.5) },
    }
    const result = indexSubagentDescendants(Object.fromEntries(
      [root, child, leaf].map(item => [item.id, item]),
    ))
    expect(result.get(root.id)?.costUsd).toBe(0.75)
    expect(result.get(child.id)?.costUsd).toBe(0.5)
  })

  it('reads own spend, falls back to the complete-log total, and treats absence as zero', () => {
    expect(ownCostUsd({ projectionValues: { ownTokenUsage: usage(2), tokenUsage: usage(40) } })).toBe(2)
    expect(ownCostUsd({ projectionValues: { tokenUsage: usage(3) } })).toBe(3)
    expect(ownCostUsd({ projectionValues: {} })).toBe(0)
    expect(ownCostUsd({})).toBe(0)
  })
})

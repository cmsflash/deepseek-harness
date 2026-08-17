// Focus view: one collapsed metric row per earlier turn, then the latest turn
// rendered in full — including while it is still a tool-call turn, so the
// reader always sees current work without the transcript above it.
//
// Composition note: 'conversation.chat.node' is declared (and therefore owned)
// by the chat view entry, so this view renders the latest turn from the
// target-neutral node stream itself rather than dispatching another view's
// keyed row renderers.

import { memo, useMemo } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationNode, ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { LatestTurn } from './LatestTurn.tsx'
import { TurnSummaryRow } from './TurnSummaryRow.tsx'
import { deriveFocusMetrics, totalTokens, type TurnSummary } from './turn-summary.ts'
import { formatDuration, formatTokens } from './format.ts'
import css from './FocusView.module.css'

/** Session-bound callbacks the conversation view slot does not already supply. */
export interface FocusViewInjected {
  loadOlder: () => void
}

/** Full focus-view props: the view standard kit, its injected share, and the locale seat. */
export type FocusViewProps = ConvViewProps & InjectFace<FocusViewInjected> & PropsLocale<'focus'>

/**
 * Sum the collapsed rows into the figures the trailing total line displays.
 *
 * `filesTouched` sums per-turn counts, so a file edited across several turns
 * counts once per turn that touched it; the total reports edit episodes rather
 * than distinct paths, which the per-turn rows already answer.
 * @param previous - the collapsed turn summaries.
 * @returns the summed figures, with elapsed time absent when no turn recorded it.
 */
export function foldTotals(previous: readonly TurnSummary[]): Omit<TurnSummary, 'turn' | 'boundaryKnown'> {
  let steps = 0
  let calls = 0
  let filesTouched = 0
  let added = 0
  let removed = 0
  let input = 0
  let output = 0
  let elapsedMs: number | undefined
  for (const summary of previous) {
    steps += summary.steps
    calls += summary.calls
    filesTouched += summary.filesTouched
    added += summary.lines.added
    removed += summary.lines.removed
    input += summary.tokens.input
    output += summary.tokens.output
    if (summary.elapsedMs !== undefined) elapsedMs = (elapsedMs ?? 0) + summary.elapsedMs
  }
  return {
    steps,
    calls,
    filesTouched,
    lines: { added, removed },
    tokens: { input, output },
    ...elapsedMs === undefined ? {} : { elapsedMs },
  }
}

/**
 * Take the loaded window's tail from the latest turn's own `turn/start` seq.
 *
 * The engine-owned boundary is the authority, so the slice keeps every node the
 * turn produced — the prompting user message included — without inferring turn
 * ownership for the node kinds that carry no turn coordinate. A latest turn
 * whose start was paged out falls back to the nodes its steps identify.
 * @param nodes - settled nodes of the loaded window, ascending by seq.
 * @param timeline - engine-owned turn boundaries for the same window.
 * @param latestTurn - the turn to render in full.
 * @returns that turn's nodes, empty when the window holds none.
 */
export function latestTurnNodes(
  nodes: readonly ConversationNode[],
  timeline: ConversationTimelineSnapshot,
  latestTurn: number | undefined,
): readonly ConversationNode[] {
  if (latestTurn === undefined) return []
  const startSeq = timeline.turns.get(latestTurn)?.start?.seq
  if (startSeq !== undefined) {
    // The prompting user message is logged just before turn/start, so the
    // slice opens at the newest node preceding the boundary when that node is
    // the human turn opener.
    const opener = nodes.filter(node => node.seq < startSeq).at(-1)
    const from = opener?.kind === 'user' ? opener.seq : startSeq
    return nodes.filter(node => node.seq >= from)
  }
  let firstSeq: number | undefined
  for (const node of nodes) {
    if (node.kind === 'assistant' && node.turn === latestTurn) {
      firstSeq = node.seq
      break
    }
  }
  return firstSeq === undefined ? [] : nodes.filter(node => node.seq >= firstSeq)
}

/**
 * The trailing total line over at least one collapsed turn.
 *
 * A summary exists only because an assistant step produced it, so the step
 * count is always present and needs no empty-line guard; every other group
 * drops out when the collapsed turns carry none of it.
 */
const TotalRow = memo(function TotalRow({ previous, t }: {
  previous: readonly TurnSummary[]
  t: FocusViewProps['t']
}) {
  const totals = useMemo(() => foldTotals(previous), [previous])
  const tokens = totalTokens(totals.tokens)
  const parts: string[] = [t('metric.steps', { count: totals.steps })]
  if (totals.calls > 0) parts.push(t('metric.calls', { count: totals.calls }))
  if (totals.lines.added > 0 || totals.lines.removed > 0) {
    parts.push([
      t('metric.linesAdded', { added: totals.lines.added }),
      t('metric.linesRemoved', { removed: totals.lines.removed }),
    ].join(' / '))
  }
  if (totals.elapsedMs !== undefined) {
    parts.push(t('metric.elapsed', { duration: formatDuration(totals.elapsedMs) }))
  }
  if (tokens > 0) {
    parts.push(t('metric.tokens', {
      total: formatTokens(tokens),
      input: formatTokens(totals.tokens.input),
      output: formatTokens(totals.tokens.output),
    }))
  }
  return (
    <div className={css.total}>
      <div className={css.bandHeading}>
        <span>{t('total.label')}</span>
        <span>{parts.join(' · ')}</span>
      </div>
    </div>
  )
})

/**
 * The focus view entry: collapsed earlier turns over the durable node stream,
 * then the latest turn in full.
 * @param props - the composed view props.
 * @returns the focus view content.
 */
export function FocusView({ useSession, loadOlder, t }: FocusViewProps) {
  const nodes = useSession(s => s.chat.legacy.nodes)
  const timeline = useSession(s => s.chat.timeline)
  const partial = useSession(s => s.chat.legacy.partial)
  const runningCalls = useSession(s => s.chat.legacy.runningCalls)
  const hasMore = useSession(s => s.hasMore)
  const loadingOlder = useSession(s => s.loadingOlder)
  const running = useSession(s => s.running)

  const metrics = useMemo(
    () => deriveFocusMetrics(nodes, timeline, hasMore),
    [nodes, timeline, hasMore],
  )
  const latest = useMemo(
    () => latestTurnNodes(nodes, timeline, metrics.latestTurn),
    [nodes, timeline, metrics.latestTurn],
  )

  return (
    <div className={css.root} data-focus-view="">
      {hasMore && (
        <div className={css.older}>
          <Button variant="ghost" disabled={loadingOlder} onClick={loadOlder}>
            {loadingOlder ? t('loading') : t('summary.loadOlder')}
          </Button>
        </div>
      )}
      {metrics.previous.length === 0
        ? <div className={css.empty}>{t('summary.empty')}</div>
        : (
          <div className={css.band}>
            <div className={css.bandHeading}>
              {t('summary.collapsedHeading', { count: metrics.previous.length })}
            </div>
            {metrics.truncated && <div className={css.notice}>{t('summary.truncated')}</div>}
            {metrics.previous.map(summary => (
              <TurnSummaryRow key={summary.turn} summary={summary} t={t} />
            ))}
            <TotalRow previous={metrics.previous} t={t} />
          </div>
        )}
      <div className={css.divider} />
      <LatestTurn
        nodes={latest}
        partial={partial}
        runningCalls={runningCalls}
        running={running}
        t={t}
      />
    </div>
  )
}

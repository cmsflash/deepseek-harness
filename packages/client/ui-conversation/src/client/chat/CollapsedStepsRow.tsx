import { Fragment, memo, type ReactNode } from 'react'
import { IconChevronDownOutline14, IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps, CollapsedMetricOwnerProps } from '../contract/slots.ts'
import { formatDuration, formatTokens } from './StatsLine.tsx'
import type { CollapsedStepMetrics } from './step-collapse.ts'
import css from './CollapsedStepsRow.module.css'

/** Props of one collapsed-steps summary row. */
export interface CollapsedStepsRowProps {
  /** Turn owning the hidden steps. */
  turn: number
  /** Node keys this row hides, passed to contributors so they fold the same set. */
  keys: readonly string[]
  metrics: CollapsedStepMetrics
  expanded: boolean
  onToggle: () => void
  /** Contributed figures, rendered after every built-in one. */
  renderSlot: ChatViewSlotProps['renderSlot']
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}

/**
 * One row standing in for a turn's settled steps: the work they did, and the
 * control that reveals them. Expansion is all-or-nothing for the turn, so the
 * disclosure control is the only affordance and needs no per-step state.
 *
 * The control and the figures are siblings rather than nested, so a
 * contributed figure may carry its own interactive content without landing
 * inside a button.
 */
export const CollapsedStepsRow = memo(function CollapsedStepsRow({
  turn, keys, metrics, expanded, onToggle, renderSlot, t,
}: CollapsedStepsRowProps) {
  const parts: ReactNode[] = []
  if (metrics.elapsedMs > 0) {
    parts.push(<span key="elapsed" className={css.metric}>{formatDuration(metrics.elapsedMs)}</span>)
  }
  // A turn whose intermediate work is entirely tool calls settles no assistant
  // node before its last step, so the step count would read zero and mislead;
  // the call count already describes what is hidden.
  if (metrics.steps > 0) {
    parts.push(<span key="steps" className={css.metric}>{t('collapse.steps', { count: metrics.steps })}</span>)
  }
  if (metrics.calls > 0) {
    parts.push(<span key="calls" className={css.metric}>{t('collapse.calls', { count: metrics.calls })}</span>)
  }
  const tokens = metrics.inputTokens + metrics.outputTokens
  if (tokens > 0) {
    parts.push(
      <span key="tokens" className={css.metric}>
        {t('collapse.tokens', {
          total: formatTokens(tokens),
          input: formatTokens(metrics.inputTokens),
          output: formatTokens(metrics.outputTokens),
        })}
      </span>,
    )
  }
  if (metrics.added > 0 || metrics.removed > 0) {
    parts.push(
      <span key="lines" className={css.metric}>
        <span className={css.added}>{t('collapse.linesAdded', { added: metrics.added })}</span>
        {' / '}
        <span className={css.removed}>{t('collapse.linesRemoved', { removed: metrics.removed })}</span>
      </span>,
      <span key="files" className={css.metric}>{t('collapse.files', { count: metrics.files })}</span>,
    )
  }
  const owner: CollapsedMetricOwnerProps = { turn, keys, steps: metrics.steps, calls: metrics.calls }
  return (
    <div className={css.row} data-collapsed-turn={turn}>
      <button
        type="button"
        className={css.disclosure}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className={css.chevron} aria-hidden>
          {expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </span>
        <span className={css.metrics}>
          {parts.map((part, index) => (
            <Fragment key={index}>
              {index > 0 && <span className={css.sep} aria-hidden>·</span>}
              {part}
            </Fragment>
          ))}
        </span>
      </button>
      {/* Contributed figures follow every built-in one, so a plugin never has
          to reserve an order band against figures this row may add later. */}
      <span className={css.contributed}>
        {renderSlot('conversation.chat.collapsedMetric', owner)}
      </span>
    </div>
  )
})

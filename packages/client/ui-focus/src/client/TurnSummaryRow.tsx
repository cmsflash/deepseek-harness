import { Fragment, memo, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { formatDuration, formatTokens } from './format.ts'
import { totalTokens, type TurnSummary } from './turn-summary.ts'
import css from './TurnSummaryRow.module.css'

/** The focus namespace translate seat, threaded from the view's locale share. */
export type FocusTranslate = TranslateNS<'focus'>

/** Props of one collapsed turn row. */
export interface TurnSummaryRowProps {
  summary: TurnSummary
  t: FocusTranslate
}

/**
 * Line delta whose two signs carry their own colors. Each side is its own
 * dictionary key, so the added and removed phrases stay independently
 * translatable and neither colour depends on parsing a composed sentence.
 */
function LineDelta({ summary, t }: TurnSummaryRowProps): ReactNode {
  return (
    <span className={css.metric}>
      <span className={css.added}>{t('metric.linesAdded', { added: summary.lines.added })}</span>
      {' / '}
      <span className={css.removed}>{t('metric.linesRemoved', { removed: summary.lines.removed })}</span>
    </span>
  )
}

/**
 * One earlier turn as a single metric line: counts, edit volume, wall time,
 * and token spend. Every figure is already folded, so the row is a pure
 * function of its summary.
 */
export const TurnSummaryRow = memo(function TurnSummaryRow({ summary, t }: TurnSummaryRowProps) {
  const metrics: ReactNode[] = []
  if (summary.steps > 0) {
    metrics.push(
      <span key="steps" className={css.metric}>{t('metric.steps', { count: summary.steps })}</span>,
    )
  }
  if (summary.calls > 0) {
    metrics.push(
      <span key="calls" className={css.metric}>{t('metric.calls', { count: summary.calls })}</span>,
    )
  }
  if (summary.lines.added > 0 || summary.lines.removed > 0) {
    metrics.push(<LineDelta key="lines" summary={summary} t={t} />)
    metrics.push(
      <span key="files" className={css.metric}>
        {t('metric.files', { count: summary.filesTouched })}
      </span>,
    )
  }
  if (summary.elapsedMs !== undefined) {
    metrics.push(
      <span key="elapsed" className={css.metric}>
        {t('metric.elapsed', { duration: formatDuration(summary.elapsedMs) })}
      </span>,
    )
  }
  const tokens = totalTokens(summary.tokens)
  if (tokens > 0) {
    metrics.push(
      <span key="tokens" className={css.metric}>
        {t('metric.tokens', {
          total: formatTokens(tokens),
          input: formatTokens(summary.tokens.input),
          output: formatTokens(summary.tokens.output),
        })}
      </span>,
    )
  }
  return (
    <div className={css.row} data-focus-turn={summary.turn}>
      <span className={css.turn}>{t('summary.turn', { turn: summary.turn })}</span>
      <span className={css.metrics}>
        {metrics.map((metric, index) => (
          <Fragment key={index}>
            {index > 0 && <span className={css.sep} aria-hidden>·</span>}
            {metric}
          </Fragment>
        ))}
      </span>
    </div>
  )
})

/** General Settings row for the Chat step-collapse preference. */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './CollapseStepsRow.module.css'

/** Registration-side preference face. */
export interface CollapseStepsRowInjected {
  hooks: {
    /** Persisted collapse preference bound as useCollapseSteps. */
    collapseSteps: SnapshotStore<boolean>
  }
  /** Change whether a turn's settled steps collapse behind one summary row. */
  setCollapseSteps: (collapse: boolean) => void
}

/** Full Settings-row props. */
export type CollapseStepsRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<CollapseStepsRowInjected>

/**
 * Render the step-collapse preference toggle.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function CollapseStepsRow({ useCollapseSteps, setCollapseSteps, t }: CollapseStepsRowProps) {
  const collapse = useCollapseSteps(value => value)
  return (
    <label className={css.row}>
      <span className={css.rowText}>
        <span className={css.title}>{t('settings.collapse.title')}</span>
        <span className={css.desc}>{t('settings.collapse.description')}</span>
      </span>
      <input
        type="checkbox"
        className={css.control}
        checked={collapse}
        onChange={(event) => { setCollapseSteps(event.currentTarget.checked) }}
      />
    </label>
  )
}

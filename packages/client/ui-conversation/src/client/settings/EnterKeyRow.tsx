/** General Settings row for the browser-local meaning of plain Enter. */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { EnterKeyBehavior } from '../contract/composer-submission.ts'
import { PreferenceSelectRow } from './PreferenceSelectRow.tsx'

/** Registration-side preference face. */
export interface EnterKeyRowInjected {
  hooks: {
    /** Browser-local preference bound as useEnterKey. */
    enterKey: SnapshotStore<EnterKeyBehavior>
  }
  /** Change what plain Enter does in this browser. */
  setEnterKey: (behavior: EnterKeyBehavior) => void
}

/** Full Settings-row props. */
export type EnterKeyRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<EnterKeyRowInjected>

const ORDER: readonly EnterKeyBehavior[] = ['send', 'newline']

/**
 * Render the Enter-key behavior selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function EnterKeyRow({ useEnterKey, setEnterKey, t }: EnterKeyRowProps) {
  return (
    <PreferenceSelectRow
      title={t('settings.enterKey.title')}
      description={t('settings.enterKey.description')}
      order={ORDER}
      labels={{ send: t('settings.enterKey.send'), newline: t('settings.enterKey.newline') }}
      selected={useEnterKey(value => value)}
      onSelect={setEnterKey}
    />
  )
}

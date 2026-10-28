/**
 * The brand-row Continue control: an icon button that sends `Continue.` to
 * every interrupted Session. It renders nothing while no Session is
 * interrupted.
 */
import { IconLoadingOutlineRegular, IconPlayOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContinueInterruptedProps } from '../contract/slots.ts'
import css from './ContinueInterrupted.module.css'

/**
 * Render the Continue control.
 * @param props - the interrupted-Session hook, the bulk continue, and the locale seat.
 * @returns the control, or null when no Session is interrupted.
 */
export function ContinueInterruptedButton({
  useInterruptedSessions, continueInterruptedSessions, t,
}: ContinueInterruptedProps) {
  const visible = useInterruptedSessions(state => state.sessionIds.length > 0)
  const continuing = useInterruptedSessions(state => state.continuing)
  if (!visible) return null
  const label = t('continueInterrupted')
  return (
    <Tooltip label={label} side="bottom" delayMs={500} portal>
      <button
        type="button"
        className={css.button}
        aria-label={label}
        aria-disabled={continuing}
        onClick={() => { if (!continuing) continueInterruptedSessions() }}
      >
        {continuing
          ? <IconLoadingOutlineRegular className={css.spinner} size={16} />
          : <IconPlayOutlineRegular size={16} />}
      </button>
    </Tooltip>
  )
}

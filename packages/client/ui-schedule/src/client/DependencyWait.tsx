/**
 * The dependency-wait action: a row in each Session's "..." menu that puts the
 * Session on hold until something outside it happens, or takes it off hold.
 * Starting a wait asks the user nothing; the Session's own agent works out
 * what it is waiting on and names the wait.
 */
import { IconCloseOutlineRegular, IconPauseOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { CatalogSnapshot } from './catalog-source.ts'
import { sessionWaits } from './dependency-wait.ts'
import type { NS } from './locales.ts'

/** Menu-row share: the shared Host catalog and the start and stop actions. */
export interface DependencyWaitMenuInjected {
  /** One catalog shared by every row; the renderer binds it to the `useCatalog` selector hook. */
  readonly hooks: { readonly catalog: HostObservable<CatalogSnapshot<ScheduleCatalogEntry>> }
  /**
   * Put one Session on hold; a request the Host does not confirm raises the app-wide notice.
   * @param sessionId - Session to put on hold.
   * @param title - localized name the wait task carries until the agent renames it.
   */
  readonly startWait: (sessionId: SessionId, title: string) => void
  /**
   * End every active wait of one Session; a failure raises the app-wide notice.
   * @param sessionId - Session to take off hold.
   */
  readonly stopWait: (sessionId: SessionId) => void
}

/** Full props of the menu row. */
export type DependencyWaitMenuItemProps = PropsRuntime<'sidebar.workspaces.session.menu.item'>
  & PropsLocale<typeof NS>
  & InjectFace<DependencyWaitMenuInjected>

/**
 * Menu row: **Wait on dependency** starts a wait; on a waiting Session the row
 * reads **Stop waiting** and ends the wait. Absent on archived rows, whose
 * tasks archiving already stopped.
 * @param props - owner share, menu open state, Workspace hook, catalog hook, actions, and locale seat.
 * @returns the row, or null for an archived Session.
 */
export function DependencyWaitMenuItem({
  sessionId, useMenuOpenState, useWorkspaces, useCatalog, startWait, stopWait, t,
}: DependencyWaitMenuItemProps) {
  const [, setMenuOpen] = useMenuOpenState()
  const waiting = useCatalog(snapshot => sessionWaits(snapshot, sessionId).length > 0)
  const archived = useWorkspaces(snapshot => snapshot.archivedSessionIds.includes(sessionId))
  if (archived) return null
  return (
    <MenuItemButton
      icon={waiting ? <IconCloseOutlineRegular /> : <IconPauseOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false)
        if (waiting) stopWait(sessionId)
        else startWait(sessionId, t('wait.taskTitle'))
      }}
    >
      {t(waiting ? 'wait.stop' : 'wait.menu')}
    </MenuItemButton>
  )
}

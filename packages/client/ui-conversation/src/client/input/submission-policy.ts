/**
 * Composer submission policy. It owns the live busy-Enter and Enter-key
 * preferences and resolves submission gestures into queue/steer delivery
 * modes; Host and Agent keep the actual delivery-window authority.
 */
import {
  createSnapshotStore, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  BusyEnterBehavior, ComposerSubmitGesture, EnterKeyBehavior, InputSubmitMode,
} from '../contract/composer-submission.ts'
import { BUSY_ENTER_FIELD, DEFAULT_BUSY_ENTER_BEHAVIOR } from '../../submission-settings.ts'
import type { ConversationSettings } from '../../submission-settings.ts'

export { DEFAULT_BUSY_ENTER_BEHAVIOR } from '../../submission-settings.ts'

/** localStorage key of the Enter-key preference, which each browser keeps separately. */
export const ENTER_KEY_STORAGE_KEY = 'dsh.composer.enterKey'

/**
 * Resolve one submission gesture against the busy-Enter preference. Plain
 * Enter and the primary Send button share the `enter` gesture, so the button
 * delivers exactly what Enter would. Direct `steer` is intentionally
 * best-effort: AgentLoop turns a closed-window submission into the next waking
 * Queue item.
 * @param preferred - the live busy-Enter preference.
 * @param running - whether the addressed agent currently reports busy.
 * @param gesture - plain Enter (or the Send button) or the Cmd/Ctrl-accelerated chord.
 * @param steeringAvailable - whether this session transport supports steering.
 * @returns Queue outside steer-capable busy state; otherwise the preferred mode or its opposite.
 */
export function resolveSubmitMode(
  preferred: BusyEnterBehavior,
  running: boolean,
  gesture: ComposerSubmitGesture,
  steeringAvailable: boolean,
): InputSubmitMode {
  if (!running || !steeringAvailable) return 'queue'
  if (gesture === 'enter') return preferred
  return preferred === 'queue' ? 'steer' : 'queue'
}

/**
 * Submission preferences shared by the composer bar inject face and its
 * Settings rows. The busy-Enter store is backed by the Host user-settings
 * document when one is composed; the Enter-key store persists only in this
 * browser's localStorage, so a phone and a desktop can differ.
 */
export class ComposerSubmissionPolicy {
  /** Reactive preference source for the composer bar and the Settings row. */
  readonly busyEnter: SnapshotStore<BusyEnterBehavior> = createSnapshotStore(DEFAULT_BUSY_ENTER_BEHAVIOR)
  /** Reactive browser-local meaning of plain Enter. */
  readonly enterKey: SnapshotStore<EnterKeyBehavior> = createSnapshotStore<EnterKeyBehavior>(
    'send', { persist: { name: ENTER_KEY_STORAGE_KEY } },
  )
  private readonly unsubscribe: (() => void) | undefined
  private readonly host: ConfigForm<ConversationSettings> | undefined

  /**
   * @param host Shared configuration form; omitted keeps the browser-local default.
   */
  constructor(host?: ConfigForm<ConversationSettings>) {
    this.host = host
    const stored: string = this.enterKey.getSnapshot()
    if (stored !== 'send' && stored !== 'newline') this.enterKey.set('send')
    if (host !== undefined) {
      this.unsubscribe = host.subscribe(() => { this.adopt(host) })
      this.adopt(host)
    }
  }

  /** Release the preference subscription. */
  dispose(): void { this.unsubscribe?.() }

  /**
   * Change the busy-state submission behavior; the live value publishes
   * before the durable write starts.
   * @param behavior - Queue or Steer.
   */
  setBusyEnter(behavior: BusyEnterBehavior): void {
    if (this.busyEnter.getSnapshot() === behavior) return
    this.busyEnter.set(behavior)
    void this.host?.set(BUSY_ENTER_FIELD, behavior)
  }

  /**
   * Change what plain Enter does in this browser.
   * @param behavior - Send or New line.
   */
  setEnterKey(behavior: EnterKeyBehavior): void {
    if (this.enterKey.getSnapshot() === behavior) return
    this.enterKey.set(behavior)
  }

  /**
   * Adopt the scope's accepted durable behavior without writing it back.
   * @param host - the constructor-narrowed scope driving this adoption.
   */
  private adopt(host: ConfigForm<ConversationSettings>): void {
    const section = host.getSnapshot().value
    if (section === undefined || this.busyEnter.getSnapshot() === section.busyEnter) return
    this.busyEnter.set(section.busyEnter)
  }
}

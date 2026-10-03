/** Ordered Chat rows, local echoes, and running status share the flow slot's parent. */
import { memo, useCallback, useMemo, useState } from 'react'
import type {
  ConversationGroupedView, RenderEntry, RenderMessageImages,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ChatFlowSlotProps } from '../contract/slots.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { ChatGroupSeat } from './ChatGroupSeat.tsx'
import { CollapsedStepsRow } from './CollapsedStepsRow.tsx'
import { PendingSteeringBubble, PendingSubmissionBubble } from './MessageItem.tsx'
import { chatRenderKey } from './render-entry.ts'
import { RunningStatus } from './RunningStatus.tsx'
import { collapseSettledSteps, type ChatFlowRow } from './step-collapse.ts'
import css from './ChatView.module.css'

/** Replace each group reference with its member references, in order. */
function flattenGroups(
  entries: readonly RenderEntry[],
  grouped: ConversationGroupedView<unknown> | undefined,
): readonly RenderEntry[] {
  if (!entries.some(entry => entry.kind === 'group')) return entries
  return entries.flatMap(entry => entry.kind === 'group'
    ? grouped?.groupSource(entry.key).getSnapshot()?.members ?? []
    : [entry])
}

function sameEntries(left: readonly RenderEntry[], right: readonly RenderEntry[]): boolean {
  return left === right || (left.length === right.length && left.every((entry, index) => {
    const other = right[index] as RenderEntry
    return entry.kind === other.kind && entry.key === other.key
      && (entry.kind === 'group' || (other.kind === 'node' && entry.groupPart === other.groupPart))
  }))
}

/** Render the flow without adding a DOM parent or changing keyed row positions. */
export const ChatFlow = memo(function ChatFlow({
  entries, pendingInputs, lastInputTurn, deferCollapse, useConversation,
  useSession, useChat, useChatNode, useChatNodeBottom, useChatNodeProcess, useChatGroup, usePresentation,
  useStore, actions, renderSlot, t, useGroupAction, useGroupHeaderAction, expandTurn,
  cwd, openFile, openSkill, inspectCall, forkAt, loadImage, fileMentions,
}: ChatFlowSlotProps) {
  const nodeStore = useChat(snapshot => snapshot.nodes)
  // The Node store keeps its identity across publications, so the fold also depends on the order.
  const order = useChat(snapshot => snapshot.order)
  const timeline = useChat(snapshot => snapshot.timeline)
  const running = useSession(snapshot => snapshot.running)
  const stepDigests = useSession(snapshot => snapshot.stepDigests)
  const stepAccounts = useSession(snapshot => snapshot.stepAccounts)
  const expandingTurns = useSession(snapshot => snapshot.expandingTurns)
  const foldSettledSteps = usePresentation(policy => policy.foldSettledSteps)
  // Collapsed steps renders process groups flat, so the fold reads their members as rows.
  const foldEntries = useConversation(
    snapshot => foldSettledSteps ? flattenGroups(entries, snapshot.views.grouped('chat')) : entries,
    sameEntries,
  )
  // Reader-owned and deliberately not persisted: a fresh mount starts collapsed again.
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const toggleGroup = useCallback((group: string, turn: number, withheld: boolean) => {
    // The disclosure opens at once; the row reports loading until the withheld steps arrive.
    if (withheld) void expandTurn(turn)
    setExpandedGroups((current) => {
      const next = new Set(current)
      if (!next.delete(group)) next.add(group)
      return next
    })
  }, [expandTurn])
  const flow = useMemo<readonly ChatFlowRow[]>(
    () => foldSettledSteps
      ? collapseSettledSteps(foldEntries, nodeStore, expandedGroups, timeline, stepDigests, stepAccounts)
      : entries,
    [foldSettledSteps, entries, foldEntries, nodeStore, order, expandedGroups, timeline, stepDigests, stepAccounts],
  )
  const latestTurnAnchor = useChat(snapshot => snapshot.navigation.items().at(-1)?.anchorKey)
  const runningStartTime = useChatNode(latestTurnAnchor ?? '', (node) => {
    const location = node?.location
    return location?.kind === 'turn' || location?.kind === 'step'
      ? location.turn.status === 'open' ? location.turn.start?.time : undefined
      : undefined
  })
  const renderMessageImages = useCallback<RenderMessageImages>(
    owner => renderSlot('conversation.message.images', { ...owner, loadImage }),
    [loadImage, renderSlot],
  )
  const seatProps = {
    nodeStore, useChatNode, useChatNodeBottom, useChatNodeProcess, usePresentation,
    useStore, actions, renderSlot, t, useGroupAction, deferCollapse,
    cwd, openFile, openSkill, inspectCall, forkAt, loadImage, renderMessageImages, fileMentions,
  }
  const rows = flow.map((entry) => {
    switch (entry.kind) {
      case 'node':
        return <ChatNodeSeat {...seatProps} key={chatRenderKey(entry)} nodeKey={entry.key}
          {...entry.groupPart === undefined ? {} : { groupPart: entry.groupPart }} />
      case 'group':
        return <ChatGroupSeat {...seatProps} key={chatRenderKey(entry)} groupKey={entry.key}
          useChatGroup={useChatGroup} useGroupHeaderAction={useGroupHeaderAction} />
      case 'collapsed': {
        const key = `collapsed:${entry.key}`
        return (
          <div key={key} className={css.flowItem} data-chat-anchor-key={key} data-chat-flow-key={key}
            data-chat-flow-kind="collapsed-steps" data-chat-turn={entry.turn}>
            <CollapsedStepsRow
              turn={entry.turn}
              startStep={entry.startStep}
              keys={entry.keys}
              metrics={entry.metrics}
              expanded={expandedGroups.has(entry.key)}
              loading={expandedGroups.has(entry.key) && expandingTurns.has(entry.turn)}
              onToggle={() => { toggleGroup(entry.key, entry.turn, entry.withheld) }}
              renderSlot={renderSlot}
              t={t}
            />
          </div>
        )
      }
      default:
        return assertNever(entry)
    }
  })
  const pendingRows = pendingInputs.map(item => 'requestId' in item ? (
    <PendingSubmissionBubble key={item.requestId} submission={item}
      renderMessageImages={renderMessageImages} t={t} />
  ) : (
    <PendingSteeringBubble key={item.id} content={item.content}
      renderMessageImages={renderMessageImages} t={t} />
  ))
  const tail = entries.at(-1)
  const node = tail?.kind === 'node' ? nodeStore.get(tail.key) : undefined
  // An empty opening control follows one local transcript echo, never steering.
  // All rows share this keyed list so inserting the control keeps the echo mounted.
  if (node?.kind === 'turn-process' && node.location.kind === 'turn'
    && node.location.turn.status === 'open' && node.location.turn.turn !== lastInputTurn) {
    const index = pendingInputs.findIndex(item => 'requestId' in item && item.placement === 'transcript')
    if (index !== -1) rows.splice(rows.length - 1, 0, ...pendingRows.splice(index, 1))
  }
  return [...rows, ...pendingRows, ...running ? [<RunningStatus key="running" startTime={runningStartTime} t={t} />] : []]
})

// The latest turn, rendered in full: its prompting message, assistant prose,
// and every tool call including the one currently running.

import { memo, type ReactNode } from 'react'
import {
  MarkdownText, MessageText, TerminalBlock, type TerminalBlockProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContentBlock } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  AssistantBlock, ConversationNode, PartialAssistant, RunningToolCall, ToolCallBlock,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { FocusTranslate } from './TurnSummaryRow.tsx'
import css from './LatestTurn.module.css'

/** Props of the fully-rendered latest turn. */
export interface LatestTurnProps {
  /** Settled nodes belonging to the latest turn, ascending by seq. */
  nodes: readonly ConversationNode[]
  /** The streaming assistant step, when one is mid-flight. */
  partial: PartialAssistant | null
  /** Tool calls awaiting their result. */
  runningCalls: readonly RunningToolCall[]
  running: boolean
  t: FocusTranslate
}

/** Plain text of a user/steering message's content blocks. */
function messageText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function AssistantBlocks({ blocks, streaming }: {
  blocks: readonly AssistantBlock[]
  streaming: boolean
}): ReactNode {
  return blocks.map((block, index) => {
    if (block.kind === 'text') {
      return (
        <div key={index} className={css.assistant}>
          <MarkdownText text={block.text} streaming={streaming} />
        </div>
      )
    }
    if (block.kind === 'reasoning') {
      return <div key={index} className={css.reasoning}>{block.text}</div>
    }
    // Tool calls render from their own call/result rows, which carry the
    // lifecycle and the tool's render intent; the head block would duplicate them.
    return null
  })
}

/** Terminal-card fields when the tool declared that render intent. */
function terminalProps(call: ToolCallBlock): TerminalBlockProps | null {
  const view = call.callView
  if (view === null || view.card !== 'terminal') return null
  const result = 'kind' in call ? call.resultView : null
  const settled = result !== null && result.card === 'terminal' ? result : null
  return {
    command: view.title,
    ...view.cwd === undefined ? {} : { cwd: view.cwd },
    ...settled?.output === undefined ? {} : { output: settled.output },
    ...settled?.exitCode === undefined ? {} : { exitCode: settled.exitCode },
    ...settled?.signal === undefined ? {} : { signal: settled.signal },
    running: settled === null,
  }
}

/** Tool name of either lifecycle form; a settled root carries its head in `call`. */
function toolName(call: ToolCallBlock): string {
  return 'kind' in call ? call.call?.name ?? call.callId : call.name
}

/** Raw arguments of either lifecycle form; absent once window truncation drops the call head. */
function toolArgs(call: ToolCallBlock): string {
  return 'kind' in call ? call.call?.argsRaw ?? '' : call.argsRaw
}

/** The title a tool declared for this call, falling back to its name. */
function callTitle(call: ToolCallBlock): string {
  const settled = 'kind' in call ? call.resultView : null
  if (settled !== null && settled.title !== undefined && settled.title !== '') return settled.title
  const view = call.callView
  if (view !== null && view.title !== '') return view.title
  return toolName(call)
}

const CallRow = memo(function CallRow({ call, t }: { call: ToolCallBlock; t: FocusTranslate }) {
  const settled = 'kind' in call
  const terminal = terminalProps(call)
  return (
    <div className={css.call} data-focus-call={call.callId}>
      <div className={css.callHead}>
        <span className={css.callName}>{callTitle(call)}</span>
        {!settled && <span className={css.running}>{t('summary.running')}</span>}
        {settled && call.isError && <span className={css.callError}>{t('load.failed')}</span>}
      </div>
      {terminal !== null && <TerminalBlock {...terminal} />}
      {terminal === null && toolArgs(call) !== '' && <pre className={css.callArgs}>{toolArgs(call)}</pre>}
      {call.subCalls.length > 0 && (
        <div className={css.subCalls}>
          {call.subCalls.map(subCall => (
            <CallRow key={subCall.callId} call={subCall} t={t} />
          ))}
        </div>
      )}
    </div>
  )
})

/**
 * Render the latest turn in full, including a tool-call-only turn still in
 * flight, so the reader always sees the current work.
 * @param props - the latest turn's nodes and live streaming state.
 * @returns the rendered turn.
 */
export const LatestTurn = memo(function LatestTurn({
  nodes, partial, runningCalls, running, t,
}: LatestTurnProps) {
  const rows: ReactNode[] = []
  for (const node of nodes) {
    if (node.kind === 'user' || node.kind === 'steering') {
      rows.push(
        <div key={node.seq} className={css.user}>
          <MessageText text={messageText(node.content)} />
        </div>,
      )
      continue
    }
    if (node.kind === 'assistant') {
      rows.push(
        <AssistantBlocks key={node.seq} blocks={node.blocks} streaming={false} />,
      )
      continue
    }
    if (node.kind === 'tool-result') {
      rows.push(<CallRow key={node.callId} call={node} t={t} />)
    }
  }
  if (partial !== null) {
    rows.push(<AssistantBlocks key="partial" blocks={partial.blocks} streaming />)
  }
  for (const call of runningCalls) {
    rows.push(<CallRow key={call.callId} call={call} t={t} />)
  }
  return (
    <div className={css.root} data-focus-latest="">
      <div className={css.heading}>
        <span>{t('summary.latestHeading')}</span>
        {running && <span className={css.running}>{t('summary.running')}</span>}
      </div>
      {rows.length === 0 ? <div className={css.empty}>{t('none')}</div> : rows}
    </div>
  )
})

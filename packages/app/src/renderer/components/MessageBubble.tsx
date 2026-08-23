import { memo } from 'react'
import type { Message } from '@spool-lab/core'
import MarkdownContent from './MarkdownContent.js'
import ToolCallList from './session/ToolCallList.js'
import ThinkingBlock from './session/ThinkingBlock.js'
import type { Range as FindRange } from '../markdown/findHighlightPlugin.js'

export type { FindRange }

interface Props {
  message: Message
  isDark: boolean
  showAvatar?: boolean
  findRanges?: ReadonlyArray<FindRange>
  matchIndexOffset?: number
  activeMatchIndex?: number
  onActiveMatchRef?: ((node: HTMLElement | null) => void) | undefined
}

/** Name-only chips for rows with no structured detail — sessions
 *  indexed before the schema captured tool payloads, and providers
 *  that record nothing beyond a name. */
function ToolNameChips({ names }: { names: string[] }) {
  return (
    <div className="flex flex-wrap gap-1 mb-1">
      {names.map((name) => (
        <span key={name} className="text-[10px] font-mono bg-neutral-100 dark:bg-neutral-800 text-neutral-500 px-1.5 py-0.5 rounded">
          {name}
        </span>
      ))}
    </div>
  )
}

function MessageBubble({
  message,
  isDark,
  showAvatar = true,
  findRanges = [],
  matchIndexOffset = 0,
  activeMatchIndex = -1,
  onActiveMatchRef,
}: Props) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const toolCalls = message.toolCalls ?? []
  const thinking = message.thinking ?? ''
  // Detail rows replace the bare chips only when there is something to
  // reveal; otherwise the chips remain the honest rendering.
  const hasToolDetail = toolCalls.length > 0
  const isToolUseOnly =
    message.toolNames.length > 0 && !message.contentText && !thinking && !hasToolDetail
  const contentText = message.contentText || (isSystem ? '(summary)' : '')

  const markdownProps = {
    text: contentText,
    isDark,
    findRanges,
    matchIndexOffset,
    activeMatchIndex,
    ...(onActiveMatchRef ? { onActiveMatchRef } : {}),
  }

  if (isSystem) {
    return (
      <div className="px-6 py-2">
        <div className="bg-neutral-100 dark:bg-neutral-800/60 rounded px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400 italic">
          <MarkdownContent {...markdownProps} />
        </div>
      </div>
    )
  }

  if (isToolUseOnly) {
    return (
      <div className="px-6 py-0.5 flex items-center gap-2">
        {showAvatar ? (
          <div className="flex-none w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold bg-neutral-700 text-white dark:bg-neutral-300 dark:text-neutral-900">
            A
          </div>
        ) : (
          <div className="flex-none w-5 h-5" aria-hidden />
        )}
        <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] text-neutral-400">
          {message.toolNames.map((name) => (
            <span key={name} className="font-mono bg-neutral-100 dark:bg-neutral-800 text-neutral-500 px-1.5 py-0.5 rounded">
              {name}
            </span>
          ))}
          <span className="font-mono">{formatTime(message.timestamp)}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="px-6 py-2">
      <div className="flex items-start gap-2">
        {showAvatar ? (
          <div className={`flex-none w-5 h-5 rounded-full mt-0.5 flex items-center justify-center text-[9px] font-bold ${
            isUser
              ? 'bg-blue-500 text-white'
              : 'bg-neutral-700 text-white dark:bg-neutral-300 dark:text-neutral-900'
          }`}>
            {isUser ? 'U' : 'A'}
          </div>
        ) : (
          <div className="flex-none w-5 h-5 mt-0.5" aria-hidden />
        )}
        <div className="flex-1 min-w-0">
          {/* Reasoning precedes the reply it produced, and the tool
              rows follow it, so the row order matches the order the
              turn actually happened in. */}
          {thinking && <ThinkingBlock text={thinking} />}
          {hasToolDetail
            ? <ToolCallList calls={toolCalls} />
            : message.toolNames.length > 0 && <ToolNameChips names={message.toolNames} />}
          {contentText && <MarkdownContent {...markdownProps} />}
          <p className="text-[10px] text-neutral-400 mt-1">{formatTime(message.timestamp)}</p>
        </div>
      </div>
    </div>
  )
}

function formatTime(iso: string): string {
  try {
    // Respect the app's UI language (set on <html lang>) instead of
    // inheriting the OS region setting — otherwise an English macOS
    // produces "10:35:02 PM" even when the app is in Chinese.
    const locale = typeof document !== 'undefined' && document.documentElement.lang
      ? document.documentElement.lang
      : undefined
    return new Date(iso).toLocaleTimeString(locale)
  } catch { return '' }
}

export default memo(MessageBubble)

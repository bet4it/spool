import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ToolCall } from '@spool-lab/core'
import { toolCallSummary, toolDisplayName, parseMcpToolName } from './toolSummary.js'
import { ToolDetail } from './ToolDetail.js'

interface Props {
  calls: ToolCall[]
}

/**
 * Collapsed-by-default disclosures for a turn's tool invocations.
 *
 * Transcripts are read for the conversation, not the mechanics, so a
 * tool row stays a single line until asked: name, a one-line summary
 * of what it acted on, and a failure marker. Expanding reveals the
 * input and result payloads.
 *
 * Each row owns its expansion state rather than lifting it into the
 * virtualised list. Row height changing on expand is already handled
 * by Virtuoso's resize observer, and keeping the state local means
 * scrolling a long transcript doesn't rebuild a shared Set on every
 * toggle.
 */
function ToolCallList({ calls }: Props) {
  if (calls.length === 0) return null
  return (
    <div className="mt-1 flex flex-col gap-1">
      {calls.map((call, index) => (
        <ToolCallRow key={`${call.id ?? call.name}-${index}`} call={call} />
      ))}
    </div>
  )
}

function ToolCallRow({ call }: { call: ToolCall }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const summary = toolCallSummary(call)
  const mcp = parseMcpToolName(call.name)
  // Sessions indexed before v16 carry a name and nothing else; there
  // is no detail to reveal, so the row renders as a static chip
  // instead of an affordance that opens onto an empty panel.
  const hasDetail = Boolean(call.input || call.result)

  const header = (
    <>
      <span
        className={`flex-none font-mono text-[10px] ${
          call.isError
            ? 'text-[color:var(--color-status-error)] dark:text-[color:var(--color-status-error-dark)]'
            : 'text-accent dark:text-accent-dark'
        }`}
        aria-hidden
      >
        {call.isError ? '!' : '>'}
      </span>
      <span className="flex-none font-mono text-[11px] font-medium text-warm-text dark:text-dark-text">
        {toolDisplayName(call.name)}
      </span>
      {mcp && (
        <span className="flex-none font-mono text-[10px] text-warm-faint dark:text-dark-muted">
          {mcp.server}
        </span>
      )}
      {summary && (
        <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-warm-muted dark:text-dark-muted">
          {summary}
        </span>
      )}
      {call.isError && (
        <span className="flex-none text-[10px] text-[color:var(--color-status-error)] dark:text-[color:var(--color-status-error-dark)]">
          {t('session.toolFailed')}
        </span>
      )}
    </>
  )

  if (!hasDetail) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-warm-border dark:border-dark-border bg-warm-surface/60 dark:bg-dark-surface/60 px-2.5 py-1.5">
        {header}
      </div>
    )
  }

  return (
    <div className="rounded-md border border-warm-border dark:border-dark-border bg-warm-surface/60 dark:bg-dark-surface/60">
      <button
        type="button"
        data-testid="tool-call-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="w-full min-w-0 flex items-center gap-2 px-2.5 py-1.5 text-left rounded-md hover:bg-warm-surface2 dark:hover:bg-dark-surface2 transition-colors"
      >
        {header}
        {expanded ? (
          <ChevronDown size={12} strokeWidth={1.8} className="flex-none text-warm-faint dark:text-dark-muted" aria-hidden />
        ) : (
          <ChevronRight size={12} strokeWidth={1.8} className="flex-none text-warm-faint dark:text-dark-muted" aria-hidden />
        )}
      </button>

      {expanded && (
        <div className="px-2.5 pb-2">
          <ToolDetail call={call} />
        </div>
      )}
    </div>
  )
}

export default memo(ToolCallList)

import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface Props {
  text: string
}

/**
 * Collapsed disclosure for a turn's reasoning.
 *
 * Same defaults as the tool rows: hidden until asked, with a one-line
 * preview so the row still carries a hint of what the model was
 * weighing. Models pepper reasoning with markdown emphasis, which
 * reads as noise in a single-line preview, so the markers are
 * stripped there while the expanded body stays verbatim.
 */
function ThinkingBlock({ text }: Props) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const preview = (text.split('\n', 1)[0] ?? '').replaceAll('**', '').trim()

  return (
    <div className="mt-1 rounded-md border border-warm-border dark:border-dark-border bg-warm-surface/60 dark:bg-dark-surface/60">
      <button
        type="button"
        data-testid="thinking-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="w-full min-w-0 flex items-center gap-2 px-2.5 py-1.5 text-left rounded-md hover:bg-warm-surface2 dark:hover:bg-dark-surface2 transition-colors"
      >
        <span className="flex-none font-mono text-[10px] text-accent dark:text-accent-dark" aria-hidden>
          *
        </span>
        <span className="flex-none text-[11px] font-medium text-warm-muted dark:text-dark-muted">
          {t('session.thinking')}
        </span>
        {!expanded && preview && (
          <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-warm-faint dark:text-dark-muted">
            {preview}
          </span>
        )}
        {expanded ? (
          <ChevronDown size={12} strokeWidth={1.8} className="flex-none ml-auto text-warm-faint dark:text-dark-muted" aria-hidden />
        ) : (
          <ChevronRight size={12} strokeWidth={1.8} className="flex-none ml-auto text-warm-faint dark:text-dark-muted" aria-hidden />
        )}
      </button>

      {expanded && (
        <pre className="mx-2.5 mb-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-warm-surface2 dark:bg-dark-surface2 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-warm-muted dark:text-dark-muted">
          {text}
        </pre>
      )}
    </div>
  )
}

export default memo(ThinkingBlock)

import { type CSSProperties, useState } from 'react'
import type { Message } from '@spool-lab/core'

export const MIN_TURNS_TO_SHOW = 2

export const MOUNTAIN = [
  { width: 24, className: 'timeline-minimap-tick-peak' },
  { width: 18, className: 'timeline-minimap-tick-near' },
  { width: 12, className: 'timeline-minimap-tick-mid' },
  { width: 8, className: 'timeline-minimap-tick-far' },
] as const
export const BASE_WIDTH = 5
export const MAX_TICK_WIDTH = MOUNTAIN[0].width

export interface MountainTick {
  readonly width: number
  readonly className: string
}

export interface SessionTurnOutlineEntry {
  ordinal: number
  messageId: number
  rowIndex: number
  userText: string
  replyText: string
}

export interface TimelineMinimapProps {
  outline: SessionTurnOutlineEntry[]
  activeIndex: number
  scrolling: boolean
  onWheelScroll: (deltaY: number) => void
  onRevealMessage: (messageId: number, turnIndex: number) => void
}

export function getTopVisibleRowIndex(scroller: HTMLElement): number | null {
  if (scroller.scrollTop <= 2) return 0
  const isBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 6
  if (isBottom) return Number.POSITIVE_INFINITY

  const scrollerRect = scroller.getBoundingClientRect()
  if (scrollerRect.height <= 0) return null

  // 1. Hit-test down from the top edge if elementFromPoint is available
  if (typeof document !== 'undefined' && typeof document.elementFromPoint === 'function') {
    for (const dy of [12, 28, 52, 90]) {
      const hit = document.elementFromPoint(scrollerRect.left + 50, scrollerRect.top + dy)
      const row = hit instanceof Element ? hit.closest('[data-index]') : null
      if (row) {
        const raw = row.getAttribute('data-index')
        if (raw !== null) {
          const idx = Number.parseInt(raw, 10)
          if (!Number.isNaN(idx)) return idx
        }
      }
    }
  }

  // 2. Fallback: inspect rendered rows inside the virtualized scroller
  const rows = scroller.querySelectorAll('[data-index]')
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row || typeof (row as Element).getBoundingClientRect !== 'function') continue
    const rect = (row as Element).getBoundingClientRect()
    // A row is considered visible at the top if its bottom edge extends past the top threshold
    if (rect.bottom > scrollerRect.top + 6) {
      const raw = (row as Element).getAttribute('data-index')
      if (raw !== null) {
        const idx = Number.parseInt(raw, 10)
        if (!Number.isNaN(idx)) return idx
      }
    }
  }

  return null
}

export function collapseOutlinePreview(content: string, maxChars = 240): string {
  if (!content) return ''
  return content
    .slice(0, maxChars * 4)
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, maxChars)
}

export function buildTurnOutline(
  messages: Message[],
  idToRowIndex: Map<number, number>,
): SessionTurnOutlineEntry[] {
  const turns: SessionTurnOutlineEntry[] = []
  let ordinal = 0
  for (const message of messages) {
    if (message.isSidechain) continue

    if (message.role === 'user') {
      const userText = collapseOutlinePreview(message.contentText)
      if (!userText) continue
      const rowIndex = idToRowIndex.get(message.id) ?? -1
      turns.push({
        ordinal,
        messageId: message.id,
        rowIndex,
        userText,
        replyText: '',
      })
      ordinal++
    } else if (message.role === 'assistant') {
      const last = turns[turns.length - 1]
      if (last && !last.replyText) {
        const replyText = collapseOutlinePreview(message.contentText)
        if (replyText) {
          last.replyText = replyText
        }
      }
    }
  }
  return turns
}

export function activeTurnIndex(
  outline: SessionTurnOutlineEntry[],
  startIndex: number,
  lastRowVisible: boolean,
): number {
  if (outline.length === 0) return 0
  if (lastRowVisible) return outline.length - 1
  let current = 0
  for (let i = 0; i < outline.length; i++) {
    const turn = outline[i]
    if (!turn) break
    if (turn.rowIndex <= startIndex) {
      current = i
    } else {
      break
    }
  }
  return current
}

export function computeTickWidth(
  index: number,
  activeIndex: number,
  hoveredIndex: number | null,
  scrolling: boolean,
): number {
  const hoverDistance = hoveredIndex === null ? Number.POSITIVE_INFINITY : Math.abs(index - hoveredIndex)
  const scrollDistance = scrolling ? Math.abs(index - activeIndex) : Number.POSITIVE_INFINITY
  const minDistance = Math.min(hoverDistance, scrollDistance)
  const mountain: MountainTick | undefined = (MOUNTAIN as readonly MountainTick[])[minDistance]
  if (mountain) {
    return mountain.width
  }
  if (index === activeIndex) {
    return 10
  }
  return BASE_WIDTH
}

export function computeTickClass(
  index: number,
  activeIndex: number,
  hoveredIndex: number | null,
  scrolling: boolean,
): string {
  if (index === activeIndex) return 'timeline-minimap-tick-active'

  const hoverDistance = hoveredIndex === null ? Number.POSITIVE_INFINITY : Math.abs(index - hoveredIndex)
  const scrollDistance = scrolling ? Math.abs(index - activeIndex) : Number.POSITIVE_INFINITY
  const minDistance = Math.min(hoverDistance, scrollDistance)
  const mountain: MountainTick | undefined = (MOUNTAIN as readonly MountainTick[])[minDistance]
  return mountain?.className ?? 'timeline-minimap-tick-base'
}

export function computeCardPositionClass(index: number, count: number): string {
  if (count <= 1) return 'timeline-minimap-card-middle'
  if (index < count / 3) return 'timeline-minimap-card-top'
  if (index >= (count * 2) / 3) return 'timeline-minimap-card-bottom'
  return 'timeline-minimap-card-middle'
}

export function TimelineMinimap({
  outline,
  activeIndex,
  scrolling,
  onWheelScroll,
  onRevealMessage,
}: TimelineMinimapProps) {
  const turns = outline
  const [hovered, setHovered] = useState<number | null>(null)

  if (turns.length < MIN_TURNS_TO_SHOW) {
    return null
  }

  function revealTurn(index: number): void {
    const turn = turns[index]
    if (!turn) return
    setHovered(null)
    onRevealMessage(turn.messageId, index)
  }

  return (
    <div
      className="timeline-minimap"
      data-testid="timeline-minimap"
      aria-label="Timeline navigation"
    >
      <div
        className="timeline-minimap-strip"
        onWheel={(event) => {
          onWheelScroll(event.deltaY)
        }}
      >
        {turns.map((turn, index) => {
          const width = computeTickWidth(index, activeIndex, hovered, scrolling)
          const scale = width / MAX_TICK_WIDTH
          const tickClassName = computeTickClass(index, activeIndex, hovered, scrolling)
          const cardPosition = computeCardPositionClass(index, turns.length)

          return (
            <div
              key={turn.messageId}
              className="timeline-minimap-row"
              data-testid="timeline-minimap-row"
              data-ordinal={turn.ordinal}
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(null)}
            >
              <button
                type="button"
                aria-label={turn.userText || `#${turn.ordinal + 1}`}
                className="timeline-minimap-button focus:outline-none focus-visible:outline-none"
                onClick={() => revealTurn(index)}
              >
                <span
                  className={`timeline-minimap-tick ${tickClassName}`}
                  style={{ '--tick-scale': scale, transform: `scaleX(${scale})` } as CSSProperties}
                />
              </button>
              {hovered === index && (
                <button
                  type="button"
                  data-testid="timeline-minimap-card"
                  className={`timeline-minimap-card ${cardPosition} focus:outline-none focus-visible:outline-none`}
                  onClick={() => revealTurn(index)}
                >
                  <div className="flex items-center gap-1.5 text-[10px] font-mono text-warm-faint dark:text-dark-muted mb-1">
                    <span>#{turn.ordinal + 1}</span>
                  </div>
                  <span className="timeline-minimap-card-title">
                    {turn.userText || '…'}
                  </span>
                  {turn.replyText && (
                    <span className="timeline-minimap-card-reply">
                      {turn.replyText}
                    </span>
                  )}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

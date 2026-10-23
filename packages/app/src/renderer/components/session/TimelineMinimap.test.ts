import { describe, it, expect } from 'vitest'
import type { Message } from '@spool-lab/core'
import {
  collapseOutlinePreview,
  buildTurnOutline,
  activeTurnIndex,
  getTopVisibleRowIndex,
  computeTickWidth,
  computeTickClass,
  computeCardPositionClass,
  type SessionTurnOutlineEntry,
  MOUNTAIN,
  BASE_WIDTH,
} from '../TimelineMinimap.js'

function makeMessage(partial: Partial<Message> & { id: number; role: Message['role'] }): Message {
  return {
    id: partial.id,
    sessionId: partial.sessionId ?? 1,
    role: partial.role,
    contentText: partial.contentText ?? '',
    timestamp: partial.timestamp ?? '2026-08-23T10:00:00Z',
    isSidechain: partial.isSidechain ?? false,
    toolNames: partial.toolNames ?? [],
    toolCalls: partial.toolCalls ?? [],
    thinking: partial.thinking ?? null,
  }
}

describe('collapseOutlinePreview', () => {
  it('collapses multiple whitespace characters and newlines into single spaces', () => {
    const raw = '  How do I   fix this bug\n\nin the   auth module?  '
    expect(collapseOutlinePreview(raw)).toBe('How do I fix this bug in the auth module?')
  })

  it('truncates content longer than maxChars', () => {
    const raw = 'a'.repeat(300)
    expect(collapseOutlinePreview(raw, 240)).toHaveLength(240)
  })

  it('handles empty and whitespace-only text gracefully', () => {
    expect(collapseOutlinePreview('')).toBe('')
    expect(collapseOutlinePreview('   \n\t  ')).toBe('')
  })
})

describe('buildTurnOutline', () => {
  it('builds turn outline associating user questions with assistant replies', () => {
    const messages: Message[] = [
      makeMessage({ id: 1, role: 'user', contentText: 'What is the speed of light?' }),
      makeMessage({ id: 2, role: 'assistant', contentText: 'The speed of light is approximately 299,792 km/s.' }),
      makeMessage({ id: 3, role: 'user', contentText: 'And what is the speed of sound?' }),
      makeMessage({ id: 4, role: 'assistant', contentText: 'The speed of sound in dry air at 20°C is 343 m/s.' }),
    ]
    const idToRowIndex = new Map<number, number>([
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 3],
    ])

    const outline = buildTurnOutline(messages, idToRowIndex)
    expect(outline).toHaveLength(2)

    expect(outline[0]).toEqual({
      ordinal: 0,
      messageId: 1,
      rowIndex: 0,
      userText: 'What is the speed of light?',
      replyText: 'The speed of light is approximately 299,792 km/s.',
    })

    expect(outline[1]).toEqual({
      ordinal: 1,
      messageId: 3,
      rowIndex: 2,
      userText: 'And what is the speed of sound?',
      replyText: 'The speed of sound in dry air at 20°C is 343 m/s.',
    })
  })

  it('ignores sidechain messages and empty user messages', () => {
    const messages: Message[] = [
      makeMessage({ id: 1, role: 'user', contentText: '   ' }), // empty question
      makeMessage({ id: 2, role: 'user', isSidechain: true, contentText: 'Subagent prompt' }), // sidechain
      makeMessage({ id: 3, role: 'user', contentText: 'Valid main question' }),
      makeMessage({ id: 4, role: 'assistant', contentText: 'Valid answer' }),
    ]
    const idToRowIndex = new Map([[3, 5], [4, 6]])

    const outline = buildTurnOutline(messages, idToRowIndex)
    expect(outline).toHaveLength(1)
    expect(outline[0]?.messageId).toBe(3)
    expect(outline[0]?.rowIndex).toBe(5)
  })

  it('picks the first non-empty assistant message in multi-step turns (e.g. tool calls followed by answer)', () => {
    const messages: Message[] = [
      makeMessage({ id: 1, role: 'user', contentText: 'Run tests' }),
      makeMessage({ id: 2, role: 'assistant', contentText: '' }), // tool-call step
      makeMessage({ id: 3, role: 'assistant', contentText: 'All 15 tests passed.' }), // final step
      makeMessage({ id: 4, role: 'assistant', contentText: 'Extra summary.' }), // extra step (replyText already captured)
    ]
    const idToRowIndex = new Map([[1, 0]])

    const outline = buildTurnOutline(messages, idToRowIndex)
    expect(outline[0]?.replyText).toBe('All 15 tests passed.')
  })
})

describe('activeTurnIndex', () => {
  const sampleOutline: SessionTurnOutlineEntry[] = [
    { ordinal: 0, messageId: 1, rowIndex: 1, userText: 'Turn 0', replyText: '' },
    { ordinal: 1, messageId: 3, rowIndex: 10, userText: 'Turn 1', replyText: '' },
    { ordinal: 2, messageId: 5, rowIndex: 25, userText: 'Turn 2', replyText: '' },
  ]

  it('returns 0 for empty outline', () => {
    expect(activeTurnIndex([], 5, false)).toBe(0)
  })

  it('returns the last turn index when lastRowVisible is true', () => {
    expect(activeTurnIndex(sampleOutline, 2, true)).toBe(2)
  })

  it('selects the latest turn whose rowIndex <= startIndex', () => {
    // Before or at turn 0
    expect(activeTurnIndex(sampleOutline, 0, false)).toBe(0)
    expect(activeTurnIndex(sampleOutline, 1, false)).toBe(0)
    expect(activeTurnIndex(sampleOutline, 5, false)).toBe(0)

    // At or between turn 1 and turn 2
    expect(activeTurnIndex(sampleOutline, 10, false)).toBe(1)
    expect(activeTurnIndex(sampleOutline, 18, false)).toBe(1)

    // At or past turn 2
    expect(activeTurnIndex(sampleOutline, 25, false)).toBe(2)
    expect(activeTurnIndex(sampleOutline, 40, false)).toBe(2)
  })
})

describe('computeTickWidth and computeTickClass', () => {
  it('gives resting active tick a 10px width and active class', () => {
    expect(computeTickWidth(2, 2, null, false)).toBe(10)
    expect(computeTickClass(2, 2, null, false)).toBe('timeline-minimap-tick-active')
  })

  it('gives resting non-active ticks base width and base class', () => {
    expect(computeTickWidth(0, 2, null, false)).toBe(BASE_WIDTH)
    expect(computeTickClass(0, 2, null, false)).toBe('timeline-minimap-tick-base')
  })

  it('expands mountain wave around hovered index', () => {
    const hovered = 3
    expect(computeTickWidth(3, 0, hovered, false)).toBe(MOUNTAIN[0].width) // 24 (peak)
    expect(computeTickWidth(2, 0, hovered, false)).toBe(MOUNTAIN[1].width) // 18 (near)
    expect(computeTickWidth(4, 0, hovered, false)).toBe(MOUNTAIN[1].width) // 18 (near)
    expect(computeTickWidth(1, 0, hovered, false)).toBe(MOUNTAIN[2].width) // 12 (mid)
    expect(computeTickWidth(0, 0, hovered, false)).toBe(MOUNTAIN[3].width) // 8 (far)
    expect(computeTickClass(3, 0, hovered, false)).toBe('timeline-minimap-tick-peak')
  })

  it('expands wave around active index while scrolling', () => {
    const active = 2
    expect(computeTickWidth(2, active, null, true)).toBe(MOUNTAIN[0].width)
    expect(computeTickWidth(1, active, null, true)).toBe(MOUNTAIN[1].width)
    expect(computeTickClass(2, active, null, true)).toBe('timeline-minimap-tick-active')
  })
})

describe('computeCardPositionClass', () => {
  it('returns top alignment for turns in the upper third', () => {
    expect(computeCardPositionClass(0, 6)).toBe('timeline-minimap-card-top')
    expect(computeCardPositionClass(1, 6)).toBe('timeline-minimap-card-top')
  })

  it('returns middle alignment for turns in the middle third', () => {
    expect(computeCardPositionClass(2, 6)).toBe('timeline-minimap-card-middle')
    expect(computeCardPositionClass(3, 6)).toBe('timeline-minimap-card-middle')
  })

  it('returns bottom alignment for turns in the bottom third', () => {
    expect(computeCardPositionClass(4, 6)).toBe('timeline-minimap-card-bottom')
    expect(computeCardPositionClass(5, 6)).toBe('timeline-minimap-card-bottom')
  })
})

describe('getTopVisibleRowIndex', () => {
  it('returns 0 when scroller is at top (scrollTop <= 2)', () => {
    const scroller = {
      scrollTop: 0,
      clientHeight: 500,
      scrollHeight: 2000,
      getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 300, width: 300, height: 500 }),
      querySelectorAll: () => [],
    } as unknown as HTMLElement

    expect(getTopVisibleRowIndex(scroller)).toBe(0)
  })

  it('returns Infinity when scroller is at the very bottom', () => {
    const scroller = {
      scrollTop: 1500,
      clientHeight: 500,
      scrollHeight: 2000,
      getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 300, width: 300, height: 500 }),
      querySelectorAll: () => [],
    } as unknown as HTMLElement

    expect(getTopVisibleRowIndex(scroller)).toBe(Number.POSITIVE_INFINITY)
  })

  it('samples top visible row accurately from rendered elements when elementFromPoint is unavailable', () => {
    const makeRow = (index: number, top: number, bottom: number) => ({
      getAttribute: (name: string) => (name === 'data-index' ? String(index) : null),
      getBoundingClientRect: () => ({
        top,
        bottom,
        left: 0,
        right: 300,
        width: 300,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => {},
      }),
    })

    // Row 2 is above viewport (rect.bottom <= 106)
    // Row 3 is at the top of the viewport (rect.top = 100, rect.bottom = 180 > 106)
    // Row 4 is below row 3
    const row2 = makeRow(2, 20, 100)
    const row3 = makeRow(3, 100, 180)
    const row4 = makeRow(4, 180, 260)

    const scroller = {
      scrollTop: 300,
      clientHeight: 400,
      scrollHeight: 2000,
      getBoundingClientRect: () => ({
        top: 100,
        bottom: 500,
        left: 0,
        right: 300,
        width: 300,
        height: 400,
        x: 0,
        y: 100,
        toJSON: () => {},
      }),
      querySelectorAll: () => [row2, row3, row4],
    } as unknown as HTMLElement

    expect(getTopVisibleRowIndex(scroller)).toBe(3)
  })

  it('returns null if scroller has zero height or no visible rows', () => {
    const scroller = {
      scrollTop: 100,
      clientHeight: 0,
      scrollHeight: 2000,
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
      querySelectorAll: () => [],
    } as unknown as HTMLElement

    expect(getTopVisibleRowIndex(scroller)).toBeNull()
  })
})

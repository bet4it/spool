import { describe, it, expect, beforeEach } from 'vitest'
import type { Message } from '@spool-lab/core'

const SHOW_THINKING_STORAGE_KEY = 'spool:show-thinking-and-tools'

function getInitialShowThinking(): boolean {
  try {
    const stored = window.localStorage.getItem(SHOW_THINKING_STORAGE_KEY)
    if (stored !== null) {
      return stored === 'true'
    }
  } catch {
    // ignore
  }
  return true
}

function filterVisibleMessages(messages: Message[], showThinkingAndTools: boolean): Message[] {
  if (showThinkingAndTools) return messages
  return messages.filter((m) => {
    if (m.contentText.trim().length > 0) return true
    if (m.role === 'system') return true
    if (m.isSidechain) return true
    return false
  })
}

describe('thinking and tool calls visibility filter', () => {
  const userMsg: Message = {
    id: 1,
    sessionId: 10,
    role: 'user',
    contentText: 'Can you run the tests?',
    timestamp: '2026-08-23T10:00:00Z',
    isSidechain: false,
    toolNames: [],
    toolCalls: [],
    thinking: null,
  }

  const toolOnlyAssistantMsg: Message = {
    id: 2,
    sessionId: 10,
    role: 'assistant',
    contentText: '',
    timestamp: '2026-08-23T10:00:05Z',
    isSidechain: false,
    toolNames: ['Bash'],
    toolCalls: [{ name: 'Bash', id: 'c1', input: '{"cmd":"pnpm test"}', isError: false }],
    thinking: 'The user wants to run tests, so I will execute Bash.',
  }

  const textAndToolAssistantMsg: Message = {
    id: 3,
    sessionId: 10,
    role: 'assistant',
    contentText: 'All tests passed successfully!',
    timestamp: '2026-08-23T10:00:10Z',
    isSidechain: false,
    toolNames: ['Bash'],
    toolCalls: [{ name: 'Bash', id: 'c2', input: '{"cmd":"pnpm test"}', isError: false }],
    thinking: 'Reviewing the results.',
  }

  const systemMsg: Message = {
    id: 4,
    sessionId: 10,
    role: 'system',
    contentText: 'Session started',
    timestamp: '2026-08-23T09:59:00Z',
    isSidechain: false,
    toolNames: [],
    toolCalls: [],
    thinking: null,
  }

  const messages = [systemMsg, userMsg, toolOnlyAssistantMsg, textAndToolAssistantMsg]

  it('keeps all messages when showThinkingAndTools is true', () => {
    const visible = filterVisibleMessages(messages, true)
    expect(visible).toHaveLength(4)
    expect(visible.map((m) => m.id)).toEqual([4, 1, 2, 3])
  })

  it('filters out messages that only contain tool calls or thinking when showThinkingAndTools is false', () => {
    const visible = filterVisibleMessages(messages, false)
    expect(visible).toHaveLength(3)
    expect(visible.map((m) => m.id)).toEqual([4, 1, 3])
    expect(visible.find((m) => m.id === 2)).toBeUndefined()
  })

  it('keeps sidechain messages even when showThinkingAndTools is false', () => {
    const sidechainMsg: Message = {
      id: 5,
      sessionId: 10,
      role: 'assistant',
      contentText: '',
      timestamp: '2026-08-23T10:00:07Z',
      isSidechain: true,
      toolNames: [],
      toolCalls: [],
      thinking: null,
    }
    const visible = filterVisibleMessages([sidechainMsg], false)
    expect(visible).toHaveLength(1)
  })
})

describe('getInitialShowThinking localStorage persistence', () => {
  const store = new Map<string, string>()
  const mockLocalStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    clear: () => { store.clear() },
  }

  beforeEach(() => {
    store.clear()
    // @ts-expect-error mock window
    globalThis.window = { localStorage: mockLocalStorage }
  })

  it('defaults to true when nothing is stored', () => {
    expect(getInitialShowThinking()).toBe(true)
  })

  it('reads false when stored as "false"', () => {
    window.localStorage.setItem(SHOW_THINKING_STORAGE_KEY, 'false')
    expect(getInitialShowThinking()).toBe(false)
  })

  it('reads true when stored as "true"', () => {
    window.localStorage.setItem(SHOW_THINKING_STORAGE_KEY, 'true')
    expect(getInitialShowThinking()).toBe(true)
  })

  it('falls back to true when window is undefined', () => {
    // @ts-expect-error remove window
    delete globalThis.window
    expect(getInitialShowThinking()).toBe(true)
  })
})

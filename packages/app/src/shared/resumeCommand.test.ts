import { describe, expect, it } from 'vitest'
import { getSessionResumeCommand, getSessionResumeCommandPrefix } from './resumeCommand.js'

describe('getSessionResumeCommandPrefix', () => {
  it('returns the configured CLI prefix for resumable session sources', () => {
    expect(getSessionResumeCommandPrefix('claude')).toBe('claude --dangerously-skip-permissions --resume')
    expect(getSessionResumeCommandPrefix('codex')).toBe('codex --dangerously-bypass-approvals-and-sandbox resume')
    expect(getSessionResumeCommandPrefix('gemini')).toBe('gemini --yolo --resume')
    expect(getSessionResumeCommandPrefix('antigravity')).toBe('agy --dangerously-skip-permissions --conversation')
    expect(getSessionResumeCommandPrefix('opencode')).toBe('opencode --auto --session')
    expect(getSessionResumeCommandPrefix('grok')).toBe('grok --permission-mode bypassPermissions --resume')
  })

  it('returns null for unsupported sources', () => {
    expect(getSessionResumeCommandPrefix('unknown-cli')).toBeNull()
  })
})

describe('getSessionResumeCommand', () => {
  it('builds the full shell command with a quoted session id', () => {
    expect(getSessionResumeCommand('claude', 'test-session-uuid')).toBe("claude --dangerously-skip-permissions --resume 'test-session-uuid'")
    expect(getSessionResumeCommand('codex', '11111111-2222-4333-8444-555555555555')).toBe("codex --dangerously-bypass-approvals-and-sandbox resume '11111111-2222-4333-8444-555555555555'")
    expect(getSessionResumeCommand('gemini', '99999999-2222-4333-8444-555555555555')).toBe("gemini --yolo --resume '99999999-2222-4333-8444-555555555555'")
    expect(getSessionResumeCommand('antigravity', 'conv-uuid-123')).toBe("agy --dangerously-skip-permissions --conversation 'conv-uuid-123'")
    expect(getSessionResumeCommand('opencode', 'open-sess-456')).toBe("opencode --auto --session 'open-sess-456'")
    expect(getSessionResumeCommand('grok', 'aabbccdd-eeff-4455-8899-001122334455')).toBe("grok --permission-mode bypassPermissions --resume 'aabbccdd-eeff-4455-8899-001122334455'")
  })

  it('escapes embedded single quotes safely', () => {
    expect(getSessionResumeCommand('claude', "session'with'quotes")).toBe("claude --dangerously-skip-permissions --resume 'session'\\''with'\\''quotes'")
  })

  it('prepends cd <cwd> && when cwd is provided', () => {
    expect(getSessionResumeCommand('claude', 'abc', '/Users/me/repo'))
      .toBe("cd '/Users/me/repo' && claude --dangerously-skip-permissions --resume 'abc'")
  })

  it('omits cd prefix when cwd is null or empty', () => {
    expect(getSessionResumeCommand('claude', 'abc', null)).toBe("claude --dangerously-skip-permissions --resume 'abc'")
    expect(getSessionResumeCommand('claude', 'abc', '')).toBe("claude --dangerously-skip-permissions --resume 'abc'")
  })
})

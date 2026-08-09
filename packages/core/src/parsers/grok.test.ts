import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseGrokSession, loadGrokSession, decodeGrokCwdDirname } from './grok.js'

function makeSessionDir(opts: {
  sessionId?: string
  cwd?: string
  summary?: Record<string, unknown>
  chatHistory?: Record<string, unknown>[]
}): string {
  const sessionId = opts.sessionId ?? '019fc5b7-24be-7441-a499-b3c701d5a3cf'
  const dir = mkdtempSync(join(tmpdir(), 'spool-grok-test-'))
  const sessionDir = join(dir, sessionId)
  mkdirSync(sessionDir, { recursive: true })

  const summary = {
    info: { id: sessionId, cwd: opts.cwd ?? '/home/user/project' },
    created_at: '2026-08-03T03:42:21.939498338Z',
    updated_at: '2026-08-03T03:51:31.978495769Z',
    last_active_at: '2026-08-03T03:51:31.978495769Z',
    current_model_id: 'grok-4.5',
    ...opts.summary,
  }
  writeFileSync(join(sessionDir, 'summary.json'), JSON.stringify(summary))

  const lines = (opts.chatHistory ?? []).map(item => JSON.stringify(item))
  writeFileSync(join(sessionDir, 'chat_history.jsonl'), lines.join('\n'))

  return join(sessionDir, 'chat_history.jsonl')
}

describe('parseGrokSession', () => {
  it('parses a basic user/assistant conversation', () => {
    const fp = makeSessionDir({
      chatHistory: [
        { type: 'system', content: 'You are a helpful assistant.' },
        { type: 'user', content: [{ type: 'text', text: 'Help me fix the auth bug' }] },
        { type: 'assistant', content: 'I will look at the auth flow.', tool_calls: [{ id: 'tc1', name: 'read_file' }] },
        { type: 'tool_result', tool_call_id: 'tc1', content: 'file contents here' },
        { type: 'assistant', content: 'The bug is on line 42.' },
      ],
    })

    const parsed = parseGrokSession(fp)
    expect(parsed).not.toBeNull()
    expect(parsed!.source).toBe('grok')
    expect(parsed!.sessionUuid).toBe('019fc5b7-24be-7441-a499-b3c701d5a3cf')
    expect(parsed!.cwd).toBe('/home/user/project')
    expect(parsed!.model).toBe('grok-4.5')
    expect(parsed!.title).toBe('Help me fix the auth bug')
    // system message is not indexed; tool_result is sidechain
    expect(parsed!.messages).toHaveLength(4)
    expect(parsed!.messages[0]!.role).toBe('user')
    expect(parsed!.messages[0]!.contentText).toBe('Help me fix the auth bug')
    expect(parsed!.messages[1]!.role).toBe('assistant')
    expect(parsed!.messages[1]!.toolNames).toEqual(['read_file'])
    expect(parsed!.messages[2]!.role).toBe('system')
    expect(parsed!.messages[2]!.isSidechain).toBe(true)
    expect(parsed!.messages[3]!.role).toBe('assistant')
  })

  it('extracts user_query content and strips wrapper tags', () => {
    const fp = makeSessionDir({
      chatHistory: [
        {
          type: 'user',
          content: [{
            type: 'text',
            text: '<user_info>\nOS Version: linux\nWorkspace Path: /home/user/project\n</user_info>\n\n<git_status>\n## main...origin/main\n</git_status>\n\n<user_query>\nFix the login bug\n</user_query>',
          }],
        },
        { type: 'assistant', content: 'On it.' },
      ],
    })

    const parsed = parseGrokSession(fp)
    expect(parsed!.messages[0]!.contentText).toBe('Fix the login bug')
    expect(parsed!.title).toBe('Fix the login bug')
  })

  it('skips synthetic user messages (project instructions, system reminders)', () => {
    const fp = makeSessionDir({
      chatHistory: [
        { type: 'system', content: 'You are Grok.' },
        { type: 'user', content: [{ type: 'text', text: 'real question' }] },
        { type: 'user', content: [{ type: 'text', text: 'project instructions' }], synthetic_reason: 'project_instructions' },
        { type: 'user', content: [{ type: 'text', text: 'system reminder' }], synthetic_reason: 'system_reminder' },
        { type: 'assistant', content: 'Answer.' },
      ],
    })

    const parsed = parseGrokSession(fp)
    // Only the real user message + assistant response
    expect(parsed!.messages.filter(m => !m.isSidechain)).toHaveLength(2)
    expect(parsed!.messages[0]!.contentText).toBe('real question')
  })

  it('uses generated_title from summary when available', () => {
    const fp = makeSessionDir({
      summary: { generated_title: 'Custom LLM Title' },
      chatHistory: [
        { type: 'user', content: [{ type: 'text', text: 'some question' }] },
        { type: 'assistant', content: 'some answer' },
      ],
    })

    const parsed = parseGrokSession(fp)
    expect(parsed!.title).toBe('Custom LLM Title')
  })

  it('filters hidden sessions (worktree forks, subagent scratchpads)', () => {
    const fp = makeSessionDir({
      summary: { hidden: true },
      chatHistory: [
        { type: 'user', content: [{ type: 'text', text: 'test' }] },
      ],
    })

    expect(parseGrokSession(fp)).toBeNull()
    expect(loadGrokSession(fp).kind).toBe('filtered')
  })

  it('returns skipped for empty chat history', () => {
    const fp = makeSessionDir({
      chatHistory: [],
    })

    expect(parseGrokSession(fp)).toBeNull()
    expect(loadGrokSession(fp).kind).toBe('skipped')
  })

  it('returns skipped when only synthetic messages exist', () => {
    const fp = makeSessionDir({
      chatHistory: [
        { type: 'system', content: 'system prompt' },
        { type: 'user', content: [{ type: 'text', text: 'instructions' }], synthetic_reason: 'project_instructions' },
      ],
    })

    expect(loadGrokSession(fp).kind).toBe('skipped')
  })

  it('assigns monotonic timestamps from summary created_at', () => {
    const fp = makeSessionDir({
      summary: { created_at: '2026-08-03T03:42:21Z' },
      chatHistory: [
        { type: 'user', content: [{ type: 'text', text: 'first' }] },
        { type: 'assistant', content: 'second' },
        { type: 'user', content: [{ type: 'text', text: 'third' }] },
      ],
    })

    const parsed = parseGrokSession(fp)
    const ts = parsed!.messages.map(m => m.timestamp)
    expect(ts[0]!).toBe('2026-08-03T03:42:21.000Z')
    expect(ts[1]!).toBe('2026-08-03T03:42:22.000Z')
    expect(ts[2]!).toBe('2026-08-03T03:42:23.000Z')
  })

  it('extracts tool names from assistant tool_calls', () => {
    const fp = makeSessionDir({
      chatHistory: [
        { type: 'user', content: [{ type: 'text', text: 'do the thing' }] },
        {
          type: 'assistant',
          content: '',
          tool_calls: [
            { id: 'tc1', name: 'run_terminal_command' },
            { id: 'tc2', name: 'search_replace' },
          ],
        },
      ],
    })

    const parsed = parseGrokSession(fp)
    expect(parsed!.messages[1]!.toolNames).toEqual(['run_terminal_command', 'search_replace'])
  })

  it('handles string content for user messages', () => {
    const fp = makeSessionDir({
      chatHistory: [
        { type: 'user', content: 'plain string question' },
        { type: 'assistant', content: 'answer' },
      ],
    })

    const parsed = parseGrokSession(fp)
    expect(parsed!.messages[0]!.contentText).toBe('plain string question')
  })

  it('handles missing summary.json gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spool-grok-nosum-'))
    const sessionDir = join(dir, 'abc123')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'chat_history.jsonl'),
      JSON.stringify({ type: 'user', content: 'test' }) + '\n' + JSON.stringify({ type: 'assistant', content: 'reply' }),
    )

    const parsed = parseGrokSession(join(sessionDir, 'chat_history.jsonl'))
    expect(parsed).not.toBeNull()
    expect(parsed!.sessionUuid).toBe('abc123')
    expect(parsed!.cwd).toBe('')
  })
})

describe('decodeGrokCwdDirname', () => {
  it('decodes URL-encoded short cwds', () => {
    const dir = '/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject'
    expect(decodeGrokCwdDirname(dir)).toBe('/home/user/project')
  })

  it('reads .cwd file for hash-based dirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spool-grok-cwd-'))
    writeFileSync(join(dir, '.cwd'), '/home/user/very/long/path')
    expect(decodeGrokCwdDirname(dir)).toBe('/home/user/very/long/path')
  })

  it('returns null when no .cwd file and not URL-decodable as absolute path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spool-grok-bad-'))
    // A slug-hash name that doesn't start with / and has no .cwd file
    const hashDir = join(dir, 'workspace-abcdef0123456789')
    mkdirSync(hashDir, { recursive: true })
    expect(decodeGrokCwdDirname(hashDir)).toBeNull()
  })
})

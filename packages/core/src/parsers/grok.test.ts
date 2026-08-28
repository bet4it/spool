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
  compactionRequests?: Array<{ createdAt: string, chatHistory: Record<string, unknown>[] }>
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

  if (opts.compactionRequests) {
    const reqDir = join(sessionDir, 'compaction_requests')
    mkdirSync(reqDir, { recursive: true })
    for (const [i, req] of opts.compactionRequests.entries()) {
      const name = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}.json`
      writeFileSync(join(reqDir, name), JSON.stringify({
        schema_version: 2,
        created_at: req.createdAt,
        trigger: 'auto',
        chat_history: req.chatHistory,
      }))
    }
  }

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

  it('strips <rules> scaffolding block so it does not become the indexed first message', () => {
    // Grok Build injects workspace/user rules as a standalone user item
    // (no synthetic_reason, no <user_query> wrapper) ahead of the real
    // query. The <rules> block must be stripped so it doesn't pollute
    // the indexed first message or the title.
    const fp = makeSessionDir({
      chatHistory: [
        {
          type: 'user',
          content: [{
            type: 'text',
            text: '<user_info>\nOS Version: linux\n</user_info>\n\n<git_status>\n## main\n</git_status>\n\n<rules>\nAlways read DESIGN.md.\n</rules>',
          }],
        },
        {
          type: 'user',
          content: [{ type: 'text', text: '<user_query>\nHow do I add a dark mode toggle?\n</user_query>' }],
        },
        { type: 'assistant', content: 'Use a class on the root element.' },
      ],
    })

    const parsed = parseGrokSession(fp)
    const real = parsed!.messages.filter(m => !m.isSidechain)
    // Scaffolding message stripped to empty → skipped; only real query + assistant
    expect(real).toHaveLength(2)
    expect(real[0]!.contentText).toBe('How do I add a dark mode toggle?')
    expect(parsed!.title).toBe('How do I add a dark mode toggle?')
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

  it('strips <workspace_result> wrapper from tool results', () => {
    const fp = makeSessionDir({
      chatHistory: [
        { type: 'user', content: [{ type: 'text', text: 'grep for foo' }] },
        { type: 'assistant', content: '', tool_calls: [{ id: 'tc1', name: 'grep' }] },
        {
          type: 'tool_result',
          tool_call_id: 'tc1',
          content: '<workspace_result workspace_path="/home/user/project">\nFound 3 matches\nsrc/index.ts:42:foo\nsrc/util.ts:15:foo\n</workspace_result>',
        },
        { type: 'assistant', content: 'Found it.' },
      ],
    })

    const parsed = parseGrokSession(fp)
    // The tool call's result should be unwrapped
    const call = parsed!.messages[1]!.toolCalls?.[0]
    expect(call?.result).toBe('Found 3 matches\nsrc/index.ts:42:foo\nsrc/util.ts:15:foo')
    // The sidechain message should also be unwrapped
    const sidechain = parsed!.messages.find(m => m.isSidechain)
    expect(sidechain?.contentText).toBe('Found 3 matches\nsrc/index.ts:42:foo\nsrc/util.ts:15:foo')
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

describe('grok compaction merge', () => {
  const userQuery = (text: string) => ({
    type: 'user',
    content: [{ type: 'text', text: `<user_query>\n${text}\n</user_query>` }],
  })
  const assistant = (text: string) => ({ type: 'assistant', content: text })

  it('merges pre-compaction history ahead of the compacted live file', () => {
    const fp = makeSessionDir({
      chatHistory: [
        userQuery('post-compaction question'),
        assistant('post-compaction answer'),
      ],
      compactionRequests: [
        {
          createdAt: '2026-08-03T03:45:00Z',
          chatHistory: [
            { type: 'system', content: 'You are Grok.' },
            userQuery('original first question'),
            assistant('original first answer'),
          ],
        },
      ],
    })

    const parsed = parseGrokSession(fp)
    const userTexts = parsed!.messages.filter(m => m.role === 'user').map(m => m.contentText)
    expect(userTexts).toEqual(['original first question', 'post-compaction question'])
    expect(parsed!.title).toBe('original first question')
  })

  it('drops the summarize instruction and continued-summary scaffolding from segments', () => {
    const fp = makeSessionDir({
      chatHistory: [userQuery('live question'), assistant('live answer')],
      compactionRequests: [
        {
          createdAt: '2026-08-03T03:45:00Z',
          chatHistory: [
            { type: 'system', content: 'You are Grok.' },
            userQuery('real question'),
            assistant('real answer'),
            { type: 'user', content: 'Your task is to produce a faithful, concise summary of the conversation so far.' },
          ],
        },
      ],
    })

    const parsed = parseGrokSession(fp)
    const texts = parsed!.messages.map(m => m.contentText)
    expect(texts).not.toContain(expect.stringContaining('Your task is to produce'))
    expect(texts).toContain('real question')
    expect(texts).toContain('live question')
  })

  it('dedupes the interrupted turn replayed at the live seam', () => {
    // Grok re-sends the query it was mid-turn on when compaction fired;
    // the live file's first real query is that same text.
    const fp = makeSessionDir({
      chatHistory: [
        userQuery('interrupted question'),
        assistant('post-compaction continuation'),
      ],
      compactionRequests: [
        {
          createdAt: '2026-08-03T03:45:00Z',
          chatHistory: [
            userQuery('earlier question'),
            assistant('earlier answer'),
            userQuery('interrupted question'),
            assistant('in-flight answer from pre-compaction context'),
          ],
        },
      ],
    })

    const parsed = parseGrokSession(fp)
    const userTexts = parsed!.messages.filter(m => m.role === 'user').map(m => m.contentText)
    expect(userTexts).toEqual(['earlier question', 'interrupted question'])
  })

  it('keeps identical question text when it is not the seam turn', () => {
    // Same question asked twice for real (and again at the seam) — only
    // the seam copy is deduped, both real occurrences stay.
    const repeated = 'why does the test fail?'
    const fp = makeSessionDir({
      chatHistory: [
        userQuery('warmup question'),
        userQuery(repeated),
        assistant('second answer'),
      ],
      compactionRequests: [
        {
          createdAt: '2026-08-03T03:45:00Z',
          chatHistory: [
            userQuery(repeated),
            assistant('first answer'),
            userQuery('later question'),
            assistant('later answer'),
          ],
        },
      ],
    })

    const parsed = parseGrokSession(fp)
    const userTexts = parsed!.messages.filter(m => m.role === 'user').map(m => m.contentText)
    expect(userTexts).toEqual([repeated, 'later question', 'warmup question', repeated])
  })

  it('merges multiple segments in chronological order', () => {
    const fp = makeSessionDir({
      chatHistory: [userQuery('final question'), assistant('final answer')],
      compactionRequests: [
        {
          // Later file on disk but earlier created_at — must sort first.
          createdAt: '2026-08-03T03:44:00Z',
          chatHistory: [userQuery('first question'), assistant('first answer')],
        },
        {
          createdAt: '2026-08-03T03:46:00Z',
          chatHistory: [userQuery('second question'), assistant('second answer')],
        },
      ],
    })

    const parsed = parseGrokSession(fp)
    const userTexts = parsed!.messages.filter(m => m.role === 'user').map(m => m.contentText)
    expect(userTexts).toEqual(['first question', 'second question', 'final question'])
  })

  it('fills tool_call results across merged segment history', () => {
    const fp = makeSessionDir({
      chatHistory: [userQuery('live question'), assistant('live answer')],
      compactionRequests: [
        {
          createdAt: '2026-08-03T03:45:00Z',
          chatHistory: [
            userQuery('grep for foo'),
            { type: 'assistant', content: '', tool_calls: [{ id: 'tc-seg', name: 'grep' }] },
            { type: 'tool_result', tool_call_id: 'tc-seg', content: 'match at line 42' },
            assistant('found it'),
          ],
        },
      ],
    })

    const parsed = parseGrokSession(fp)
    const call = parsed!.messages.find(m => m.role === 'assistant' && m.toolCalls?.length)?.toolCalls?.[0]
    expect(call?.name).toBe('grep')
    expect(call?.result).toBe('match at line 42')
  })

  it('ignores malformed and non-json files in compaction_requests', () => {
    const fp = makeSessionDir({
      chatHistory: [userQuery('live question'), assistant('live answer')],
      compactionRequests: [
        { createdAt: '2026-08-03T03:45:00Z', chatHistory: [userQuery('good question'), assistant('good answer')] },
      ],
    })
    // Corrupt a sibling file and add a non-json one.
    const sessionDir = fp.slice(0, -'/chat_history.jsonl'.length)
    writeFileSync(join(sessionDir, 'compaction_requests', 'broken.json'), '{not json')
    writeFileSync(join(sessionDir, 'compaction_requests', 'notes.txt'), 'ignore me')

    const parsed = parseGrokSession(fp)
    const userTexts = parsed!.messages.filter(m => m.role === 'user').map(m => m.contentText)
    expect(userTexts).toEqual(['good question', 'live question'])
  })

  it('does not touch sessions without compaction requests', () => {
    const fp = makeSessionDir({
      chatHistory: [userQuery('only question'), assistant('only answer')],
    })

    const parsed = parseGrokSession(fp)
    expect(parsed!.messages).toHaveLength(2)
  })
})

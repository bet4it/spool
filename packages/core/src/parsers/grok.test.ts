import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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

/** Writes a parent session's `subagents/<childId>/meta.json`, mirroring
 *  grok-build's on-disk layout:
 *  <sessions_root>/<encoded_cwd>/<parent_id>/subagents/<child_id>/meta.json.
 *  The parent chat path must already sit one level below a sessions root. */
function makeSubagentMeta(parentChatPath: string, childId: string): void {
  const sessionDir = parentChatPath.slice(0, -'/chat_history.jsonl'.length)
  const metaDir = join(sessionDir, 'subagents', childId)
  mkdirSync(metaDir, { recursive: true })
  writeFileSync(join(metaDir, 'meta.json'), JSON.stringify({
    subagent_id: childId,
    child_session_id: childId,
    parent_session_id: basename(sessionDir),
    description: 'explorer task',
    status: 'completed',
  }))
}

/** Moves a fixture session dir to `<sessionsRoot>/<encoded>/<id>`, so
 *  subagent fixtures live in their own encoded-cwd dir like real data. */
function homeUnderSessionsRoot(chatPath: string, sessionsRoot: string): string {
  const sessionDir = chatPath.slice(0, -'/chat_history.jsonl'.length)
  const moved = join(sessionsRoot, '%2Ftmp%2Fencoded', basename(sessionDir))
  mkdirSync(dirname(moved), { recursive: true })
  renameSync(sessionDir, moved)
  return join(moved, 'chat_history.jsonl')
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

  it('preserves parent_session_id from forked/subagent-resumed sessions', () => {
    const fp = makeSessionDir({
      summary: { parent_session_id: '01a024b8-530a-7e01-815c-50f9fd631e8f', session_kind: 'fork' },
      chatHistory: [
        { type: 'user', content: [{ type: 'text', text: 'continue the work' }] },
        { type: 'assistant', content: 'Continuing.' },
      ],
    })

    expect(parseGrokSession(fp)?.parentSessionUuid).toBe('01a024b8-530a-7e01-815c-50f9fd631e8f')
  })

  it('treats fresh sessions and empty parent_session_id as roots', () => {
    const fresh = makeSessionDir({
      chatHistory: [
        { type: 'user', content: [{ type: 'text', text: 'start something new' }] },
        { type: 'assistant', content: 'Started.' },
      ],
    })
    expect(parseGrokSession(fresh)?.parentSessionUuid).toBeNull()

    // grok-build writes absent optional fields, not empty strings, but
    // a registry replica could round-trip one; '' must not claim a parent.
    const emptyParent = makeSessionDir({
      summary: { parent_session_id: '' },
      chatHistory: [
        { type: 'user', content: [{ type: 'text', text: 'also new' }] },
        { type: 'assistant', content: 'Ok.' },
      ],
    })
    expect(parseGrokSession(emptyParent)?.parentSessionUuid).toBeNull()
  })

  it('still filters sessions with an explicit hidden flag', () => {
    // grok-build currently never writes hidden:true at runtime (verified
    // across the whole repo), but the override is part of the format.
    const fp = makeSessionDir({
      summary: { hidden: true },
      chatHistory: [
        { type: 'user', content: [{ type: 'text', text: 'test' }] },
      ],
    })

    expect(parseGrokSession(fp)).toBeNull()
    expect(loadGrokSession(fp).kind).toBe('filtered')
  })

  it('keeps subagent sessions indexable despite their hidden-by-kind default', () => {
    // grok-build's lister hides subagent* kinds when `hidden` is unset;
    // Spool instead keeps them and folds them under their parent.
    const kinds = ['subagent', 'subagent_fork', 'subagent_resume']
    for (const session_kind of kinds) {
      const fp = makeSessionDir({
        summary: { session_kind },
        chatHistory: [
          { type: 'user', content: [{ type: 'text', text: 'task' }] },
          { type: 'assistant', content: 'Working.' },
        ],
      })
      expect(parseGrokSession(fp)).not.toBeNull()
    }
  })

  it('resolves a plain subagent session parent from the parent subagents meta.json', () => {
    const PARENT = '019fc5b7-0000-7000-8000-000000000001'
    const CHILD = '019fc5b7-0000-7000-8000-000000000002'
    const parentFp = makeSessionDir({
      sessionId: PARENT,
      chatHistory: [
        { type: 'user', content: [{ type: 'text', text: 'parent work' }] },
        { type: 'assistant', content: 'Done.' },
      ],
    })
    makeSubagentMeta(parentFp, CHILD)

    const child = makeSessionDir({
      sessionId: CHILD,
      summary: { session_kind: 'subagent' },
      chatHistory: [
        { type: 'user', content: [{ type: 'text', text: 'subagent task' }] },
        { type: 'assistant', content: 'Task done.' },
      ],
    })
    // Real layout: parent and child live in their own encoded-cwd dirs
    // under the shared sessions root.
    const sessionsRoot = dirname(dirname(parentFp))
    const childFp = homeUnderSessionsRoot(child, sessionsRoot)
    const parentUnderRoot = homeUnderSessionsRoot(parentFp, sessionsRoot)
    expect(parentUnderRoot).toBeTruthy()

    const parsed = parseGrokSession(childFp)
    expect(parsed).not.toBeNull()
    expect(parsed!.parentSessionUuid).toBe(PARENT)
    expect(parsed!.sessionUuid).toBe(CHILD)
  })

  it('treats a subagent session with no resolvable meta as a root', () => {
    const fp = makeSessionDir({
      summary: { session_kind: 'subagent' },
      chatHistory: [
        { type: 'user', content: [{ type: 'text', text: 'lone task' }] },
        { type: 'assistant', content: 'Done.' },
      ],
    })
    expect(parseGrokSession(fp)?.parentSessionUuid).toBeNull()
  })

  it('ignores meta.json with empty or missing parent_session_id', () => {
    const PARENT = '019fc5b7-0000-7000-8000-000000000011'
    const CHILD = '019fc5b7-0000-7000-8000-000000000012'
    const parentFp = makeSessionDir({ sessionId: PARENT, chatHistory: [] })
    const sessionDir = parentFp.slice(0, -'/chat_history.jsonl'.length)
    const metaDir = join(sessionDir, 'subagents', CHILD)
    mkdirSync(metaDir, { recursive: true })
    writeFileSync(join(metaDir, 'meta.json'), JSON.stringify({ child_session_id: CHILD }))

    const child = makeSessionDir({
      sessionId: CHILD,
      summary: { session_kind: 'subagent' },
      chatHistory: [
        { type: 'user', content: [{ type: 'text', text: 'task' }] },
        { type: 'assistant', content: 'Done.' },
      ],
    })
    const sessionsRoot = dirname(dirname(parentFp))
    homeUnderSessionsRoot(parentFp, sessionsRoot)
    const childFp = homeUnderSessionsRoot(child, sessionsRoot)

    expect(parseGrokSession(childFp)?.parentSessionUuid).toBeNull()
  })

  it('does not scan for subagent meta when the session already has a parent_session_id', () => {
    // subagent_resume summaries carry the parent directly; the meta walk
    // would find nothing anyway but must not run.
    const fp = makeSessionDir({
      summary: { session_kind: 'subagent_resume', parent_session_id: '01a024b8-530a-7e01-815c-50f9fd631e8f' },
      chatHistory: [
        { type: 'user', content: [{ type: 'text', text: 'continue task' }] },
        { type: 'assistant', content: 'Continued.' },
      ],
    })
    expect(parseGrokSession(fp)?.parentSessionUuid).toBe('01a024b8-530a-7e01-815c-50f9fd631e8f')
  })

  it('keeps fork and worktree sessions visible by session_kind', () => {
    for (const session_kind of ['fork', 'worktree']) {
      const fp = makeSessionDir({
        summary: { session_kind, parent_session_id: '01a024b8-530a-7e01-815c-50f9fd631e8f' },
        chatHistory: [
          { type: 'user', content: [{ type: 'text', text: 'continue' }] },
          { type: 'assistant', content: 'Ok.' },
        ],
      })
      expect(parseGrokSession(fp)).not.toBeNull()
    }
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

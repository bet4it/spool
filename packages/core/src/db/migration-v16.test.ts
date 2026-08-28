import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations, LATEST_SCHEMA_VERSION } from './db.js'
import { getOrCreateProject, insertMessages, upsertSession, getSessionWithMessages } from './queries.js'

/** Seed a project + session and return the session's row id. */
function seedSession(db: Database.Database, sessionUuid = 'sess-1'): number {
  const projectId = getOrCreateProject(db, 1, 'proj', '/tmp/proj', 'proj', {
    identityKind: 'path',
    identityKey: '/tmp/proj',
  })
  upsertSession(db, {
    projectId,
    sourceId: 1,
    sessionUuid,
    filePath: `/tmp/${sessionUuid}.jsonl`,
    title: 'A session',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:01:00Z',
    messageCount: 0,
    hasToolUse: true,
    cwd: '/tmp/proj',
    model: 'claude-opus-4-6',
    rawFileMtime: '2026-01-01T00:00:00Z',
  })
  return (db.prepare('SELECT id FROM sessions WHERE session_uuid = ?')
    .get(sessionUuid) as { id: number }).id
}

describe('migration v16 — tool detail on messages', () => {
  it('LATEST_SCHEMA_VERSION is 18', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(18)
  })

  it('adds tool_calls and thinking columns to messages', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    const names = new Set(cols.map(c => c.name))
    expect(names.has('tool_calls')).toBe(true)
    expect(names.has('thinking')).toBe(true)
  })

  it('upgrades a v15 DB in place without touching existing message rows', () => {
    // The v16 step is purely additive — an install upgrading from v15
    // must keep every indexed message, since re-indexing is deferred to
    // the next lazy sync rather than run as a blocking migration.
    const db = new Database(':memory:')
    runMigrations(db)
    const sessionId = seedSession(db)
    db.prepare(
      `INSERT INTO messages (session_id, source_id, msg_uuid, role, content_text, timestamp, tool_names, seq)
       VALUES (?, 1, 'm1', 'assistant', 'legacy text', '2026-01-01T00:00:00Z', '["Bash"]', 0)`,
    ).run(sessionId)
    // Simulate a DB that predates v16 and re-run migrations over it.
    db.pragma('user_version = 15')
    runMigrations(db)

    const result = getSessionWithMessages(db, 'sess-1')
    expect(result?.messages).toHaveLength(1)
    expect(result?.messages[0]?.contentText).toBe('legacy text')
    // Legacy rows carry no detail and must degrade to the name-only
    // rendering rather than throwing on read.
    expect(result?.messages[0]?.toolNames).toEqual(['Bash'])
    expect(result?.messages[0]?.toolCalls).toEqual([])
    expect(result?.messages[0]?.thinking).toBeNull()
  })

  it('round-trips toolCalls and thinking through insert and read', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const sessionId = seedSession(db)
    insertMessages(db, sessionId, 1, [
      {
        uuid: 'm1',
        parentUuid: null,
        role: 'assistant',
        contentText: 'Done.',
        timestamp: '2026-01-01T00:00:00Z',
        isSidechain: false,
        toolNames: ['Bash'],
        seq: 0,
        toolCalls: [{ name: 'Bash', id: 't1', input: '{"command":"ls"}', result: 'a.txt', isError: true }],
        thinking: 'Considering the options.',
      },
    ])

    const message = getSessionWithMessages(db, 'sess-1')?.messages[0]
    expect(message?.thinking).toBe('Considering the options.')
    expect(message?.toolCalls).toEqual([
      { name: 'Bash', id: 't1', input: '{"command":"ls"}', result: 'a.txt', isError: true },
    ])
  })

  it('defaults toolCalls to [] and thinking to null when a parser supplies neither', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const sessionId = seedSession(db)
    insertMessages(db, sessionId, 1, [
      {
        uuid: 'm1',
        parentUuid: null,
        role: 'user',
        contentText: 'hello',
        timestamp: '2026-01-01T00:00:00Z',
        isSidechain: false,
        toolNames: [],
        seq: 0,
      },
    ])
    const message = getSessionWithMessages(db, 'sess-1')?.messages[0]
    expect(message?.toolCalls).toEqual([])
    expect(message?.thinking).toBeNull()
  })

  it('survives a corrupt tool_calls payload instead of failing the whole transcript', () => {
    // A row whose JSON is unreadable must not take down the session
    // view — the detail degrades, the conversation still renders.
    const db = new Database(':memory:')
    runMigrations(db)
    const sessionId = seedSession(db)
    db.prepare(
      `INSERT INTO messages (session_id, source_id, msg_uuid, role, content_text, timestamp, tool_names, tool_calls, seq)
       VALUES (?, 1, 'm1', 'assistant', 'text', '2026-01-01T00:00:00Z', '[]', 'not json', 0)`,
    ).run(sessionId)
    const message = getSessionWithMessages(db, 'sess-1')?.messages[0]
    expect(message?.contentText).toBe('text')
    expect(message?.toolCalls).toEqual([])
  })

  it('keeps tool payloads out of the message FTS index', () => {
    // messages_fts is external-content over content_text only. Tool
    // output is mostly file contents and shell noise; indexing it would
    // swamp search with matches the user never wrote.
    const db = new Database(':memory:')
    runMigrations(db)
    const sessionId = seedSession(db)
    insertMessages(db, sessionId, 1, [
      {
        uuid: 'm1',
        parentUuid: null,
        role: 'assistant',
        contentText: 'visible prose',
        timestamp: '2026-01-01T00:00:00Z',
        isSidechain: false,
        toolNames: ['Bash'],
        seq: 0,
        toolCalls: [{ name: 'Bash', result: 'zzunsearchablezz' }],
        thinking: 'zzhiddenthoughtzz',
      },
    ])
    const hits = db.prepare(
      `SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH ?`,
    ).get('zzunsearchablezz OR zzhiddenthoughtzz') as { c: number }
    expect(hits.c).toBe(0)
  })
})

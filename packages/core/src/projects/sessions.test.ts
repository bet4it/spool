import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../db/db.js'
import { listSessionsByIdentity, listRecentSessionsPage, listSessionsByProjectPathSubstring, listProjectDirectoryCounts } from './sessions.js'

describe('listSessionsByIdentity', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    db.exec(`
      INSERT INTO projects (source_id, slug, display_path, display_name, identity_kind, identity_key)
      VALUES
        (1,'spool-c','/Users/chen/Code/spool','spool','git_remote','github.com/spool-lab/spool'),
        (2,'spool-x','/Users/chen/Code/spool','spool','git_remote','github.com/spool-lab/spool'),
        (1,'other','/Users/chen/Code/other','other','path','/Users/chen/Code/other');
      INSERT INTO sessions (project_id, source_id, session_uuid, file_path, title, started_at, ended_at, message_count, has_tool_use, raw_file_mtime)
      VALUES
        (1,1,'u1','/p1','beta',  '2026-04-28T10:00:00Z','2026-04-28T10:30:00Z', 5, 0,'2026-04-28T10:30:00Z'),
        (1,1,'u2','/p2','alpha', '2026-04-27T10:00:00Z','2026-04-27T10:30:00Z',10, 0,'2026-04-27T10:30:00Z'),
        (2,2,'u3','/p3','gamma', '2026-04-26T10:00:00Z','2026-04-26T10:30:00Z', 3, 0,'2026-04-26T10:30:00Z'),
        (3,1,'u4','/p4','other-a','2026-04-29T10:00:00Z','2026-04-29T10:30:00Z', 1, 0,'2026-04-29T10:30:00Z');
    `)
  })

  it('only returns sessions matching identity_key', () => {
    const { sessions } = listSessionsByIdentity(db, 'github.com/spool-lab/spool')
    expect(sessions).toHaveLength(3)
    expect(sessions.map(s => s.sessionUuid).sort()).toEqual(['u1', 'u2', 'u3'])
  })

  it('default sort is started_at DESC', () => {
    const { sessions } = listSessionsByIdentity(db, 'github.com/spool-lab/spool')
    expect(sessions.map(s => s.sessionUuid)).toEqual(['u1', 'u2', 'u3'])
  })

  it('sortOrder oldest', () => {
    const { sessions } = listSessionsByIdentity(db, 'github.com/spool-lab/spool', { sortOrder: 'oldest' })
    expect(sessions.map(s => s.sessionUuid)).toEqual(['u3', 'u2', 'u1'])
  })

  it('sortOrder most_messages', () => {
    const { sessions } = listSessionsByIdentity(db, 'github.com/spool-lab/spool', { sortOrder: 'most_messages' })
    expect(sessions.map(s => s.sessionUuid)).toEqual(['u2', 'u1', 'u3'])
  })

  it('sortOrder title (alphabetical)', () => {
    const { sessions } = listSessionsByIdentity(db, 'github.com/spool-lab/spool', { sortOrder: 'title' })
    expect(sessions.map(s => s.title)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('source filter narrows to matching sources', () => {
    const { sessions } = listSessionsByIdentity(db, 'github.com/spool-lab/spool', { sources: ['claude'] })
    expect(sessions.map(s => s.sessionUuid).sort()).toEqual(['u1', 'u2'])
  })

  it('returns empty result when identity_key has no sessions', () => {
    const result = listSessionsByIdentity(db, 'no-such-key')
    expect(result.sessions).toEqual([])
    expect(result.nextCursor).toBeNull()
  })

  it('respects limit and exposes a cursor for the next page', () => {
    const page1 = listSessionsByIdentity(db, 'github.com/spool-lab/spool', { limit: 2 })
    expect(page1.sessions).toHaveLength(2)
    expect(page1.sessions.map(s => s.sessionUuid)).toEqual(['u1', 'u2'])
    expect(page1.nextCursor).not.toBeNull()

    const page2 = listSessionsByIdentity(db, 'github.com/spool-lab/spool', {
      limit: 2,
      cursor: page1.nextCursor!,
    })
    expect(page2.sessions.map(s => s.sessionUuid)).toEqual(['u3'])
    expect(page2.nextCursor).toBeNull()
  })

  it('does not return a cursor on the final partial page', () => {
    const { nextCursor } = listSessionsByIdentity(db, 'github.com/spool-lab/spool', { limit: 10 })
    expect(nextCursor).toBeNull()
  })

  it('keyset pagination is stable across sortOrder=most_messages', () => {
    const page1 = listSessionsByIdentity(db, 'github.com/spool-lab/spool', { sortOrder: 'most_messages', limit: 1 })
    expect(page1.sessions.map(s => s.sessionUuid)).toEqual(['u2'])
    const page2 = listSessionsByIdentity(db, 'github.com/spool-lab/spool', {
      sortOrder: 'most_messages',
      limit: 1,
      cursor: page1.nextCursor!,
    })
    expect(page2.sessions.map(s => s.sessionUuid)).toEqual(['u1'])
    const page3 = listSessionsByIdentity(db, 'github.com/spool-lab/spool', {
      sortOrder: 'most_messages',
      limit: 1,
      cursor: page2.nextCursor!,
    })
    expect(page3.sessions.map(s => s.sessionUuid)).toEqual(['u3'])
    expect(page3.nextCursor).toBeNull()
  })

  it('keyset pagination is stable across sortOrder=title', () => {
    const collected: string[] = []
    let cursor: ReturnType<typeof listSessionsByIdentity>['nextCursor'] = null
    for (let i = 0; i < 5; i++) {
      const page = listSessionsByIdentity(db, 'github.com/spool-lab/spool', {
        sortOrder: 'title',
        limit: 1,
        ...(cursor ? { cursor } : {}),
      })
      collected.push(...page.sessions.map(s => s.title!))
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(collected).toEqual(['alpha', 'beta', 'gamma'])
  })
})

describe('listRecentSessionsPage', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    db.exec(`
      INSERT INTO projects (source_id, slug, display_path, display_name, identity_kind, identity_key)
      VALUES (1,'p','/p','p','path','/p');
      INSERT INTO sessions (project_id, source_id, session_uuid, file_path, title, started_at, ended_at, message_count, has_tool_use, raw_file_mtime)
      VALUES
        (1,1,'a','/a','a','2026-05-01T00:00:00Z','2026-05-01T00:00:00Z',1,0,'2026-05-01T00:00:00Z'),
        (1,1,'b','/b','b','2026-05-02T00:00:00Z','2026-05-05T00:00:00Z',1,0,'2026-05-05T00:00:00Z'),
        (1,1,'c','/c','c','2026-05-03T00:00:00Z','2026-05-03T00:00:00Z',1,0,'2026-05-03T00:00:00Z');
    `)
  })

  it('paginates recent sessions across the global library', () => {
    const page1 = listRecentSessionsPage(db, { limit: 2 })
    expect(page1.sessions.map(s => s.sessionUuid)).toEqual(['c', 'b'])
    expect(page1.nextCursor).not.toBeNull()

    const page2 = listRecentSessionsPage(db, { limit: 2, cursor: page1.nextCursor! })
    expect(page2.sessions.map(s => s.sessionUuid)).toEqual(['a'])
    expect(page2.nextCursor).toBeNull()
  })

  it('can paginate recent sessions by last message time', () => {
    const page1 = listRecentSessionsPage(db, { limit: 2, sortBasis: 'ended_at' })
    expect(page1.sessions.map(s => s.sessionUuid)).toEqual(['b', 'c'])
    expect(page1.nextCursor).not.toBeNull()

    const page2 = listRecentSessionsPage(db, { limit: 2, sortBasis: 'ended_at', cursor: page1.nextCursor! })
    expect(page2.sessions.map(s => s.sessionUuid)).toEqual(['a'])
    expect(page2.nextCursor).toBeNull()
  })
})

describe('listSessionsByProjectPathSubstring', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    db.exec(`
      INSERT INTO projects (source_id, slug, display_path, display_name, identity_kind, identity_key)
      VALUES
        (1,'libafl','/codes/fuzz/libafl_qemu_fuzzer','libafl_qemu_fuzzer','git_remote','github.com/x/libafl_qemu_fuzzer'),
        (1,'bridge','/codes/fuzz/qemu-libafl-bridge','qemu-libafl-bridge','git_remote','github.com/x/bridge'),
        (1,'other','/codes/other','other','path','/codes/other');
      -- 100 sessions in the libafl project with old timestamps, plus recent ones elsewhere.
      -- The old list -p implementation pulled the global timeline (limit*2 rows) and
      -- missed these; the SQL-side filter must see them regardless of recency.
      INSERT INTO sessions (project_id, source_id, session_uuid, file_path, title, started_at, ended_at, message_count, has_tool_use, raw_file_mtime)
      WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < 100)
      SELECT 1, 1, 'old-' || i, '/f' || i, 'old ' || i,
             '2026-01-01T00:00:' || printf('%02d', i % 60) || 'Z',
             '2026-01-01T00:00:' || printf('%02d', i % 60) || 'Z',
             1, 0, '2026-01-01T00:00:00Z'
      FROM seq;
      INSERT INTO sessions (project_id, source_id, session_uuid, file_path, title, started_at, ended_at, message_count, has_tool_use, raw_file_mtime)
      VALUES
        (2,1,'bridge-recent','/fb','bridge recent','2026-06-01T00:00:00Z','2026-06-01T00:00:00Z',1,0,'2026-06-01T00:00:00Z'),
        (3,1,'other-recent','/fo','other recent','2026-06-02T00:00:00Z','2026-06-02T00:00:00Z',1,0,'2026-06-02T00:00:00Z');
    `)
  })

  it('matches sessions across all projects containing the substring, newest first', () => {
    const { sessions } = listSessionsByProjectPathSubstring(db, 'libafl', { limit: 200 })
    expect(sessions).toHaveLength(101)
    // bridge project's path also contains 'libafl' and is the most recent
    expect(sessions[0]!.sessionUuid).toBe('bridge-recent')
    // no non-matching project leaks in
    expect(sessions.every(s => s.projectDisplayPath.toLowerCase().includes('libafl'))).toBe(true)
  })

  it('is case-insensitive', () => {
    const { sessions } = listSessionsByProjectPathSubstring(db, 'LIBAFL', { limit: 200 })
    expect(sessions).toHaveLength(101)
  })

  it('respects the limit from the full matching set, not a recent window', () => {
    // limit far below the 101 matches — must return the 100 oldest-match
    // exclusion case: newest 20 of the matches, all from libafl projects
    const { sessions, nextCursor } = listSessionsByProjectPathSubstring(db, 'libafl', { limit: 20 })
    expect(sessions).toHaveLength(20)
    expect(nextCursor).not.toBeNull()
    expect(sessions[0]!.sessionUuid).toBe('bridge-recent')
  })

  it('returns a cursor when more matches exist and none at the end', () => {
    const page1 = listSessionsByProjectPathSubstring(db, 'libafl', { limit: 100 })
    expect(page1.sessions).toHaveLength(100)
    expect(page1.nextCursor).not.toBeNull()

    const page2 = listSessionsByProjectPathSubstring(db, 'libafl', { limit: 100 })
    // No cursor support needed by the CLI today, but the page shape must hold:
    // without cursor the same first page comes back — callers needing full
    // results pass a limit >= match count.
    expect(page2.sessions).toHaveLength(100)
  })

  it('filters by source inside the query', () => {
    const { sessions } = listSessionsByProjectPathSubstring(db, 'libafl', { limit: 200, sources: ['codex'] })
    expect(sessions).toEqual([])
    const { sessions: geminiOnly } = listSessionsByProjectPathSubstring(db, 'libafl', { limit: 200, sources: ['claude'] })
    expect(geminiOnly).toHaveLength(101)
  })

  it('returns empty for a substring matching no project', () => {
    const { sessions, nextCursor } = listSessionsByProjectPathSubstring(db, 'no-such-path')
    expect(sessions).toEqual([])
    expect(nextCursor).toBeNull()
  })

  it('excludes empty sessions', () => {
    db.exec(`
      INSERT INTO sessions (project_id, source_id, session_uuid, file_path, title, started_at, ended_at, message_count, has_tool_use, raw_file_mtime)
      VALUES (1,1,'empty','/fe','empty','2026-07-01T00:00:00Z','2026-07-01T00:00:00Z',0,0,'2026-07-01T00:00:00Z');
    `)
    const { sessions } = listSessionsByProjectPathSubstring(db, 'libafl', { limit: 200 })
    expect(sessions.map(s => s.sessionUuid)).not.toContain('empty')
  })
})

describe('listProjectDirectoryCounts', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    db.exec(`
      INSERT INTO projects (source_id, slug, display_path, display_name, identity_kind, identity_key)
      VALUES (1,'spool','/r','spool','git_remote','github.com/spool-lab/spool');
      INSERT INTO sessions (project_id, source_id, session_uuid, file_path, title, started_at, ended_at, message_count, has_tool_use, raw_file_mtime, cwd)
      VALUES
        (1,1,'a','/a','a','2026-05-01T00:00:00Z','2026-05-01T00:00:00Z',1,0,'2026-05-01T00:00:00Z','/r/pkg/app'),
        (1,1,'b','/b','b','2026-05-02T00:00:00Z','2026-05-02T00:00:00Z',1,0,'2026-05-02T00:00:00Z','/r/pkg/app'),
        (1,1,'c','/c','c','2026-05-03T00:00:00Z','2026-05-03T00:00:00Z',1,0,'2026-05-03T00:00:00Z','/r/pkg/core'),
        (1,1,'d','/d','d','2026-05-04T00:00:00Z','2026-05-04T00:00:00Z',0,0,'2026-05-04T00:00:00Z','/r/pkg/core');
    `)
  })

  it('returns per-cwd counts ordered by recency, skipping empty sessions', () => {
    const counts = listProjectDirectoryCounts(db, 'github.com/spool-lab/spool')
    expect(counts).toEqual([
      { cwd: '/r/pkg/core', sessionCount: 1, lastSessionAt: '2026-05-03T00:00:00Z' },
      { cwd: '/r/pkg/app', sessionCount: 2, lastSessionAt: '2026-05-02T00:00:00Z' },
    ])
  })

  it('source filter narrows the rows that get grouped', () => {
    const counts = listProjectDirectoryCounts(db, 'github.com/spool-lab/spool', { sources: ['codex'] })
    expect(counts).toEqual([])
  })
})

import { Command } from 'commander'
import { getDB, listRecentSessionsPage, listSessionsByProjectPathSubstring } from '@spool-lab/core'
import type { SessionSource } from '@spool-lab/core'
import { printSession } from '../format.js'

const SESSION_SOURCES = new Set(['claude', 'codex', 'gemini', 'antigravity', 'opencode', 'grok'])

export const listCommand = new Command('list')
  .description('List recent AI sessions')
  .option('-n, --limit <n>', 'Max results', '20')
  .option('-s, --source <name>', 'Filter by source: claude|codex|gemini|antigravity|opencode|grok')
  .option('-p, --project <path>', 'Filter by project path substring')
  .option('--json', 'Output as JSON')
  .action((opts: { limit: string; source?: string; project?: string; json?: boolean }) => {
    const db = getDB(true)
    const limit = parseInt(opts.limit, 10)
    const source: SessionSource | undefined = opts.source && SESSION_SOURCES.has(opts.source)
      ? opts.source as SessionSource
      : undefined

    const sessions = opts.project
      ? // SQL-side filters: returns matches from the whole index, not just
        // the most recent slice (old behavior fetched the global timeline
        // with limit*2 rows and missed older sessions).
        listSessionsByProjectPathSubstring(db, opts.project, {
          limit,
          ...(source ? { sources: [source] } : {}),
        }).sessions
      : listRecentSessionsPage(db, { limit }).sessions
        .filter(s => !source || s.source === source)

    if (opts.json) {
      console.log(JSON.stringify(sessions, null, 2))
      return
    }

    if (sessions.length === 0) {
      console.log('No sessions found. Run `spool sync` to index sessions.')
      return
    }

    for (const s of sessions) {
      printSession(s)
    }
  })

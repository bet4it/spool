export type SessionSource = 'claude' | 'codex' | 'gemini' | 'antigravity' | 'opencode' | 'grok'
export type Source = SessionSource
export type SearchMatchType = 'fts' | 'phrase' | 'all_terms'

/**
 * One tool invocation captured from a transcript.
 *
 * `name` is the only guaranteed field — every provider records it, and
 * pre-existing rows indexed before tool detail was captured have
 * nothing else. The payload fields are clamped at parse time (see
 * parsers/tool-calls.ts); `inputTruncated` / `resultTruncated` mark
 * where that happened so the detail view can label the cut instead of
 * presenting a truncated payload as complete.
 */
export interface ToolCall {
  name: string
  /** Provider call id, used to pair a call with its result across
   *  messages (Claude/Codex split them). Absent when the provider
   *  stores the call and its output together (OpenCode). */
  id?: string
  input?: string
  result?: string
  inputTruncated?: boolean
  resultTruncated?: boolean
  /** True when the provider flagged the result as a failure. */
  isError?: boolean
}

export interface ParsedMessage {
  uuid: string
  parentUuid: string | null
  role: 'user' | 'assistant' | 'system'
  contentText: string
  timestamp: string
  isSidechain: boolean
  toolNames: string[]
  seq: number
  /** Structured detail behind `toolNames`. Same order as `toolNames`
   *  when the provider gives us both; omitted entirely when the
   *  provider exposes no detail. */
  toolCalls?: ToolCall[]
  /** Model reasoning/thinking text for this turn, when the provider
   *  records it in plaintext. Claude and Codex both also emit
   *  encrypted/empty reasoning blocks, which parsers drop. */
  thinking?: string
}

export interface ParsedSession {
  source: SessionSource
  sessionUuid: string
  parentSessionUuid?: string | null
  filePath: string
  title: string
  cwd: string
  model: string
  startedAt: string
  endedAt: string
  messages: ParsedMessage[]
}

export type ParseSessionResult =
  | { kind: 'parsed'; session: ParsedSession }
  | { kind: 'filtered' }
  | { kind: 'skipped' }

export interface Session {
  id: number
  projectId: number
  sourceId: number
  sessionUuid: string
  parentSessionUuid: string | null
  filePath: string
  title: string | null
  startedAt: string
  endedAt: string
  messageCount: number
  hasToolUse: boolean
  cwd: string | null
  model: string | null
  source: SessionSource
  projectDisplayPath: string
  projectDisplayName: string
  /** Denormalised count of active findings (any severity) for this
   *  session. 0 when the session has been scanned and is clean, or
   *  when scan has not yet run on it. Drives the Library row badge. */
  scanFindingCount: number
  /** Subset of scanFindingCount limited to HIGH_SEVERITY_KINDS. */
  scanHighCount: number
  /** Lifetime count of purged findings on this session. Combined with
   *  scanFindingCount === 0 and a non-null scanCompletedAt, lets the
   *  Library row show an "all-resolved" check instead of an empty slot. */
  scanPurgedCount: number
  /** ISO timestamp the worker last finished scanning this session.
   *  null when never scanned. */
  scanCompletedAt: string | null
}

export type ProjectIdentityKind =
  | 'git_remote'
  | 'git_common_dir'
  | 'manifest_path'
  | 'synthetic'
  | 'path'
  | 'loose'
  | 'spool_internal'

export interface ProjectIdentity {
  kind: ProjectIdentityKind
  key: string                       // normalized origin URL / abs path / 'loose'
  displayName: string
  // Optional override for the project row's display_path. Used by synthetic
  // identities to publish a stable header path (e.g. "~/Documents/Codex")
  // instead of leaking the per-session scratch dir of whichever chat was
  // synced first.
  displayPath?: string
}

export interface ProjectGroup {
  identityKind: ProjectIdentityKind
  identityKey: string
  displayName: string
  sources: SessionSource[]          // unique sources contributing
  sessionCount: number
  lastSessionAt: string | null
}

// Filesystem paths stay out of the base type so app IPC payloads don't carry
// every distinct cwd on each sidebar refetch; only the CLI query resolver
// needs them (listProjectGroups with { withPaths: true }).
export interface ProjectGroupWithPaths extends ProjectGroup {
  displayPaths: string[]            // distinct project display_path values
  cwds: string[]                    // distinct session cwd values
}

export interface Message {
  id: number
  sessionId: number
  msgUuid: string | null
  parentUuid: string | null
  role: 'user' | 'assistant' | 'system'
  contentText: string
  timestamp: string
  isSidechain: boolean
  toolNames: string[]
  seq: number
  /** See ParsedMessage.toolCalls. Empty for rows indexed before the
   *  schema carried tool detail — the UI falls back to the name-only
   *  chip rendering for those. */
  toolCalls: ToolCall[]
  thinking: string | null
}

export interface FragmentResult {
  rank: number
  sessionId: number
  sessionUuid: string
  sessionTitle: string
  matchCount: number
  matchType: SearchMatchType
  source: SessionSource
  profileLabel?: string
  cwd?: string
  project: string
  startedAt: string
  snippet: string
  messageId: number
  messageRole: string
  messageTimestamp: string
}

export interface StatusInfo {
  dbPath: string
  totalSessions: number
  claudeSessions: number
  codexSessions: number
  geminiSessions: number
  antigravitySessions: number
  opencodeSessions: number
  grokSessions: number
  lastSyncedAt: string | null
  dbSizeBytes: number
}

export interface SyncResult {
  added: number
  updated: number
  errors: number
}

// ── Search ──────────────────────────────────────────────────────────────────

export type SearchResult = FragmentResult & { kind: 'fragment' }

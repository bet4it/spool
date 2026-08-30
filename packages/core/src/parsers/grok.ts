import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { closeSync, openSync, readSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { ParseSessionResult, ParsedSession, ParsedMessage, ToolCall as ParsedToolCall } from '../types.js'
import { limitToolCalls, makeToolCall } from './tool-calls.js'

// v6: subagent* sessions are no longer dropped wholesale — they resolve
// their parent via the parent session's subagents/<id>/meta.json and fold
// under it, so a re-index is needed to recover already-filtered sessions.
export const GROK_INDEX_VERSION = 'grok-v6-subagent-tree'

// ── On-disk types ───────────────────────────────────────────────────────────
// These mirror the ConversationItem enum in grok-build's
// xai-grok-sampling-types/src/conversation.rs. Only the fields Spool
// needs are typed; unknown fields are ignored (serde-style forward compat).

interface ContentPart {
  type: string
  text?: string
  url?: string
}

interface ToolCall {
  id: string
  name: string
  arguments?: string
}

interface ChatHistoryItem {
  type: 'system' | 'user' | 'assistant' | 'tool_result' | 'reasoning' | 'backend_tool_call'
  content?: string | ContentPart[]
  tool_calls?: ToolCall[]
  synthetic_reason?: string
  tool_call_id?: string
  model_id?: string
}

interface GrokSummary {
  info?: { id?: string; cwd?: string }
  created_at?: string
  updated_at?: string
  last_active_at?: string
  current_model_id?: string
  generated_title?: string
  session_summary?: string
  agent_name?: string
  hidden?: boolean
  /** Parent session for forks/resumes (`Summary.parent_session_id` in
   *  grok-build). Written for `fork`, `worktree`, and `subagent_*`
   *  session kinds; absent on fresh sessions. */
  parent_session_id?: string | null
  /** What created this session (`Summary.session_kind`): "fork",
   *  "worktree", "subagent", "subagent_fork", "subagent_resume", etc. */
  session_kind?: string | null
}

/** `SubagentSessionMetadata` in grok-build's persistence.rs. */
interface GrokSubagentMeta {
  child_session_id?: string
  parent_session_id?: string
  description?: string
  status?: string
}

interface CompactionRequest {
  schema_version?: number
  created_at?: string
  trigger?: string
  chat_history?: ChatHistoryItem[]
}

const READ_CHUNK_SIZE = 1024 * 1024

/**
 * Load a Grok Build session from its `chat_history.jsonl` file.
 *
 * Grok Build stores sessions at:
 *   ~/.grok/sessions/{url_encoded_cwd}/{session_id}/chat_history.jsonl
 *
 * The JSONL uses a tagged-union `ConversationItem` format (see
 * xai-grok-sampling-types). Each line is one of:
 *   system, user, assistant, tool_result, reasoning, backend_tool_call
 *
 * Synthetic messages (project instructions, system reminders, etc.) are
 * filtered out so only real user/assistant exchanges are indexed.
 */
export function loadGrokSession(filePath: string): ParseSessionResult {
  const sessionDir = dirname(filePath)

  // ── Read summary.json for metadata ──────────────────────────────────
  let summary: GrokSummary = {}
  const summaryPath = join(sessionDir, 'summary.json')
  try {
    if (existsSync(summaryPath)) {
      summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as GrokSummary
    }
  } catch {
    // Malformed or missing summary — fall back to defaults from file path.
  }

  // Skip explicitly hidden sessions. Unlike grok-build's own listing,
  // subagent* kinds stay indexable: Spool folds them under their parent
  // session instead of hiding them.
  if (summary.hidden === true) {
    return { kind: 'filtered' }
  }

  const sessionUuid = summary.info?.id ?? basename(sessionDir)
  const cwd = summary.info?.cwd ?? ''
  const sessionKind = summary.session_kind ?? ''

  // Groups forks, worktrees, and subagent sessions under their source
  // session. Only trust non-empty values: grok-build's remote-registry
  // sessions can stamp placeholder IDs for parents that never existed
  // locally, and an empty string would otherwise claim a '' parent.
  let parentSessionUuid =
    typeof summary.parent_session_id === 'string' && summary.parent_session_id.length > 0
      ? summary.parent_session_id
      : null

  // Plain `subagent` sessions carry no parent_session_id — grok-build
  // records the linkage only in the parent's
  // subagents/<child_id>/meta.json. Read it from there so these children
  // fold under their parent like forks do.
  if (!parentSessionUuid && sessionKind.startsWith('subagent')) {
    parentSessionUuid = readSubagentParentId(sessionDir, sessionUuid)
  }

  // ── Parse chat_history.jsonl ─────────────────────────────────────────
  // Grok's auto-compaction rewrites chat_history.jsonl in place, replacing
  // the earlier turns with a "This session is being continued…" synthetic
  // message. The pre-compaction context survives in
  // compaction_requests/<id>.json (the exact payload sent to the
  // summarizer). Prepend those segments ahead of the live file so the
  // full history is indexed; they're chronological segments, not
  // supersets, so overlap only happens where compaction interrupted a
  // turn that then re-appears in the live tail.
  const liveItems = [...readNonEmptyLines(filePath)]
    .map(parseChatHistoryLine)
    .filter((item): item is ChatHistoryItem => item !== null)

  const items = buildGrokTimeline(sessionDir, liveItems)

  const messages: ParsedMessage[] = []
  // tool_call_id → the ToolCall already attached to an assistant
  // message, so a later `tool_result` item can fill in its output.
  const pendingToolCalls = new Map<string, ParsedToolCall>()

  for (const item of items) {
    const { type } = item

    if (type === 'user') {
      // Skip synthetic messages (project instructions, system reminders,
      // auto-continue, interjections, etc.) — they're not real user input
      // and would pollute search and titles.
      if (item.synthetic_reason) continue

      const rawText = extractUserText(item.content)
      if (!isRealUserText(rawText)) continue
      // Strip Grok's XML-like wrapper tags so the indexed text is the
      // actual user query, not the surrounding runtime scaffolding.
      const text = stripGrokWrapperTags(rawText)
      if (text) {
        messages.push({
          uuid: `grok-${sessionUuid}-u-${messages.length}`,
          parentUuid: null,
          role: 'user',
          contentText: text,
          timestamp: '', // filled below from summary timestamps
          isSidechain: false,
          toolNames: [],
          seq: messages.length,
        })
      }
      continue
    }

    if (type === 'assistant') {
      const text = (typeof item.content === 'string' ? item.content : '').trim()
      const toolNames = (item.tool_calls ?? [])
        .map(tc => tc.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
      const toolCalls = limitToolCalls((item.tool_calls ?? [])
        .filter(tc => typeof tc.name === 'string' && tc.name.length > 0)
        .map(tc => makeToolCall({ name: tc.name, id: tc.id, input: tc.arguments })))

      if (text || toolNames.length > 0) {
        // Results arrive as later `tool_result` items keyed by
        // tool_call_id; register the calls so they can be filled in.
        for (const call of toolCalls) {
          if (call.id) pendingToolCalls.set(call.id, call)
        }
        messages.push({
          uuid: `grok-${sessionUuid}-a-${messages.length}`,
          parentUuid: null,
          role: 'assistant',
          contentText: text,
          timestamp: '',
          isSidechain: false,
          toolNames,
          seq: messages.length,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        })
      }
      continue
    }

    if (type === 'tool_result') {
      // Index tool results as sidechain messages for FTS richness, matching
      // how the codex parser treats response_items. Keeps the main
      // conversation list clean while making tool output searchable.
      const rawText = (typeof item.content === 'string' ? item.content : '').trim()
      // Strip Grok's <workspace_result workspace_path="..."> wrapper so
      // the indexed/displayed text is just the tool output, not the
      // surrounding tag. The workspace_path is already known from the
      // session cwd.
      const text = stripWorkspaceResultWrapper(rawText)
      // Fold the payload into the assistant message's call detail, in
      // addition to the sidechain row kept below for FTS.
      const pending = item.tool_call_id ? pendingToolCalls.get(item.tool_call_id) : undefined
      if (pending && text) {
        const filled = makeToolCall({ name: pending.name, result: text })
        if (filled.result) pending.result = filled.result
        if (filled.resultTruncated) pending.resultTruncated = true
        pendingToolCalls.delete(item.tool_call_id!)
      }
      if (text) {
        messages.push({
          uuid: `grok-${sessionUuid}-t-${messages.length}`,
          parentUuid: null,
          role: 'system',
          contentText: text,
          timestamp: '',
          isSidechain: true,
          toolNames: [],
          seq: messages.length,
        })
      }
      continue
    }

    // system / reasoning / backend_tool_call are not indexed — system prompts
    // are identical across sessions (noise), reasoning is encrypted/empty,
    // and backend_tool_calls are server-side summaries.
  }

  if (messages.length === 0) return { kind: 'skipped' }

  // ── Timestamps ─────────────────────────────────────────────────────────
  // chat_history.jsonl lines don't carry per-message timestamps. Use the
  // summary's created_at / last_active_at / updated_at as session bounds.
  // Individual messages get monotonic timestamps spaced 1s apart so sort
  // order is stable within a session.
  const startedAt = summary.last_active_at ?? summary.updated_at ?? summary.created_at ?? new Date().toISOString()
  const endedAt = summary.updated_at ?? startedAt

  const baseTime = new Date(summary.created_at ?? startedAt).getTime()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    msg.timestamp = new Date(baseTime + i * 1000).toISOString()
  }

  // ── Title ───────────────────────────────────────────────────────────────
  const firstUserMsg = messages.find(m => m.role === 'user' && !m.isSidechain)
  const title = summary.generated_title
    ?? summary.session_summary
    ?? firstUserMsg?.contentText.slice(0, 120)
    ?? '(no title)'

  return {
    kind: 'parsed',
    session: {
      source: 'grok',
      sessionUuid,
      parentSessionUuid,
      filePath,
      title,
      cwd,
      model: summary.current_model_id ?? summary.agent_name ?? '',
      startedAt,
      endedAt,
      messages,
    },
  }
}

/**
 * Resolve a plain `subagent` session's parent by reading its
 * `subagents/<session_id>/meta.json` under the session's encoded-cwd
 * sibling directories. Grok-build writes the child→parent linkage only
 * there (the child's own summary.json has no parent_session_id).
 *
 * `<grokHome>/sessions/<encoded>/<parent>/subagents/<id>/meta.json`:
 * ```json
 * { "child_session_id": "...", "parent_session_id": "...", ... }
 * ```
 */
function readSubagentParentId(sessionDir: string, sessionUuid: string): string | null {
  const sessionsRoot = dirname(dirname(sessionDir)) // …/sessions
  let encodedDirs: string[]
  try {
    encodedDirs = readdirSync(sessionsRoot)
  } catch {
    return null
  }
  // The meta.json lives under the parent session's own directory, one
  // level below the encoded-cwd dir — scan both levels.
  for (const encoded of encodedDirs) {
    const projectDir = join(sessionsRoot, encoded)
    let sessionDirs: string[]
    try {
      sessionDirs = readdirSync(projectDir)
    } catch {
      continue
    }
    for (const dir of sessionDirs) {
      let meta: GrokSubagentMeta
      try {
        meta = JSON.parse(
          readFileSync(join(projectDir, dir, 'subagents', sessionUuid, 'meta.json'), 'utf8'),
        ) as GrokSubagentMeta
      } catch {
        continue
      }
      const parent = meta.parent_session_id
      if (typeof parent === 'string' && parent.length > 0) return parent
    }
  }
  return null
}

function extractUserText(content: string | ContentPart[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content.trim()
  return content
    .filter(part => part.type === 'text' && part.text)
    .map(part => part.text!)
    .join('\n')
    .trim()
}

/**
 * True for user text that represents a real turn. Rejects Grok's
 * compaction scaffolding: the summarize instruction that closes every
 * compaction request payload and the "continued from a previous
 * conversation" summary that opens post-compaction context. Both carry
 * `synthetic_reason: null` in request files, so they must be filtered
 * by text, unlike the system_reminder items which self-drop.
 */
function isRealUserText(rawText: string): boolean {
  if (!rawText) return false
  return !SUMMARIZE_INSTRUCTION_PREFIXES.some(prefix =>
    rawText.startsWith(prefix),
  )
}

const SUMMARIZE_INSTRUCTION_PREFIXES = [
  'Your task is to produce a faithful, concise summary',
  'This session is being continued from a previous conversation',
]

function parseChatHistoryLine(line: string): ChatHistoryItem | null {
  try {
    return JSON.parse(line) as ChatHistoryItem
  } catch {
    return null
  }
}

/** Cuts a compaction request payload down to the turns that actually
 *  happened: drops the leading preamble (system prompt, user_info,
 *  system reminders — the latter two already self-drop downstream) and
 *  the trailing summarize instruction. */
function stripCompactionRequestEdges(items: ChatHistoryItem[]): ChatHistoryItem[] {
  let start = 0
  while (start < items.length) {
    const it = items[start]!
    if (it.type === 'system') { start++; continue }
    if (it.type === 'user' && it.synthetic_reason) { start++; continue }
    if (it.type === 'user' && !isRealUserText(extractUserText(it.content))) { start++; continue }
    break
  }
  let end = items.length
  while (end > start) {
    const it = items[end - 1]!
    if (it.type === 'user' && !isRealUserText(extractUserText(it.content))) { end--; continue }
    break
  }
  return items.slice(start, end)
}

/** Loads all `compaction_requests/*.json` payloads for the session,
 *  oldest first, trimmed of their preamble/summarize-instruction edges.
 *  Returns [] when the session was never compacted. */
function loadCompactionSegments(sessionDir: string): ChatHistoryItem[][] {
  const dir = join(sessionDir, 'compaction_requests')
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }

  const segments: Array<{ createdAt: number, items: ChatHistoryItem[] }> = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    let req: CompactionRequest
    try {
      req = JSON.parse(readFileSync(join(dir, file), 'utf8')) as CompactionRequest
    } catch {
      continue
    }
    if (!Array.isArray(req.chat_history) || req.chat_history.length === 0) continue
    const createdAt = Date.parse(req.created_at ?? '') || 0
    segments.push({ createdAt, items: req.chat_history })
  }

  // Chronological order by created_at. Segments are snapshots of
  // consecutive context windows, not supersets, so they never overlap
  // each other — only the live tail can (see buildGrokTimeline).
  segments.sort((a, b) => a.createdAt - b.createdAt)
  return segments.map(seg => stripCompactionRequestEdges(seg.items))
}

/**
 * Full indexed timeline: pre-compaction segments followed by the live
 * file. The one overlap between the last segment and the live tail is
 * the turn compaction interrupted: its query is the last real user
 * item of the request payload and is re-sent verbatim as the first
 * real query of the post-compaction file (the turn's tool results are
 * NOT replayed — live re-executes them — so they're kept from the
 * segment). Drop the duplicated query only when the two texts match,
 * so a repeated question later in the session is never lost.
 */
function buildGrokTimeline(sessionDir: string, live: ChatHistoryItem[]): ChatHistoryItem[] {
  const segments = loadCompactionSegments(sessionDir)
  if (segments.length === 0) return live

  const lastSeg = segments[segments.length - 1]!
  const segQueryIndex = findLastRealUserQueryIndex(lastSeg)
  const seamIsReplayed = segQueryIndex >= 0
    && realUserQueryText(lastSeg[segQueryIndex]!) === firstRealUserQueryText(live)

  const kept: ChatHistoryItem[] = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    const isLast = i === segments.length - 1
    for (let j = 0; j < seg.length; j++) {
      const item = seg[j]!
      if (isLast && seamIsReplayed && j === segQueryIndex) continue
      kept.push(item)
    }
  }

  return [...kept, ...live]
}

/** Stripped text of a real (non-synthetic, non-compaction) user query. */
function realUserQueryText(item: ChatHistoryItem): string | null {
  if (item.type !== 'user' || item.synthetic_reason) return null
  const text = stripGrokWrapperTags(extractUserText(item.content))
  return text && isRealUserText(text) ? text : null
}

function findLastRealUserQueryIndex(items: ChatHistoryItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (realUserQueryText(items[i]!) !== null) return i
  }
  return -1
}

function firstRealUserQueryText(items: ChatHistoryItem[]): string | null {
  for (const item of items) {
    const text = realUserQueryText(item)
    if (text) return text
  }
  return null
}

/**
 * Strip Grok Build's XML-like wrapper tags from user messages.
 *
 * Grok wraps user input in tags like `<user_info>…</user_info>` and
 * `<user_query>…</user_query>`. The `<user_query>` content is the real
 * user input; `<user_info>`, `<git_status>`, `<rules>`, and
 * `<system-reminder>` are runtime scaffolding. We extract the
 * `<user_query>` body when present, otherwise strip known wrapper tags
 * from the text.
 */
function stripGrokWrapperTags(text: string): string {
  if (!text) return ''

  // If the message contains a <user_query> block, extract just that —
  // it's the actual user question, and the surrounding <user_info> /
  // <rules> / <system-reminder> content is runtime scaffolding.
  const queryMatch = text.match(/<user_query>\s*([\s\S]*?)<\/user_query>/)
  if (queryMatch) {
    return queryMatch[1]!.trim()
  }

  // Otherwise strip known wrapper tags but keep the inner text.
  const wrapperTags = ['user_info', 'git_status', 'rules', 'system-reminder']
  let result = text
  for (const tag of wrapperTags) {
    const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g')
    result = result.replace(re, '')
  }
  return result.trim()
}

/**
 * Strip Grok's `<workspace_result workspace_path="…">…</workspace_result>`
 * wrapper from tool result text, leaving just the output content.
 *
 * Grok wraps tool output (grep, list_dir, etc.) in this tag. The
 * `workspace_path` attribute duplicates the session cwd and adds no
 * value in the detail view.
 */
function stripWorkspaceResultWrapper(text: string): string {
  if (!text) return ''
  const match = text.match(
    /<workspace_result[^>]*>\s*([\s\S]*?)<\/workspace_result>/,
  )
  if (match) {
    return match[1]!.trim()
  }
  return text
}

export function parseGrokSession(filePath: string): ParsedSession | null {
  try {
    const result = loadGrokSession(filePath)
    return result.kind === 'parsed' ? result.session : null
  } catch {
    return null
  }
}

// ── Session directory helpers ───────────────────────────────────────────────
// Grok Build encodes the cwd as a URL-encoded directory name under
// ~/.grok/sessions/. Long paths (>255 bytes encoded) use a slug-hash form
// with a .cwd metadata file. See grok-build's xai-grok-config/src/paths.rs.

export function decodeGrokCwdDirname(dir: string): string | null {
  const name = basename(dir)
  // Try URL-decoding first (short paths).
  try {
    const decoded = decodeURIComponent(name)
    // URL-decoded absolute cwds start with '/' (Unix) or a drive
    // letter (Windows); the slug-hash form never does.
    if (decoded.startsWith('/') || (decoded.length > 1 && decoded[1] === ':')) {
      return decoded
    }
  } catch {
    // Invalid encoding — fall through to .cwd file.
  }

  // Hash-based encoding: read the .cwd metadata file.
  try {
    const cwdFile = join(dir, '.cwd')
    if (existsSync(cwdFile)) {
      return readFileSync(cwdFile, 'utf8').trim()
    }
  } catch {
    // ignore
  }
  return null
}

// ── Streaming line reader (same pattern as codex.ts) ────────────────────────
function* readNonEmptyLines(filePath: string): Iterable<string> {
  const fd = openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(READ_CHUNK_SIZE)
  const decoder = new StringDecoder('utf8')
  let pending = ''

  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break

      pending += decoder.write(buffer.subarray(0, bytesRead))
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''

      for (const line of lines) {
        if (line.trim().length > 0) yield line
      }
    }

    pending += decoder.end()
    if (pending.trim().length > 0) yield pending
  } finally {
    closeSync(fd)
  }
}

// ── Grok home resolution ────────────────────────────────────────────────────

export function getGrokHome(): string {
  const configured = process.env['GROK_HOME']?.trim()
  if (configured) return configured
  return join(homedir(), '.grok')
}

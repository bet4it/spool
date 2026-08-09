import { readFileSync, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { closeSync, openSync, readSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { ParseSessionResult, ParsedSession, ParsedMessage } from '../types.js'

export const GROK_INDEX_VERSION = 'grok-v1-chat-history-jsonl'

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

  // Skip hidden sessions (worktree forks, subagent scratchpads).
  if (summary.hidden === true) return { kind: 'filtered' }

  const sessionUuid = summary.info?.id ?? basename(sessionDir)
  const cwd = summary.info?.cwd ?? ''

  // ── Parse chat_history.jsonl ─────────────────────────────────────────
  const messages: ParsedMessage[] = []

  for (const line of readNonEmptyLines(filePath)) {
    let item: ChatHistoryItem
    try {
      item = JSON.parse(line) as ChatHistoryItem
    } catch {
      continue
    }

    const { type } = item

    if (type === 'user') {
      // Skip synthetic messages (project instructions, system reminders,
      // auto-continue, interjections, etc.) — they're not real user input
      // and would pollute search and titles.
      if (item.synthetic_reason) continue

      const rawText = extractUserText(item.content)
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

      if (text || toolNames.length > 0) {
        messages.push({
          uuid: `grok-${sessionUuid}-a-${messages.length}`,
          parentUuid: null,
          role: 'assistant',
          contentText: text,
          timestamp: '',
          isSidechain: false,
          toolNames,
          seq: messages.length,
        })
      }
      continue
    }

    if (type === 'tool_result') {
      // Index tool results as sidechain messages for FTS richness, matching
      // how the codex parser treats response_items. Keeps the main
      // conversation list clean while making tool output searchable.
      const text = (typeof item.content === 'string' ? item.content : '').trim()
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
 * Strip Grok Build's XML-like wrapper tags from user messages.
 *
 * Grok wraps user input in tags like `<user_info>…</user_info>` and
 * `<user_query>…</user_query>`. The `<user_query>` content is the real
 * user input; `<user_info>` is OS/shell/workspace metadata. We extract
 * the `<user_query>` body when present, otherwise strip known wrapper
 * tags from the text.
 */
function stripGrokWrapperTags(text: string): string {
  if (!text) return ''

  // If the message contains a <user_query> block, extract just that —
  // it's the actual user question, and the surrounding <user_info> /
  // <system-reminder> content is runtime scaffolding.
  const queryMatch = text.match(/<user_query>\s*([\s\S]*?)<\/user_query>/)
  if (queryMatch) {
    return queryMatch[1]!.trim()
  }

  // Otherwise strip known wrapper tags but keep the inner text.
  const wrapperTags = ['user_info', 'git_status', 'system-reminder']
  let result = text
  for (const tag of wrapperTags) {
    const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g')
    result = result.replace(re, '')
  }
  return result.trim()
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

import { readFileSync } from 'node:fs'
import type { ParseSessionResult, ParsedSession, ParsedMessage, ToolCall } from '../types.js'
import { limitToolCalls, makeToolCall, normalizeThinking } from './tool-calls.js'

interface ContentItem {
  type: string
  text?: string
  thinking?: string
  name?: string
  id?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

export function loadClaudeSession(filePath: string): ParseSessionResult {
  const raw = readFileSync(filePath, 'utf8')
  const lines = raw.split('\n').filter(l => l.trim().length > 0)
  const messages: ParsedMessage[] = []
  let sessionUuid = ''
  let cwd = ''
  let model = ''
  let customTitle = ''
  // tool_use id → the ToolCall object already attached to an emitted
  // message, so a later tool_result record can fill in its output by
  // mutating in place.
  const pendingToolCalls = new Map<string, ToolCall>()

  const SKIP_TYPES = new Set([
    'file-history-snapshot',
    'progress',
    'queue-operation',
    'last-prompt',
  ])

  for (const line of lines) {
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    const type = record['type'] as string | undefined
    if (!type || SKIP_TYPES.has(type)) continue

    if (!sessionUuid && record['sessionId']) sessionUuid = record['sessionId'] as string
    if (!cwd && record['cwd']) cwd = record['cwd'] as string

    if (type === 'custom-title') {
      const ct = record['customTitle'] as string | undefined
      if (ct) customTitle = ct
      continue
    }

    if (type === 'assistant') {
      const msg = record['message'] as Record<string, unknown> | undefined
      if (msg?.['model']) model = msg['model'] as string
    }

    if (type === 'summary') {
      const summaryText = record['summary'] as string | undefined
      if (summaryText) {
        messages.push({
          uuid: (record['uuid'] as string | undefined) ?? `summary-${messages.length}`,
          parentUuid: (record['parentUuid'] as string | null | undefined) ?? null,
          role: 'system',
          contentText: summaryText.trim(),
          timestamp: record['timestamp'] as string,
          isSidechain: Boolean(record['isSidechain']),
          toolNames: [],
          seq: messages.length,
        })
      }
      continue
    }

    const msgObj = record['message'] as Record<string, unknown> | undefined
    if (!msgObj) continue

    const role = msgObj['role'] as string | undefined
    if (role !== 'user' && role !== 'assistant') continue

    const contentRaw = msgObj['content']
    const contentText = extractText(contentRaw)
    const toolNames = extractToolNames(contentRaw)
    const toolCalls = extractToolCalls(contentRaw)
    const thinking = extractThinking(contentRaw)

    // Claude splits a tool invocation across two records: the assistant
    // message carries `tool_use`, and the *next* user message carries the
    // matching `tool_result`. Register each call by id so the result can
    // be folded back into the assistant message it belongs to, then
    // apply any results this record carries.
    for (const call of toolCalls) {
      if (call.id) pendingToolCalls.set(call.id, call)
    }
    applyToolResults(contentRaw, pendingToolCalls)

    // Skip empty messages (e.g. tool result placeholders with no text).
    // These are still worth walking for their results above — the
    // payload lands on the assistant message that made the call.
    if (!contentText && toolNames.length === 0 && !thinking) continue

    messages.push({
      uuid: (record['uuid'] as string | undefined) ?? `msg-${messages.length}`,
      parentUuid: (record['parentUuid'] as string | null | undefined) ?? null,
      role: role as 'user' | 'assistant',
      contentText,
      timestamp: record['timestamp'] as string,
      isSidechain: Boolean(record['isSidechain']),
      toolNames,
      seq: messages.length,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(thinking ? { thinking } : {}),
    })
  }

  if (messages.length === 0) return { kind: 'skipped' }

  // Use cwd from messages if not in top-level fields
  if (!cwd) {
    for (const m of messages) {
      // cwd is on the record level, not message level — already captured above
    }
  }

  const firstUserMsg = messages.find(m => m.role === 'user' && m.contentText.length > 0 && !m.isSidechain)
  const title = customTitle
    || (firstUserMsg
      ? firstUserMsg.contentText.replace(/<[^>]+>/g, '').trim().slice(0, 120)
      : '(no title)')

  const timestamps = messages.map(m => m.timestamp).filter(Boolean).sort()

  return {
    kind: 'parsed',
    session: {
      source: 'claude',
      sessionUuid: sessionUuid || filePath,
      filePath,
      title,
      cwd,
      model,
      startedAt: timestamps[0] ?? new Date().toISOString(),
      endedAt: timestamps[timestamps.length - 1] ?? new Date().toISOString(),
      messages,
    },
  }
}

export function parseClaudeSession(filePath: string): ParsedSession | null {
  try {
    const result = loadClaudeSession(filePath)
    return result.kind === 'parsed' ? result.session : null
  } catch {
    return null
  }
}

// Slash-command records in Claude Code JSONL come as a triplet:
//   <command-name>/X</command-name>
//   <command-message>X</command-message>
//   <command-args>Y</command-args>
// Strip the whole record as one unit so bare <command-args> appearing in
// legitimate user content (e.g. a user pasting log output that contains
// these tags) is preserved.
const SLASH_COMMAND_RECORD = /<command-name>[\s\S]*?<\/command-name>(?:\s*<command-message>[\s\S]*?<\/command-message>)?(?:\s*<command-args>[\s\S]*?<\/command-args>)?/g

function extractText(content: unknown): string {
  let raw: string
  if (typeof content === 'string') {
    raw = content
  } else if (Array.isArray(content)) {
    raw = (content as ContentItem[])
      .filter(item => item.type === 'text')
      .map(item => item.text ?? '')
      .join('\n')
  } else {
    return ''
  }
  return raw
    .replace(/<spool-system-prelude>[\s\S]*?<\/spool-system-prelude>/g, '')
    .replace(SLASH_COMMAND_RECORD, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function extractToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return (content as ContentItem[])
    .filter(item => item.type === 'tool_use' && item.name)
    .map(item => item.name!)
}

/** Structured counterpart to extractToolNames — same items, but
 *  carrying the invocation payload for the detail view. */
function extractToolCalls(content: unknown): ToolCall[] {
  if (!Array.isArray(content)) return []
  const calls = (content as ContentItem[])
    .filter(item => item.type === 'tool_use' && item.name)
    .map(item => makeToolCall({ name: item.name!, id: item.id, input: item.input }))
  return limitToolCalls(calls)
}

/**
 * Fold `tool_result` blocks into the calls they answer.
 *
 * Results arrive on a later record than the call, so this mutates the
 * ToolCall already attached to the earlier message. An unmatched
 * result (call truncated out by MAX_TOOL_CALLS_PER_MESSAGE, or a
 * transcript whose head was rotated away) is dropped: without its
 * invocation there is nothing meaningful to show.
 */
function applyToolResults(content: unknown, pending: Map<string, ToolCall>): void {
  if (!Array.isArray(content)) return
  for (const item of content as ContentItem[]) {
    if (item.type !== 'tool_result') continue
    const id = item.tool_use_id
    if (!id) continue
    const call = pending.get(id)
    if (!call) continue
    // Result content is a bare string for most tools, but an array of
    // content blocks for tools that return images alongside text.
    // Reuse makeToolCall for the clamping rules, then copy the derived
    // fields across rather than duplicating the limit logic here.
    const filled = makeToolCall({
      name: call.name,
      result: Array.isArray(item.content) ? joinResultBlocks(item.content) : item.content,
      isError: item.is_error === true,
    })
    if (filled.result) call.result = filled.result
    if (filled.resultTruncated) call.resultTruncated = true
    if (filled.isError) call.isError = true
    // A tool_use id is answered exactly once; releasing it keeps the
    // map bounded on long sessions.
    pending.delete(id)
  }
}

/** Flatten a block-array tool_result into text.
 *
 *  Deliberately not `extractText`: that strips XML-ish tags and
 *  slash-command wrappers to keep the FTS index clean, which would
 *  corrupt tool output — a `Read` of an HTML file or a grep hit
 *  containing `<div>` must survive verbatim in the detail view.
 *  Non-text blocks (images) are named rather than inlined. */
function joinResultBlocks(blocks: unknown[]): string {
  return (blocks as ContentItem[])
    .map(block => {
      if (block?.type === 'text') return block.text ?? ''
      return block?.type ? `[${block.type}]` : ''
    })
    .filter(chunk => chunk.length > 0)
    .join('\n')
}

/** Concatenated plaintext of a turn's thinking blocks.
 *
 *  Claude emits a `thinking` block for every extended-thinking turn but
 *  leaves `thinking` empty when the content is server-side encrypted
 *  (only `signature` is present) — roughly half of them in practice.
 *  Those collapse to undefined so the UI shows no affordance rather
 *  than an empty disclosure. */
function extractThinking(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const text = (content as ContentItem[])
    .filter(item => item.type === 'thinking')
    .map(item => item.thinking ?? '')
    .filter(chunk => chunk.trim().length > 0)
    .join('\n\n')
  return normalizeThinking(text)
}

/** Decode a Claude project slug to a display path.
 *  e.g. '-Users-claw-code-spool' → '/Users/claw/code/spool'
 *  Note: lossy for paths containing hyphens — prefer cwd from session records.
 */
export function decodeProjectSlug(slug: string): string {
  if (!slug.startsWith('-')) return slug
  return '/' + slug.slice(1).replace(/-/g, '/')
}

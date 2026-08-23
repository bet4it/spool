import type { ToolCall } from '@spool-lab/core'

/**
 * One-line summaries for a collapsed tool row.
 *
 * The collapsed header has to answer "what did the agent actually do"
 * without being opened, and the useful field differs per tool: a Read
 * is its path, a Bash is its command, a Grep is its pattern. Dumping
 * raw JSON there is unreadable, so each known tool names the field
 * worth surfacing and everything else falls back to the first
 * non-empty string in the payload.
 *
 * Adapted from the equivalent dispatch in cc-session, extended with
 * the snake_case tool names Codex/OpenCode/Gemini use, the camelCase
 * names Grok Build uses, and the PascalCase names Antigravity CLI uses.
 */

/** Parse an MCP tool name: `mcp__server__tool` → server + tool. */
export function parseMcpToolName(
  name: string,
): { server: string; tool: string; display: string } | null {
  if (!name.startsWith('mcp__')) return null
  const parts = name.slice(5).split('__')
  if (parts.length < 2 || !parts[0]) return null
  const tool = parts.slice(1).join('__')
  if (!tool) return null
  return { server: parts[0], tool, display: tool.replace(/_/g, ' ') }
}

/** Label shown in the collapsed row — MCP names lose their prefix. */
export function toolDisplayName(name: string): string {
  return parseMcpToolName(name)?.display ?? name
}

/** Collapse `$HOME/...` to `~/...` so paths fit the one-line summary. */
function shortenHomePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, '~')
}

/**
 * Remove a single layer of surrounding double-quotes from a string value.
 *
 * Antigravity CLI wraps every string arg in an extra pair of JSON quotes
 * (`"\"/path/to/file\""`) — the value the model emits is already quoted,
 * and the transcript stores it double-wrapped. Without stripping, the
 * collapsed row shows `"/path/to/file"` instead of `/path/to/file`.
 */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}

function parseInput(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Extract a string field from a (possibly truncated) JSON string.
 * Handles both complete values (closing quote present) and truncated
 * values (closing quote cut off by the 4000-char limit).
 */
function extractJsonField(raw: string, field: string): string {
  // Try strict extraction first (closing quote present)
  const strictRe = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const strictMatch = strictRe.exec(raw)
  if (strictMatch) {
    return strictMatch[1]!
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  // Fallback: no closing quote — take everything after the field
  const looseRe = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)$`)
  const looseMatch = looseRe.exec(raw)
  if (looseMatch) {
    return looseMatch[1]!
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  return ''
}

/**
 * Parse input as JSON, falling back to regex-based field extraction
 * when truncation has broken the JSON structure. Only string fields
 * are recovered — arrays/objects/numbers are not.
 */
function parseInputLoose(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  const obj = parseInput(raw)
  if (obj) return obj
  const result: Record<string, unknown> = {}
  const fieldRe = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"/g
  let m: RegExpExecArray | null
  while ((m = fieldRe.exec(raw)) !== null) {
    const field = m[1]!
    const value = extractJsonField(raw, field)
    if (value) result[field] = value
  }
  return result
}

/** First non-empty string among `keys`, with surrounding quotes stripped. */
function firstString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.length > 0) return unquote(value)
  }
  return ''
}

/** Path-oriented variant of {@link firstString} that also shortens `$HOME`. */
function firstPath(obj: Record<string, unknown>, keys: string[]): string {
  const value = firstString(obj, keys)
  return value ? shortenHomePath(value) : ''
}

const PATH_KEYS = [
  'file_path', 'filePath', 'path', 'absolute_path', 'AbsolutePath',
  'TargetFile', 'target_file', 'target_directory',
]

/**
 * Extract a command string from Codex's `exec` custom tool input.
 *
 * Codex's `exec` tool records free-form JavaScript — typically
 * `const r = await Promise.all([ tools.exec_command({"cmd":"…"}), … ])`.
 * The parser expands multi-command exec calls into individual
 * `exec_command` ToolCall entries, so this function only runs for
 * single-command exec calls (or as a fallback). It pulls out the
 * `cmd` value from the embedded `exec_command` call.
 */
function extractCodexExecCommands(code: string): string {
  const re = /tools\.exec_command\s*\(\s*(\{(?:[^{}]|\{[^{}]*\})*\})\s*\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(code)) !== null) {
    try {
      const args = JSON.parse(match[1]!) as Record<string, unknown>
      if (typeof args['cmd'] === 'string' && args['cmd']) {
        return firstLine(args['cmd'])
      }
    } catch {
      // Malformed JSON inside the JS — skip.
    }
  }
  return ''
}

/**
 * Best one-line description of what a call did.
 *
 * Returns '' when nothing useful can be derived — callers should then
 * show the tool name alone rather than an empty summary slot.
 */
export function toolCallSummary(call: ToolCall): string {
  const obj = parseInputLoose(call.input)

  // Codex's apply_patch input is a raw patch, and Codex's `exec` custom
  // tool records JavaScript code that embeds exec_command calls. These
  // are not JSON — handle them before the switch.
  const canonical = parseMcpToolName(call.name)?.tool ?? call.name
  const lower = canonical.toLowerCase()
  if (lower === 'apply_patch') {
    const raw = (call.input ?? '').trim()
    const files = raw.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)
    if (files) {
      const paths = files.map(f => {
        const m = f.match(/: (.+)$/)
        return m ? shortenHomePath(m[1]!) : ''
      }).filter(Boolean)
      if (paths.length === 1) return paths[0]!
      if (paths.length > 1) return `${paths[0]} (+${paths.length - 1} more)`
    }
    return firstLine(raw)
  }
  if (lower === 'exec') {
    const raw = (call.input ?? '').trim()
    const cmds = extractCodexExecCommands(raw)
    if (cmds) return cmds
    return firstLine(raw)
  }

  // If the input was truncated and no fields could be extracted,
  // fall back to the first line of the raw text.
  if (Object.keys(obj).length === 0) {
    const raw = (call.input ?? '').trim()
    if (!raw) return ''
    return firstLine(raw)
  }

  switch (canonical.toLowerCase()) {
    // ── File reads / writes / edits ───────────────────────────────
    case 'read':
    case 'write':
    case 'edit':
    case 'multiedit':
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'replace':
    case 'search_replace':
    case 'view_file':
    case 'write_to_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return firstPath(obj, PATH_KEYS)
    // ── Shell / command execution ─────────────────────────────────
    case 'bash':
    case 'shell':
    case 'exec_command':
    case 'shell_command':
    case 'run_terminal_command':
    case 'run_command':
    case 'run_terminal_cmd':
    case 'write_stdin':
      return firstLine(firstString(obj, ['command', 'cmd', 'CommandLine', 'description']))
    // ── Directory listing ─────────────────────────────────────────
    case 'glob':
    case 'list_directory':
    case 'list_dir':
    case 'ls':
      return firstPath(obj, ['pattern', 'path', 'DirectoryPath', 'target_directory'])
    // ── Grep / search ─────────────────────────────────────────────
    case 'grep':
    case 'search_file_content':
    case 'ripgrep':
    case 'grep_search': {
      const pattern = firstString(obj, ['pattern', 'query', 'Query'])
      const path = firstString(obj, ['path', 'SearchPath'])
      return path ? `/${pattern}/ ${shortenHomePath(path)}` : `/${pattern}/`
    }
    // ── Task / agent ──────────────────────────────────────────────
    case 'task':
    case 'agent':
    case 'invoke_agent':
    case 'invoke_subagent':
    case 'call_omo_agent':
      return firstString(obj, ['description', 'agent_name', 'prompt'])
    // ── Web search / fetch ────────────────────────────────────────
    case 'websearch':
    case 'web_search':
    case 'google_web_search':
    case 'search_web':
      return firstString(obj, ['query', 'Query'])
    case 'webfetch':
    case 'web_fetch':
    case 'read_url_content':
    case 'fetch_url':
      return firstString(obj, ['url', 'Url', 'prompt'])
    // ── Todo ──────────────────────────────────────────────────────
    case 'todowrite':
    case 'todo_write':
      return todoSummary(obj)
    // ── Codex apply_patch (raw patch text, not JSON) ──────────────
    case 'apply_patch':
      return firstLine(firstString(obj, ['patch', 'input']))
    // ── Codex wait: polling a long-running exec cell, no useful summary ─
    case 'wait':
      return ''
    // ── Antigravity-specific tools ────────────────────────────────
    case 'ask_permission':
      return firstString(obj, ['Action', 'Target', 'Reason'])
    case 'schedule':
      return firstString(obj, ['Prompt', 'DurationSeconds'])
    case 'manage_task':
      return firstString(obj, ['Action', 'TaskId'])
    // ── User-facing questions ────────────────────────────────────
    case 'request_user_input':
    case 'ask_question':
    case 'question':
      return questionSummary(obj)
    // ── Subagent output retrieval (Grok) ──────────────────────────
    case 'get_command_or_subagent_output':
      return firstString(obj, ['task_ids', 'description'])
    default: {
      const first = Object.values(obj).find(
        (value) => typeof value === 'string' && value.length > 0,
      )
      return typeof first === 'string' ? firstLine(unquote(first)) : ''
    }
  }
}

/** TodoWrite carries a list, not a string — report progress instead. */
function todoSummary(obj: Record<string, unknown>): string {
  const todos = obj['todos']
  if (!Array.isArray(todos)) return ''
  const done = todos.filter(
    (todo) => (todo as { status?: string })?.status === 'completed',
  ).length
  return `${done}/${todos.length}`
}

/**
 * Summarize a user-facing question prompt.
 *
 * Codex's `request_user_input` has `{questions: [{header, question, options}]}`,
 * and Antigravity's `ask_question` has `{questions: [{question, options}]}`.
 * We surface the first question text so the collapsed row shows what was
 * being asked without needing to expand.
 */
function questionSummary(obj: Record<string, unknown>): string {
  const raw = obj['questions']
  // Antigravity may have a pre-parsed array, or the questions string
  // may already have been unwrapped by the parser.
  let questions: unknown[] | null = null
  if (Array.isArray(raw)) {
    questions = raw
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) questions = parsed
    } catch {
      // Not JSON — fall through
    }
  }
  if (!questions || questions.length === 0) return ''
  const first = questions[0] as Record<string, unknown> | undefined
  if (!first || typeof first !== 'object') return ''
  const question = typeof first['question'] === 'string' ? first['question'] : ''
  const header = typeof first['header'] === 'string' ? first['header'] : ''
  if (!question && !header) return ''
  return firstLine(header ? `${header}: ${question}` : question)
}

function firstLine(value: string): string {
  const line = value.split('\n', 1)[0] ?? ''
  return line.trim()
}

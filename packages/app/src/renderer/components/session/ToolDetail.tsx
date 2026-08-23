import type { ReactNode } from 'react'
import type { ToolCall } from '@spool-lab/core'
import { parseMcpToolName } from './toolSummary.js'

/**
 * Tool-specific expanded detail view.
 *
 * Replaces the old mechanical "INPUT: raw-json / RESULT: raw-text"
 * layout with purpose-built presentations: commands render as
 * readable shell lines, plans render as checklists, patches render as
 * diffs, and useless results ("Plan updated", "Success") are hidden.
 *
 * No "INPUT" / "RESULT" labels — the content speaks for itself.
 */

// ── Helpers ────────────────────────────────────────────────────────

/** Parse the input field as JSON if possible; return null otherwise. */
function tryParseInput(call: ToolCall): Record<string, unknown> | null {
  if (!call.input) return null
  try {
    const parsed: unknown = JSON.parse(call.input)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Extract a string field from a (possibly truncated) JSON string.
 *
 * When the input exceeds the 4000-char clamp, `JSON.parse` fails because
 * the string is cut mid-value. This regex-based fallback pulls out the
 * field directly from the raw text so truncated calls still render
 * with their key fields instead of falling back to raw JSON.
 */
function extractJsonStringField(raw: string, field: string): string {
  // Match "field": "value" — the value may contain escaped chars.
  // We stop at the closing quote that is not preceded by a backslash.
  const re = new RegExp(
    `"${field}"\\s*:\\s*"` +
    '((?:[^"\\\\]|\\\\.)*)' +
    '"',
  )
  const m = re.exec(raw)
  if (!m) return ''
  return m[1]!
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

/**
 * Extract a string field from a (possibly truncated) JSON string,
 * even when the closing quote was cut off by the 4000-char limit.
 *
 * Falls back to grabbing everything after `"field":"` until end of
 * string, which is the best we can do when truncation cuts mid-value.
 */
function extractJsonStringFieldLoose(raw: string, field: string): string {
  // Try the strict extractor first (closing quote present)
  const strict = extractJsonStringField(raw, field)
  if (strict) return strict
  // Fallback: no closing quote — take everything after the field
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)$`)
  const m = re.exec(raw)
  if (!m) return ''
  return m[1]!
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

/**
 * Parse the input as JSON, falling back to regex-based field extraction
 * when truncation has broken the JSON structure.
 *
 * Returns an object with whatever string fields could be extracted.
 * Non-string fields (numbers, booleans, arrays, objects) are not
 * recovered — this is a display fallback, not a full parser.
 */
function tryParseInputLoose(call: ToolCall): Record<string, unknown> {
  const obj = tryParseInput(call)
  if (obj) return obj
  const raw = call.input ?? ''
  if (!raw) return {}
  const result: Record<string, unknown> = {}
  // Extract all string fields present in the JSON
  const fieldRe = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"/g
  let m: RegExpExecArray | null
  while ((m = fieldRe.exec(raw)) !== null) {
    const field = m[1]!
    const value = extractJsonStringFieldLoose(raw, field)
    if (value) result[field] = value
  }
  return result
}

/** Strip surrounding quotes from a value (Antigravity double-wraps strings). */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}

/** The canonical tool name (MCP prefix stripped, lowercased for dispatch). */
function canonicalName(call: ToolCall): string {
  return (parseMcpToolName(call.name)?.tool ?? call.name).toLowerCase()
}

/**
 * Try to extract just the meaningful output from a result string,
 * stripping Codex's "Command: … / Chunk ID: … / Wall time: … / Output:" wrapper.
 */
function extractCommandOutput(result: string): string {
  const outputIdx = result.indexOf('\nOutput:\n')
  if (outputIdx >= 0) {
    return result.slice(outputIdx + '\nOutput:\n'.length)
  }
  return result
}

/** Collapse `$HOME/...` to `~/...`. */
function shortenHome(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, '~')
}

// ── Result suppression ─────────────────────────────────────────────

/** Results that carry no information beyond "it worked". */
const USELESS_RESULT_PATTERNS = [
  /^Plan updated\.?$/i,
  /^Success\.?\s*$/i,
  /^\{"output":"Success\./i,
  /^\{"output":""\}$/i,
  /^No changes needed\.?$/i,
  /^Done\.?\s*$/i,
]

/** True when the result is a no-op confirmation that adds no value. */
function isUselessResult(call: ToolCall): boolean {
  if (!call.result || call.isError) return false
  const trimmed = call.result.trim()
  if (!trimmed) return true
  return USELESS_RESULT_PATTERNS.some(re => re.test(trimmed))
}

// ── Shared UI primitives ───────────────────────────────────────────

/** A scrollable monospace block for output / code / raw text. */
function CodeBlock({ children, maxHeight = '16rem' }: { children: ReactNode; maxHeight?: string }) {
  return (
    <pre
      className="overflow-auto whitespace-pre-wrap break-words rounded bg-warm-surface2 dark:bg-dark-surface2 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-warm-text dark:text-dark-text"
      style={{ maxHeight }}
    >
      {children}
    </pre>
  )
}

/** Small italic note for truncated / error indicators. */
function Note({ children }: { children: ReactNode }) {
  return (
    <div className="text-[10px] italic text-warm-faint dark:text-dark-muted">
      {children}
    </div>
  )
}

// ── Per-tool renderers ─────────────────────────────────────────────

interface DetailProps {
  call: ToolCall
}

/** Shell commands: `$ command` on top, justification below, output at bottom. */
function ShellCommandDetail({ call }: DetailProps) {
  const obj = tryParseInputLoose(call)
  const isWriteStdin = canonicalName(call) === 'write_stdin'

  // write_stdin has no `cmd` field — its input is {session_id, chars}.
  // The result string starts with "Command: <actual command>", so we
  // extract the command from there for the header.
  let cmd = unquote(String(obj['cmd'] ?? obj['command'] ?? obj['CommandLine'] ?? ''))

  if (!cmd && isWriteStdin && call.result) {
    const m = call.result.match(/^Command: (.+)$/m)
    if (m) cmd = m[1]!
  }

  const workdir = unquote(String(obj['workdir'] ?? obj['cwd'] ?? obj['Cwd'] ?? ''))
  const justification = unquote(String(obj['justification'] ?? ''))

  const showResult = call.result && !isUselessResult(call)
  const output = showResult ? extractCommandOutput(call.result!) : ''

  // For write_stdin with empty chars, the input is just a poll —
  // don't show an empty `$ ` block, only show the output.
  if (isWriteStdin && !cmd && !output) return null

  return (
    <div className="flex flex-col gap-1">
      {justification && (
        <div className="text-[10px] text-warm-faint dark:text-dark-muted italic leading-relaxed">
          {justification}
        </div>
      )}
      {cmd && (
        <CodeBlock>
          <span className="text-accent dark:text-accent-dark">$ </span>
          {cmd}
        </CodeBlock>
      )}
      {workdir && (
        <div className="font-mono text-[10px] text-warm-faint dark:text-dark-muted">
          cwd: {shortenHome(workdir)}
        </div>
      )}
      {showResult && <CodeBlock>{output}</CodeBlock>}
      {call.resultTruncated && <Note>truncated</Note>}
    </div>
  )
}

interface PlanStep {
  step: string
  status?: string
}

/** update_plan: render steps as a checklist. Result ("Plan updated") is hidden. */
function PlanDetail({ call }: DetailProps) {
  const obj = tryParseInputLoose(call)
  if (!call.input) return <RawDetail call={call} />

  const steps = Array.isArray(obj['plan']) ? (obj['plan'] as PlanStep[]) : []
  const explanation = typeof obj['explanation'] === 'string' ? obj['explanation'] : ''

  return (
    <div className="flex flex-col gap-1.5">
      {explanation && (
        <div className="text-[11px] text-warm-muted dark:text-dark-muted leading-relaxed">
          {explanation}
        </div>
      )}
      {steps.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {steps.map((s, i) => {
            const isDone = s.status === 'completed'
            const isInProgress = s.status === 'in_progress'
            return (
              <div key={i} className="flex items-start gap-1.5 text-[11px]">
                <span
                  className={`flex-none mt-0.5 w-3 h-3 rounded-full border flex items-center justify-center text-[8px] font-bold ${
                    isDone
                      ? 'bg-accent dark:bg-accent-dark border-accent dark:border-accent-dark text-white'
                      : isInProgress
                        ? 'border-accent dark:border-accent-dark text-accent dark:text-accent-dark'
                        : 'border-warm-faint dark:border-dark-muted text-transparent'
                  }`}
                >
                  {isDone ? '✓' : ''}
                </span>
                <span
                  className={`${
                    isDone
                      ? 'text-warm-faint dark:text-dark-muted line-through'
                      : 'text-warm-text dark:text-dark-text'
                  }`}
                >
                  {s.step}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** todo_write: render items as a checklist. */
function TodoDetail({ call }: DetailProps) {
  const obj = tryParseInputLoose(call)
  if (!call.input) return <RawDetail call={call} />

  const todos = Array.isArray(obj['todos']) ? (obj['todos'] as Array<{ content?: string; status?: string }>) : []
  if (todos.length === 0) return <RawDetail call={call} />
  return (
    <div className="flex flex-col gap-0.5">
      {todos.map((todo, i) => {
        const isDone = todo.status === 'completed'
        return (
          <div key={i} className="flex items-start gap-1.5 text-[11px]">
            <span
              className={`flex-none mt-0.5 w-3 h-3 rounded-full border flex items-center justify-center text-[8px] font-bold ${
                isDone
                  ? 'bg-accent dark:bg-accent-dark border-accent dark:border-accent-dark text-white'
                  : 'border-warm-faint dark:border-dark-muted text-transparent'
              }`}
            >
              {isDone ? '✓' : ''}
            </span>
            <span
              className={`${
                isDone
                  ? 'text-warm-faint dark:text-dark-muted line-through'
                  : 'text-warm-text dark:text-dark-text'
              }`}
            >
              {todo.content ?? '(no description)'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** apply_patch: render as a color-coded diff. */
function PatchDetail({ call }: DetailProps) {
  const patch = call.input ?? ''
  const lines = patch.split('\n')
  const fileLines = lines.filter(
    l => l.startsWith('*** ') && !l.startsWith('*** Begin') && !l.startsWith('*** End'),
  )

  return (
    <div className="flex flex-col gap-1">
      {fileLines.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {fileLines.map((fl, i) => (
            <span
              key={i}
              className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-warm-surface2 dark:bg-dark-surface2 text-warm-muted dark:text-dark-muted"
            >
              {fl.replace('*** ', '')}
            </span>
          ))}
        </div>
      )}
      <CodeBlock>
        {lines.map((line, i) => {
          if (line.startsWith('+') && !line.startsWith('+++')) {
            return <span key={i} className="text-green-600 dark:text-green-400">{line + '\n'}</span>
          }
          if (line.startsWith('-') && !line.startsWith('---')) {
            return <span key={i} className="text-red-600 dark:text-red-400">{line + '\n'}</span>
          }
          if (line.startsWith('@@')) {
            return <span key={i} className="text-accent dark:text-accent-dark">{line + '\n'}</span>
          }
          if (line.startsWith('*** ')) {
            return <span key={i} className="text-warm-faint dark:text-dark-muted">{line + '\n'}</span>
          }
          return <span key={i}>{line + '\n'}</span>
        })}
      </CodeBlock>
      {call.result && !isUselessResult(call) && <CodeBlock>{call.result}</CodeBlock>}
    </div>
  )
}

const PATH_KEYS = [
  'file_path', 'filePath', 'path', 'absolute_path', 'AbsolutePath',
  'TargetFile', 'target_file', 'target_directory',
]

/** Extract a file path from the input object, trying common key names. */
function extractPath(obj: Record<string, unknown>): string {
  for (const key of PATH_KEYS) {
    const val = obj[key]
    if (typeof val === 'string' && val) return unquote(val)
  }
  return ''
}

/** File reads: just show the file contents. Path is already in the header. */
function FileReadDetail({ call }: DetailProps) {
  const showResult = call.result && !isUselessResult(call)

  if (!showResult) {
    // Input-only (e.g. the path was already shown in the header)
    const obj = tryParseInputLoose(call)
    const offset = typeof obj['offset'] === 'number' ? obj['offset'] : (typeof obj['StartLine'] === 'number' ? obj['StartLine'] : undefined)
    const limit = typeof obj['limit'] === 'number' ? obj['limit'] : (typeof obj['EndLine'] === 'number' ? obj['EndLine'] : undefined)
    if (offset || limit) {
      return (
        <div className="font-mono text-[10px] text-warm-faint dark:text-dark-muted">
          {typeof offset === 'number' ? `line ${offset}` : ''}
          {typeof limit === 'number' ? `–${limit}` : ''}
        </div>
      )
    }
    return null
  }

  return (
    <div className="flex flex-col gap-1">
      <CodeBlock>{call.result}</CodeBlock>
      {call.resultTruncated && <Note>truncated</Note>}
    </div>
  )
}

/**
 * File writes / edits: show the file path as a header, then render
 * old→new strings as a mini-diff. For full-file writes, show the content.
 */
function FileEditDetail({ call }: DetailProps) {
  const obj = tryParseInputLoose(call)
  if (!call.input) return <RawDetail call={call} />

  const filePath = extractPath(obj)
  const oldStr = typeof obj['old_string'] === 'string'
    ? obj['old_string']
    : (typeof obj['oldString'] === 'string' ? obj['oldString'] : '')
  const newStr = typeof obj['new_string'] === 'string'
    ? obj['new_string']
    : (typeof obj['newString'] === 'string' ? obj['newString'] : '')
  const content = typeof obj['content'] === 'string' ? obj['content'] : ''

  const showResult = call.result && !isUselessResult(call)
  const truncated = call.inputTruncated

  // search_replace / replace_file_content: show old→new as a mini-diff
  if (oldStr || newStr) {
    return (
      <div className="flex flex-col gap-1">
        {filePath && (
          <div className="font-mono text-[10px] text-warm-faint dark:text-dark-muted">
            {shortenHome(filePath)}
          </div>
        )}
        <CodeBlock maxHeight="20rem">
          {oldStr.split('\n').map((line, i) => (
            <span key={`o${i}`} className="text-red-600 dark:text-red-400">{'- ' + line + '\n'}</span>
          ))}
          {newStr.split('\n').map((line, i) => (
            <span key={`n${i}`} className="text-green-600 dark:text-green-400">{'+ ' + line + '\n'}</span>
          ))}
        </CodeBlock>
        {truncated && <Note>input truncated</Note>}
        {showResult && <CodeBlock>{call.result}</CodeBlock>}
      </div>
    )
  }

  // write_to_file / full content writes: show the content
  if (content) {
    return (
      <div className="flex flex-col gap-1">
        {filePath && (
          <div className="font-mono text-[10px] text-warm-faint dark:text-dark-muted">
            {shortenHome(filePath)}
          </div>
        )}
        <CodeBlock maxHeight="20rem">{content}</CodeBlock>
        {truncated && <Note>input truncated</Note>}
        {showResult && <CodeBlock>{call.result}</CodeBlock>}
      </div>
    )
  }

  return <RawDetail call={call} />
}

/** Grep: show /pattern/ path, then results. */
function GrepDetail({ call }: DetailProps) {
  const obj = tryParseInputLoose(call)
  const pattern = unquote(String(obj['pattern'] ?? obj['query'] ?? obj['Query'] ?? ''))
  const path = unquote(String(obj['path'] ?? obj['SearchPath'] ?? ''))

  const showResult = call.result && !isUselessResult(call)

  return (
    <div className="flex flex-col gap-1">
      {(pattern || path) && (
        <div className="font-mono text-[10px] text-warm-faint dark:text-dark-muted">
          {pattern && `/${pattern}/`}
          {pattern && path && ' '}
          {path && shortenHome(path)}
        </div>
      )}
      {showResult && <CodeBlock>{call.result}</CodeBlock>}
      {call.resultTruncated && <Note>truncated</Note>}
    </div>
  )
}

/** Directory listing: show path, then results. */
function ListDirDetail({ call }: DetailProps) {
  const obj = tryParseInputLoose(call)
  const path = unquote(String(obj['path'] ?? obj['DirectoryPath'] ?? obj['target_directory'] ?? obj['pattern'] ?? ''))

  const showResult = call.result && !isUselessResult(call)

  return (
    <div className="flex flex-col gap-1">
      {path && (
        <div className="font-mono text-[10px] text-warm-faint dark:text-dark-muted">
          {shortenHome(path)}
        </div>
      )}
      {showResult && <CodeBlock>{call.result}</CodeBlock>}
      {call.resultTruncated && <Note>truncated</Note>}
    </div>
  )
}

/** Web search/fetch: show query or URL, then results. */
function WebDetail({ call }: DetailProps) {
  const obj = tryParseInputLoose(call)
  const query = unquote(String(obj['query'] ?? obj['Query'] ?? obj['url'] ?? obj['Url'] ?? obj['prompt'] ?? ''))

  const showResult = call.result && !isUselessResult(call)

  return (
    <div className="flex flex-col gap-1">
      {query && (
        <div className="font-mono text-[10px] text-warm-faint dark:text-dark-muted">
          {query}
        </div>
      )}
      {showResult && <CodeBlock>{call.result}</CodeBlock>}
      {call.resultTruncated && <Note>truncated</Note>}
    </div>
  )
}

/** Task / subagent: show description and prompt. */
function TaskDetail({ call }: DetailProps) {
  const obj = tryParseInputLoose(call)
  if (!call.input) return <RawDetail call={call} />

  const description = typeof obj['description'] === 'string' ? obj['description'] : ''
  const agentName = typeof obj['agent_name'] === 'string' ? obj['agent_name'] : ''
  const prompt = typeof obj['prompt'] === 'string' ? obj['prompt'] : ''
  const showResult = call.result && !isUselessResult(call)

  // Gemini's invoke_agent result starts with "Subagent 'name' finished.\n"
  // and "Termination Reason: GOAL\n", then the actual result after
  // "Result:\n". Strip the boilerplate so the detail view shows the
  // useful content directly.
  let resultText = ''
  if (showResult) {
    resultText = call.result!
    const resultIdx = resultText.indexOf('\nResult:\n')
    if (resultIdx >= 0) {
      resultText = resultText.slice(resultIdx + '\nResult:\n'.length)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {(description || agentName) && (
        <div className="text-[11px] text-warm-text dark:text-dark-text font-medium">
          {agentName && <span className="text-accent dark:text-accent-dark">@{agentName}</span>}
          {agentName && description && ' · '}
          {description}
        </div>
      )}
      {prompt && <CodeBlock maxHeight="12rem">{prompt}</CodeBlock>}
      {showResult && <CodeBlock>{resultText}</CodeBlock>}
      {call.resultTruncated && <Note>truncated</Note>}
    </div>
  )
}

/**
 * Question prompts: render the questions array as cards with
 * options. Handles both Codex's `request_user_input` (options are
 * `{label, description}` objects) and Antigravity's `ask_question`
 * (options are plain strings). If the user answered, the result
 * carries the selected option — shown as a highlighted line.
 */
interface QuestionItem {
  header?: string
  question?: string
  options?: Array<string | { label?: string; description?: string }>
}

function QuestionDetail({ call }: DetailProps) {
  const obj = tryParseInputLoose(call)

  const rawQuestions = obj['questions']
  const questions: QuestionItem[] = Array.isArray(rawQuestions)
    ? (rawQuestions as QuestionItem[])
    : []

  const showResult = call.result && !isUselessResult(call)

  if (questions.length === 0) return <RawDetail call={call} />

  return (
    <div className="flex flex-col gap-2">
      {questions.map((q, qi) => (
        <div key={qi} className="flex flex-col gap-1">
          {q.header && (
            <div className="text-[10px] font-medium uppercase tracking-wide text-warm-faint dark:text-dark-muted">
              {q.header}
            </div>
          )}
          {q.question && (
            <div className="text-[11px] text-warm-text dark:text-dark-text leading-relaxed">
              {q.question}
            </div>
          )}
          {Array.isArray(q.options) && q.options.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {q.options.map((opt, oi) => {
                const label = typeof opt === 'string' ? opt : (opt.label ?? '')
                const desc = typeof opt === 'string' ? '' : (opt.description ?? '')
                // Check if this option was selected (result may contain the label)
                const isSelected = showResult && call.result!.includes(label.slice(0, 40))
                return (
                  <div
                    key={oi}
                    className={`flex flex-col gap-0.5 rounded px-2 py-1 text-[11px] ${
                      isSelected
                        ? 'bg-accent/10 dark:bg-accent-dark/10 border border-accent/30 dark:border-accent-dark/30'
                        : 'bg-warm-surface2 dark:bg-dark-surface2'
                    }`}
                  >
                    <span className={isSelected ? 'text-accent dark:text-accent-dark font-medium' : 'text-warm-text dark:text-dark-text'}>
                      {label}
                    </span>
                    {desc && (
                      <span className="text-[10px] text-warm-faint dark:text-dark-muted leading-relaxed">
                        {desc}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ))}
      {showResult && (
        <CodeBlock>{call.result}</CodeBlock>
      )}
      {call.resultTruncated && <Note>truncated</Note>}
    </div>
  )
}

/** Fallback: pretty-printed JSON input, result suppressed when useless. No labels. */
function RawDetail({ call }: DetailProps) {
  const showResult = call.result && !isUselessResult(call)

  let displayInput = call.input ?? ''
  if (displayInput) {
    try {
      const parsed = JSON.parse(displayInput)
      if (typeof parsed === 'object' && parsed !== null) {
        displayInput = JSON.stringify(parsed, null, 2)
      }
    } catch {
      // Not JSON — show as-is
    }
  }

  if (!displayInput && !showResult) return null

  return (
    <div className="flex flex-col gap-1">
      {displayInput && (
        <CodeBlock>
          {displayInput}
        </CodeBlock>
      )}
      {call.inputTruncated && <Note>input truncated</Note>}
      {showResult && (
        <>
          <CodeBlock>{call.result}</CodeBlock>
          {call.resultTruncated && <Note>result truncated</Note>}
        </>
      )}
    </div>
  )
}

// ── Dispatch ───────────────────────────────────────────────────────

const SHELL_TOOLS = new Set([
  'bash', 'shell', 'exec_command', 'run_terminal_command', 'run_command',
  'run_terminal_cmd', 'write_stdin', 'shell_command',
])
const PLAN_TOOLS = new Set(['update_plan'])
const TODO_TOOLS = new Set(['todowrite', 'todo_write'])
const PATCH_TOOLS = new Set(['apply_patch'])
const FILE_READ_TOOLS = new Set([
  'read', 'read_file', 'view_file', 'readfile',
])
const FILE_WRITE_TOOLS = new Set([
  'write', 'write_file', 'edit', 'multiedit', 'edit_file', 'replace',
  'search_replace', 'write_to_file', 'replace_file_content',
  'multi_replace_file_content',
])
const GREP_TOOLS = new Set(['grep', 'search_file_content', 'ripgrep', 'grep_search'])
const LIST_TOOLS = new Set(['glob', 'list_directory', 'list_dir', 'ls'])
const WEB_TOOLS = new Set([
  'websearch', 'web_search', 'google_web_search', 'webfetch', 'web_fetch',
  'search_web', 'read_url_content', 'fetch_url',
])
const TASK_TOOLS = new Set(['task', 'agent', 'spawn_subagent', 'invoke_agent', 'invoke_subagent', 'call_omo_agent'])
const QUESTION_TOOLS = new Set(['request_user_input', 'ask_question', 'question'])

export function ToolDetail({ call }: DetailProps) {
  const name = canonicalName(call)

  // `wait` is Codex's polling mechanism for long-running exec cells.
  // The input is just a cell_id and yield_time — no useful detail to show.
  // The result, if any, carries the final output of the waited-on cell.
  if (name === 'wait') {
    const showResult = call.result && !isUselessResult(call)
    if (!showResult) return null
    const output = extractCommandOutput(call.result!)
    return (
      <div className="flex flex-col gap-1">
        <CodeBlock>{output}</CodeBlock>
        {call.resultTruncated && <Note>truncated</Note>}
      </div>
    )
  }

  if (SHELL_TOOLS.has(name)) return <ShellCommandDetail call={call} />
  if (PLAN_TOOLS.has(name)) return <PlanDetail call={call} />
  if (TODO_TOOLS.has(name)) return <TodoDetail call={call} />
  if (PATCH_TOOLS.has(name)) return <PatchDetail call={call} />
  if (FILE_READ_TOOLS.has(name)) return <FileReadDetail call={call} />
  if (FILE_WRITE_TOOLS.has(name)) return <FileEditDetail call={call} />
  if (GREP_TOOLS.has(name)) return <GrepDetail call={call} />
  if (LIST_TOOLS.has(name)) return <ListDirDetail call={call} />
  if (WEB_TOOLS.has(name)) return <WebDetail call={call} />
  if (TASK_TOOLS.has(name)) return <TaskDetail call={call} />
  if (QUESTION_TOOLS.has(name)) return <QuestionDetail call={call} />

  return <RawDetail call={call} />
}

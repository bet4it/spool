/**
 * Shared shaping for the structured tool-call / reasoning detail that
 * parsers now capture alongside `contentText`.
 *
 * Every provider stores this differently (Claude interleaves
 * `tool_use` / `tool_result` content blocks across two messages,
 * Codex emits flat `function_call` + `function_call_output` records,
 * OpenCode nests everything under a single `tool` part's `state`), so
 * the parsers normalise into `ToolCall` and the UI only ever learns
 * one shape.
 *
 * Size is the load-bearing concern here. Tool results are unbounded —
 * a single `Read` of a large file or a `Bash` that cats a log can run
 * to megabytes, and the previous schema never paid that cost because
 * it kept only the tool's name. Storing raw payloads would inflate
 * spool.db by orders of magnitude for a detail view that is collapsed
 * by default, so every field is clamped on the way in and the clamp
 * is recorded (`inputTruncated` / `resultTruncated`) so the UI can say
 * so rather than silently showing a half-file.
 */
import type { ToolCall } from '../types.js'

/** Per-field clamp for a tool's input payload. */
export const TOOL_INPUT_LIMIT = 4_000
/** Per-field clamp for a tool's result payload. */
export const TOOL_RESULT_LIMIT = 8_000
/** Per-message clamp for reasoning/thinking text. */
export const THINKING_LIMIT = 16_000
/** Upper bound on calls kept per message — a runaway agent loop
 *  shouldn't be able to write an unbounded row. */
export const MAX_TOOL_CALLS_PER_MESSAGE = 64

export interface Truncated {
  text: string
  truncated: boolean
}

/** Clamp to `limit` characters, reporting whether anything was cut. */
export function clampText(value: string, limit: number): Truncated {
  if (value.length <= limit) return { text: value, truncated: false }
  return { text: value.slice(0, limit), truncated: true }
}

/**
 * Extract readable text from a Codex tool output value.
 *
 * Codex `function_call_output` / `custom_tool_call_output` records
 * store the output as one of:
 *
 * 1. A plain string (e.g. `"Script running with cell ID 21\n…"`)
 * 2. An array of `{type: "input_text", text: "…"}` content parts
 *    (the same shape as OpenAI Responses API output items)
 * 3. An array of `{type: "text", text: "…"}` parts
 *
 * For arrays we join the `text` fields of all items, which is what
 * a user expects to see — the actual command output — rather than the
 * raw JSON array that `JSON.stringify` would produce.
 */
function extractCodexOutput(value: unknown): string {
  if (Array.isArray(value)) {
    const parts = value
      .filter(
        (item): item is { text: string } =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>)['text'] === 'string',
      )
      .map(item => item.text)
    if (parts.length > 0) return parts.join('')
  }
  return ''
}

/**
 * Render an arbitrary tool input/result value as display text.
 *
 * Providers are inconsistent: some hand us an already-serialised JSON
 * string, others a live object, others a plain string of terminal
 * output. Objects are pretty-printed (2-space) because the detail
 * view shows them in a <pre> and a single-line blob is unreadable;
 * strings pass through untouched so command lines and stdout keep
 * their original formatting.
 *
 * Codex output arrays of `{type: "input_text", text: "…"}` are
 * unwrapped to just the text content before serialisation.
 */
export function stringifyToolPayload(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  // Codex outputs are often arrays of content parts. Extract the
  // text rather than JSON.stringify-ing the array.
  const extracted = extractCodexOutput(value)
  if (extracted) return extracted

  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    // Circular / non-serialisable payloads are not worth failing a
    // whole session parse over — drop the detail, keep the call.
    return ''
  }
}

/** Build a clamped ToolCall, omitting empty optional fields so the
 *  persisted JSON stays small for the common name-only case. */
export function makeToolCall(opts: {
  name: string
  id?: string | undefined
  input?: unknown
  result?: unknown
  isError?: boolean
}): ToolCall {
  const call: ToolCall = { name: opts.name }
  if (opts.id) call.id = opts.id

  const input = stringifyToolPayload(opts.input)
  if (input) {
    const clamped = clampText(input, TOOL_INPUT_LIMIT)
    call.input = clamped.text
    if (clamped.truncated) call.inputTruncated = true
  }

  const result = stringifyToolPayload(opts.result)
  if (result) {
    const clamped = clampText(result, TOOL_RESULT_LIMIT)
    call.result = clamped.text
    if (clamped.truncated) call.resultTruncated = true
  }

  if (opts.isError) call.isError = true
  return call
}

/** Clamp the per-message call list. */
export function limitToolCalls(calls: ToolCall[]): ToolCall[] {
  return calls.length > MAX_TOOL_CALLS_PER_MESSAGE
    ? calls.slice(0, MAX_TOOL_CALLS_PER_MESSAGE)
    : calls
}

/**
 * Expand a Codex `exec` custom-tool call into individual sub-calls.
 *
 * Codex's `exec` tool runs free-form JavaScript. In practice the JS
 * contains one of:
 *
 * - Multiple `tools.exec_command({"cmd":"…","workdir":"…"})` calls
 *   bundled in a `Promise.all` → split into individual `exec_command`
 *   ToolCall entries.
 * - A single `tools.exec_command(…)` call → keep as `exec_command`
 *   with the `cmd`/`workdir` extracted into a clean JSON input.
 * - A `tools.apply_patch(patch)` call → convert to an `apply_patch`
 *   ToolCall with the patch text as input.
 * - Other JS that calls tools we don't recognise → keep as `exec`
 *   with the raw JS, but at least strip the boilerplate wrapper.
 *
 * The original `exec` call's `result` (the combined script output) is
 * kept on a trailing `exec` entry so nothing is lost when splitting
 * multi-command calls.
 *
 * Returns the original call unchanged when it is not an `exec` call
 * or has no parseable sub-calls.
 */
export function expandCodexExec(call: ToolCall): ToolCall[] {
  const isExec = call.name === 'exec' || call.name === 'Exec'
  if (!isExec) return [call]

  const code = call.input ?? ''

  // First try exec_command sub-calls
  const execSubCalls = parseExecSubCalls(code)
  if (execSubCalls.length > 0) {
    if (execSubCalls.length === 1) {
      // Single command: convert to exec_command directly
      const { cmd, workdir, justification } = execSubCalls[0]!
      const args: Record<string, string> = { cmd }
      if (workdir) args['workdir'] = workdir
      if (justification) args['justification'] = justification
      const replaced = makeToolCall({
        name: 'exec_command',
        input: JSON.stringify(args),
        ...(call.result ? { result: call.result } : {}),
      })
      if (call.resultTruncated) replaced.resultTruncated = true
      if (call.isError) replaced.isError = true
      return [replaced]
    }

    const expanded: ToolCall[] = execSubCalls.map(({ cmd, workdir, justification }) => {
      const args: Record<string, string> = { cmd }
      if (workdir) args['workdir'] = workdir
      if (justification) args['justification'] = justification
      return makeToolCall({ name: 'exec_command', input: JSON.stringify(args) })
    })

    // Attach the combined result to a trailing exec entry so the
    // aggregated output is still visible after the per-command rows.
    if (call.result) {
      const trailing = makeToolCall({ name: 'exec', result: call.result })
      if (call.resultTruncated) trailing.resultTruncated = true
      expanded.push(trailing)
    }

    return expanded
  }

  // Try apply_patch
  const patch = extractApplyPatch(code)
  if (patch) {
    const replaced = makeToolCall({
      name: 'apply_patch',
      input: patch,
      ...(call.result ? { result: call.result } : {}),
    })
    if (call.resultTruncated) replaced.resultTruncated = true
    if (call.isError) replaced.isError = true
    return [replaced]
  }

  // Unrecognised JS — leave as exec
  return [call]
}

/** One `tools.exec_command({"cmd":"…","workdir":"…"})` call extracted
 *  from a Codex `exec` JS payload. */
interface ExecSubCall {
  cmd: string
  workdir?: string
  justification?: string
}

/**
 * Parse the JS payload of Codex's `exec` custom tool into individual
 * `exec_command` sub-calls.
 *
 * The JS uses unquoted keys (`{cmd:"…", workdir:"…"}`) and sometimes
 * template literals (`{cmd: \`echo ${var}\`}`), neither of which is valid
 * JSON. We use targeted regexes to extract the `cmd`, `workdir`, and
 * `justification` values from the object literal, handling:
 *
 * - Double-quoted strings: `"value"` (with escaped inner quotes)
 * - Single-quoted strings: `'value'`
 * - Template literals: `` `value ${expr}` `` — resolved against
 *   `const` variable declarations earlier in the JS
 */
function parseExecSubCalls(code: string): ExecSubCall[] {
  // Build a map of variable declarations for template literal resolution
  const varMap = new Map<string, string>()
  const varRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["'`]([^"'`]*?)["'`]/g
  let varMatch: RegExpExecArray | null
  while ((varMatch = varRe.exec(code)) !== null) {
    varMap.set(varMatch[1]!, varMatch[2]!)
  }

  const calls: ExecSubCall[] = []
  // Match complete `tools.exec_command({...})` calls where the object
  // literal has balanced braces (including one level of nesting).
  const re = /tools\.exec_command\s*\(\s*(\{(?:[^{}]|\{[^{}]*\})*\})\s*\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(code)) !== null) {
    const objLiteral = match[1]!
    const cmd = extractJsStringField(objLiteral, 'cmd', varMap)
    if (cmd) {
      const workdir = extractJsStringField(objLiteral, 'workdir', varMap)
      const justification = extractJsStringField(objLiteral, 'justification', varMap)
      calls.push({
        cmd,
        ...(workdir ? { workdir } : {}),
        ...(justification ? { justification } : {}),
      })
    }
  }

  // Fallback: if no complete calls were found, the input may have been
  // truncated at the 4000-char limit, cutting off the closing `}` of the
  // object literal. Try to extract a `cmd` from an incomplete
  // `tools.exec_command({...` fragment — the `cmd` value usually comes
  // first and is the most important field for display.
  if (calls.length === 0) {
    const partialRe = /tools\.exec_command\s*\(\s*(\{[\s\S]*)/
    const partialMatch = partialRe.exec(code)
    if (partialMatch) {
      const fragment = partialMatch[1]!
      // Try the normal extractor first (works if only the closing `}`
      // is missing but the `cmd` value's quotes are intact)
      let cmd = extractJsStringField(fragment, 'cmd', varMap)
      // If that fails, the cmd value's closing quote was also cut off.
      // Extract everything after `"cmd":"` or `cmd:"` until end of string.
      if (!cmd) {
        const cmdRe = /(?:cmd|"cmd"|'cmd')\s*:\s*"((?:[^"\\]|\\.)*)$/
        const cmdMatch = cmdRe.exec(fragment)
        if (cmdMatch) {
          cmd = cmdMatch[1]!
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\')
        }
      }
      if (cmd) {
        const workdir = extractJsStringField(fragment, 'workdir', varMap)
        const justification = extractJsStringField(fragment, 'justification', varMap)
        calls.push({
          cmd,
          ...(workdir ? { workdir } : {}),
          ...(justification ? { justification } : {}),
        })
      }
    }
  }

  return calls
}

/**
 * Extract a string-valued field from a JS object literal body.
 *
 * Handles double-quoted, single-quoted, and template-literal values.
 * Template literals have `${varName}` references resolved against
 * `varMap`. Falls back to `undefined` when the field is absent or
 * the value isn't a string we can resolve.
 */
function extractJsStringField(
  objLiteral: string,
  field: string,
  varMap: Map<string, string>,
): string | undefined {
  // Match: field: "value"  |  "field": "value"  |  'field': 'value'  |  field: `value`
  // The key may be unquoted or quoted, and the value may contain
  // escaped chars inside quotes.
  const re = new RegExp(
    `(?:${field}|"${field}"|'${field}')\\s*:\\s*` +
    '(?:' +
      '"((?:[^"\\\\]|\\\\.)*)"' +    // double-quoted
      '|' +
      "'((?:[^'\\\\]|\\\\.)*)'" +    // single-quoted
      '|' +
      '`((?:[^`\\\\]|\\\\.)*)`' +     // template literal
    ')',
  )
  const m = re.exec(objLiteral)
  if (!m) return undefined

  const doubleQuoted = m[1]
  const singleQuoted = m[2]
  const templateLit = m[3]

  let raw: string | undefined
  if (doubleQuoted !== undefined) raw = doubleQuoted
  else if (singleQuoted !== undefined) raw = singleQuoted
  else if (templateLit !== undefined) raw = templateLit
  else return undefined

  // Unescape standard JS string escapes
  const unescaped = raw
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\')

  // Resolve ${var} references in template literals
  if (templateLit !== undefined) {
    return unescaped.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (_, varName: string) =>
      varMap.get(varName) ?? `\${${varName}}`,
    )
  }

  return unescaped
}

/**
 * Extract the patch text from a `tools.apply_patch(…)` call inside a
 * Codex `exec` JS payload. Returns null when no apply_patch call is
 * found.
 *
 * The exec JS typically assigns the patch to a variable first:
 *   `const patch = "*** Begin Patch\n…"; tools.apply_patch(patch);`
 * We locate the `tools.apply_patch(varName)` call, then search
 * backwards for `varName = "…"` or `varName = '…'` to get the patch
 * string.
 */
function extractApplyPatch(code: string): string | null {
  // Find the apply_patch call and capture the argument (variable name or string)
  const callRe = /tools\.apply_patch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/
  const callMatch = callRe.exec(code)
  if (!callMatch) return null

  const varName = callMatch[1]!
  // Skip the common case where the arg is literally called `patch` and
  // the string is inline. But usually it's a variable — find its
  // assignment: `varName = "patch text"` or `varName = 'patch text'`
  const assignRe = new RegExp(
    `${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(["'])([\\s\\S]*?)\\1`,
  )
  const assignMatch = assignRe.exec(code)
  if (!assignMatch) return null

  // Unescape JS string literal contents
  const raw = assignMatch[2]!
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\')
}

/** Clamp reasoning text; returns undefined for blank input so callers
 *  can spread it into a ParsedMessage without emitting an empty key. */
export function normalizeThinking(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return undefined
  return clampText(trimmed, THINKING_LIMIT).text
}

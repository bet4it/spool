import { readFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import type { ParseSessionResult, ParsedMessage, ParsedSession } from '../types.js'
import { limitToolCalls, makeToolCall, normalizeThinking } from './tool-calls.js'

export const ANTIGRAVITY_INDEX_VERSION = 'antigravity-v4-ask-question'

interface AntigravityStep {
  step_index: number
  source: string
  type: string
  status: string
  created_at: string
  content?: string | null
  thinking?: string | null
  tool_calls?: Array<{ name: string; args?: Record<string, unknown> }> | null
}

/** Maps the Antigravity cascade step type to the tool name it carries
 *  results for. PLANNER_RESPONSE emits tool_calls; subsequent records
 *  of these types carry the results in order. */
const RESULT_TYPE_TO_TOOL: Record<string, string> = {
  LIST_DIRECTORY: 'list_dir',
  GREP_SEARCH: 'grep_search',
  RUN_COMMAND: 'run_command',
  VIEW_FILE: 'view_file',
  CODE_ACTION: 'code_action',
  ASK_QUESTION: 'ask_question',
}

function cleanUserContent(content: string): string {
  const startTag = '<USER_REQUEST>'
  const endTag = '</USER_REQUEST>'
  const startIdx = content.indexOf(startTag)
  if (startIdx >= 0) {
    const endIdx = content.indexOf(endTag)
    if (endIdx > startIdx) {
      const start = startIdx + startTag.length
      return content.slice(start, endIdx).trim()
    }
  }
  return content.trim()
}

/**
 * Clean Antigravity tool result content.
 *
 * Result records start with metadata lines like "Created At: …" and
 * "Completed At: …", followed by the actual tool output. We strip
 * these metadata prefixes so the detail view shows just the result.
 * Error messages ("Encountered error in step execution: …") are kept
 * since they explain why the tool produced no output.
 */
function cleanAntigravityResult(content: string): string {
  if (!content) return ''
  // Remove "Created At: …" and "Completed At: …" metadata lines
  const lines = content.split('\n')
  const cleaned: string[] = []
  let skipMetadata = true
  for (const ln of lines) {
    if (skipMetadata && (ln.startsWith('Created At:') || ln.startsWith('Completed At:'))) {
      continue
    }
    skipMetadata = false
    cleaned.push(ln)
  }
  return cleaned.join('\n').trim()
}

/**
 * Parse double-encoded JSON string fields in Antigravity tool args.
 *
 * Antigravity CLI stores some arg values as JSON strings rather than
 * objects — e.g. `ask_question` has `args.questions` as a stringified
 * JSON array. Without unwrapping, the detail view shows nested JSON
 * strings instead of structured data. We walk the top-level fields and
 * parse any string value that looks like a JSON object or array.
 */
function normalizeAntigravityArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args || typeof args !== 'object') return args
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > 1) {
      const first = value[0]
      if (first === '{' || first === '[') {
        try {
          result[key] = JSON.parse(value)
          continue
        } catch {
          // Not valid JSON — keep the raw string
        }
      }
    }
    result[key] = value
  }
  return result
}

// Check for explicit GEMINI_CLI_HOME or ANTIGRAVITY_CLI_HOME.
// This matches standard path expansion.
function getAntigravityCliRoot(): string {
  const explicit = process.env['ANTIGRAVITY_CLI_HOME']?.trim()
  if (explicit) return expandHome(explicit)

  const configuredHome = process.env['GEMINI_CLI_HOME']?.trim()
  if (configuredHome) {
    const resolved = expandHome(configuredHome)
    if (basename(resolved) === 'antigravity-cli') return resolved
    return join(resolved, '.gemini', 'antigravity-cli')
  }

  return join(homedir(), '.gemini', 'antigravity-cli')
}

function expandHome(filePath: string): string {
  if (filePath === '~') return homedir()
  if (filePath.startsWith('~/')) return join(homedir(), filePath.slice(2))
  return filePath
}

function getHistoryConversationCwds(): Map<string, string> {
  const cliRoot = getAntigravityCliRoot()
  const mappings = new Map<string, string>()

  // Load ONLY from history.jsonl
  const historyPath = join(cliRoot, 'history.jsonl')
  try {
    if (existsSync(historyPath)) {
      const raw = readFileSync(historyPath, 'utf8')
      const lines = raw.split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const data = JSON.parse(line)
          const cid = data.conversationId
          const ws = data.workspace
          if (cid && typeof cid === 'string') {
            mappings.set(cid, typeof ws === 'string' ? ws : '')
          }
        } catch {
          // Ignore parse errors on individual lines
        }
      }
    }
  } catch {
    // Ignore history load failure
  }

  return mappings
}

function extractConversationId(filePath: string): string {
  // .../brain/<conversation-id>/.system_generated/logs/transcript.jsonl
  const parts = filePath.split('/')
  const logsIdx = parts.lastIndexOf('logs')
  if (logsIdx >= 3) {
    return parts[logsIdx - 2]! // conversation-id is 2 levels above logs/
  }
  return ''
}

export function loadAntigravitySession(filePath: string): ParseSessionResult {
  const raw = readFileSync(filePath, 'utf8')
  const lines = raw.split('\n').filter(l => l.trim().length > 0)
  const messages: ParsedMessage[] = []
  let model = ''

  const conversationId = extractConversationId(filePath)

  const historyCwds = getHistoryConversationCwds()
  if (!historyCwds.has(conversationId)) {
    return { kind: 'skipped' }
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!
    let step: AntigravityStep
    try {
      step = JSON.parse(line) as AntigravityStep
    } catch {
      continue
    }

    const { type, content, created_at: timestamp } = step
    if (!type || !timestamp) continue

    if (type === 'CONVERSATION_HISTORY') continue

    if (type === 'USER_INPUT') {
      const text = cleanUserContent(content ?? '')
      if (text) {
        messages.push({
          uuid: `agy-${conversationId}-${step.step_index}`,
          parentUuid: null,
          role: 'user',
          contentText: text,
          timestamp,
          isSidechain: false,
          toolNames: [],
          seq: messages.length,
        })
      }
      continue
    }

    if (type === 'PLANNER_RESPONSE') {
      const text = (content ?? '').trim()
      const rawCalls = (step.tool_calls ?? [])
        .filter(tc => typeof tc.name === 'string' && tc.name.length > 0)

      const toolNames = rawCalls.map(tc => tc.name)

      // Build ToolCall objects, then look ahead for result records.
      // Antigravity emits result records (LIST_DIRECTORY, GREP_SEARCH,
      // RUN_COMMAND, VIEW_FILE) after the PLANNER_RESPONSE, in the
      // same order as the tool_calls. We match by position: the Nth
      // result record corresponds to the Nth tool call.
      const toolCalls = limitToolCalls(rawCalls.map((tc, callIdx) => {
        const call = makeToolCall({ name: tc.name, input: normalizeAntigravityArgs(tc.args) })

        // Look ahead for the Nth result record after this PLANNER_RESPONSE
        let searchIdx = lineIdx + 1
        let resultsFound = 0
        while (searchIdx < lines.length) {
          let resultStep: AntigravityStep
          try {
            resultStep = JSON.parse(lines[searchIdx]!) as AntigravityStep
          } catch {
            searchIdx++
            continue
          }
          const resultType = resultStep.type
          // Stop if we hit another PLANNER_RESPONSE or USER_INPUT
          if (resultType === 'PLANNER_RESPONSE' || resultType === 'USER_INPUT') break
          // Skip non-result types
          if (!RESULT_TYPE_TO_TOOL[resultType]) {
            searchIdx++
            continue
          }
          // This is a result record — check if it's our Nth
          if (resultsFound === callIdx) {
            const resultContent = cleanAntigravityResult(resultStep.content ?? '')
            if (resultContent) {
              const filled = makeToolCall({ name: tc.name, result: resultContent })
              if (filled.result) call.result = filled.result
              if (filled.resultTruncated) call.resultTruncated = true
            }
            break
          }
          resultsFound++
          searchIdx++
        }

        return call
      }))

      const thinking = normalizeThinking(step.thinking)
      if (text || toolNames.length > 0 || thinking) {
        messages.push({
          uuid: `agy-${conversationId}-${step.step_index}`,
          parentUuid: null,
          role: 'assistant',
          contentText: text,
          timestamp,
          isSidechain: false,
          toolNames,
          seq: messages.length,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(thinking ? { thinking } : {}),
        })
      }
      continue
    }
  }

  if (messages.length === 0) return { kind: 'skipped' }

  const cliCwds = getHistoryConversationCwds()
  const cwd = cliCwds.get(conversationId) || ''

  const firstUserMsg = messages.find(m => m.role === 'user' && m.contentText.trim().length > 0)
  const title = firstUserMsg?.contentText.slice(0, 120) ?? `Antigravity ${conversationId.slice(0, 8)}`

  const timestamps = messages.map(m => m.timestamp).filter(Boolean).sort()

  return {
    kind: 'parsed',
    session: {
      source: 'antigravity',
      sessionUuid: conversationId || filePath,
      filePath,
      title,
      cwd,
      model: model || '',
      startedAt: timestamps[0] ?? new Date().toISOString(),
      endedAt: timestamps[timestamps.length - 1] ?? new Date().toISOString(),
      messages,
    },
  }
}

export function parseAntigravitySession(filePath: string): ParsedSession | null {
  try {
    const result = loadAntigravitySession(filePath)
    return result.kind === 'parsed' ? result.session : null
  } catch {
    return null
  }
}

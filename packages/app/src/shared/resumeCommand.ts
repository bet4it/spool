const RESUME_COMMAND_PREFIXES: Record<string, string> = {
  claude: 'claude --dangerously-skip-permissions --resume',
  codex: 'codex --dangerously-bypass-approvals-and-sandbox resume',
  gemini: 'gemini --yolo --resume',
  antigravity: 'agy --dangerously-skip-permissions --conversation',
  opencode: 'opencode --auto --session',
  grok: 'grok --permission-mode bypassPermissions --resume',
}

export function getSessionResumeCommandPrefix(source: string): string | null {
  return RESUME_COMMAND_PREFIXES[source] ?? null
}

export function getSessionResumeCommand(source: string, sessionUuid: string, cwd?: string | null): string | null {
  const prefix = getSessionResumeCommandPrefix(source)
  if (!prefix) return null
  const base = `${prefix} ${shellQuote(sessionUuid)}`
  return cwd ? `cd ${shellQuote(cwd)} && ${base}` : base
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

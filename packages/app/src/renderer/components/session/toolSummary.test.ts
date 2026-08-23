import { describe, it, expect } from 'vitest'
import type { ToolCall } from '@spool-lab/core'
import { toolCallSummary, toolDisplayName } from './toolSummary.js'

function call(name: string, input?: string): ToolCall {
  const c: ToolCall = { name }
  if (input !== undefined) c.input = input
  return c
}

describe('toolDisplayName', () => {
  it('strips the mcp__ prefix and joins with spaces', () => {
    expect(toolDisplayName('mcp__github__create_issue')).toBe('create issue')
  })

  it('passes through non-MCP names unchanged', () => {
    expect(toolDisplayName('read_file')).toBe('read_file')
  })
})

describe('toolCallSummary', () => {
  // ── Codex exec tool (single-command fallback) ───────────────────
  // Multi-command exec calls are expanded by the parser into individual
  // exec_command ToolCall entries, so toolCallSummary only sees the
  // single-command case (or a raw exec that wasn't expanded).
  describe('codex exec custom tool', () => {
    it('shows the command for a single exec_command call', () => {
      const input = `const r = await Promise.all([
  tools.exec_command({"cmd":"git status","workdir":"/home/user/repo","max_output_tokens":4000}),
])`
      expect(toolCallSummary(call('exec', input))).toBe('git status')
    })

    it('handles escaped quotes inside cmd values', () => {
      const input = `tools.exec_command({"cmd":"rg -n \\"pattern\\" file.ts"})`
      expect(toolCallSummary(call('exec', input))).toBe('rg -n "pattern" file.ts')
    })

    it('falls back to first line when no cmd is found', () => {
      const input = `const x = 1 + 2;`
      expect(toolCallSummary(call('exec', input))).toBe('const x = 1 + 2;')
    })
  })

  // ── Grok tools ───────────────────────────────────────────────────
  describe('grok read_file', () => {
    it('shows the target_file path', () => {
      const input = JSON.stringify({
        target_file: '/home/user/Codes/grok-build/src/main.rs',
      })
      expect(toolCallSummary(call('read_file', input))).toBe('~/Codes/grok-build/src/main.rs')
    })

    it('shows target_file with offset and limit', () => {
      const input = JSON.stringify({
        target_file: '/home/user/Codes/grok-build/src/main.rs',
        offset: 870,
        limit: 120,
      })
      expect(toolCallSummary(call('read_file', input))).toBe('~/Codes/grok-build/src/main.rs')
    })
  })

  describe('grok grep', () => {
    it('shows pattern and path', () => {
      const input = JSON.stringify({
        pattern: 'reasoning effort',
        path: '/home/user/Codes',
      })
      expect(toolCallSummary(call('grep', input))).toBe('/reasoning effort/ ~/Codes')
    })
  })

  describe('grok list_dir', () => {
    it('shows the target_directory', () => {
      const input = JSON.stringify({ target_directory: '../grok-build' })
      expect(toolCallSummary(call('list_dir', input))).toBe('../grok-build')
    })
  })

  describe('grok search_replace', () => {
    it('shows the file_path', () => {
      const input = JSON.stringify({
        file_path: '/home/user/Codes/spool/src/index.ts',
        old_string: 'foo',
        new_string: 'bar',
      })
      expect(toolCallSummary(call('search_replace', input))).toBe('~/Codes/spool/src/index.ts')
    })
  })

  describe('grok run_terminal_command', () => {
    it('shows the command', () => {
      const input = JSON.stringify({
        command: 'npx vitest run',
        description: 'Run tests',
      })
      expect(toolCallSummary(call('run_terminal_command', input))).toBe('npx vitest run')
    })
  })

  describe('grok todo_write', () => {
    it('shows progress', () => {
      const input = JSON.stringify({
        todos: [
          { status: 'completed', content: 'A' },
          { status: 'completed', content: 'B' },
          { status: 'pending', content: 'C' },
        ],
      })
      expect(toolCallSummary(call('todo_write', input))).toBe('2/3')
    })
  })

  // ── Antigravity tools ────────────────────────────────────────────
  describe('antigravity view_file', () => {
    it('shows the path without surrounding quotes', () => {
      const input = JSON.stringify({
        AbsolutePath: '"/home/user/Codes/fuzzer/src/cli.rs"',
        toolAction: '"Viewing CLI source"',
      })
      expect(toolCallSummary(call('view_file', input))).toBe('~/Codes/fuzzer/src/cli.rs')
    })
  })

  describe('antigravity grep_search', () => {
    it('shows pattern and path without surrounding quotes', () => {
      const input = JSON.stringify({
        MatchPerLine: 'true',
        Query: '"tenet_dir"',
        SearchPath: '"/home/user/Codes/fuzzer/src"',
      })
      expect(toolCallSummary(call('grep_search', input))).toBe(
        '/tenet_dir/ ~/Codes/fuzzer/src',
      )
    })
  })

  describe('antigravity list_dir', () => {
    it('shows the directory path without quotes', () => {
      const input = JSON.stringify({
        DirectoryPath: '"/home/user/Codes/fuzzer/libafl_qemu_fuzzer"',
      })
      expect(toolCallSummary(call('list_dir', input))).toBe(
        '~/Codes/fuzzer/libafl_qemu_fuzzer',
      )
    })
  })

  describe('antigravity run_command', () => {
    it('shows the command without quotes', () => {
      const input = JSON.stringify({
        CommandLine: '"just build debug 2>&1 | tail -20"',
        Cwd: '"/home/user/Codes/fuzzer"',
      })
      expect(toolCallSummary(call('run_command', input))).toBe(
        'just build debug 2>&1 | tail -20',
      )
    })
  })

  describe('antigravity write_to_file', () => {
    it('shows the target file path', () => {
      const input = JSON.stringify({
        TargetFile: '"/home/user/Codes/fuzzer/src/main.rs"',
        Description: '"Add tenet trace support"',
      })
      expect(toolCallSummary(call('write_to_file', input))).toBe(
        '~/Codes/fuzzer/src/main.rs',
      )
    })
  })

  describe('antigravity replace_file_content', () => {
    it('shows the target file path', () => {
      const input = JSON.stringify({
        TargetFile: '"/home/user/Codes/fuzzer/src/cli.rs"',
        Description: '"Rename tenet_dir to output"',
        StartLine: '100',
        EndLine: '200',
      })
      expect(toolCallSummary(call('replace_file_content', input))).toBe(
        '~/Codes/fuzzer/src/cli.rs',
      )
    })
  })

  describe('antigravity ask_question', () => {
    it('shows the question text from parsed questions array', () => {
      const input = JSON.stringify({
        questions: [
          { is_multi_select: false, question: 'How to handle deps?', options: ['A', 'B'] },
        ],
        toolAction: 'Asking user',
      })
      expect(toolCallSummary(call('ask_question', input))).toBe('How to handle deps?')
    })

    it('handles double-encoded questions string (pre-parser-normalize form)', () => {
      const input = JSON.stringify({
        questions: JSON.stringify([
          { question: 'Use cargoLock?', options: ['Yes', 'No'] },
        ]),
      })
      expect(toolCallSummary(call('ask_question', input))).toBe('Use cargoLock?')
    })

    it('returns empty when no questions', () => {
      const input = JSON.stringify({ toolAction: 'Asking' })
      expect(toolCallSummary(call('ask_question', input))).toBe('')
    })
  })

  describe('codex request_user_input', () => {
    it('shows header and first question', () => {
      const input = JSON.stringify({
        questions: [
          {
            header: '兼容策略',
            id: 'compat_strategy',
            question: 'How to handle compatibility?',
            options: [
              { label: '允许破坏式', description: 'Redo from scratch' },
              { label: '尽量兼容', description: 'Keep existing API' },
            ],
          },
        ],
      })
      expect(toolCallSummary(call('request_user_input', input))).toBe(
        '兼容策略: How to handle compatibility?',
      )
    })

    it('shows question without header when header is missing', () => {
      const input = JSON.stringify({
        questions: [
          { question: 'Which approach?', options: [{ label: 'A' }, { label: 'B' }] },
        ],
      })
      expect(toolCallSummary(call('request_user_input', input))).toBe('Which approach?')
    })
  })

  describe('gemini invoke_agent', () => {
    it('shows agent name', () => {
      const input = JSON.stringify({
        prompt: 'How to list sessions?',
        agent_name: 'cli_help',
      })
      expect(toolCallSummary(call('invoke_agent', input))).toBe('cli_help')
    })

    it('falls back to prompt when agent_name is missing', () => {
      const input = JSON.stringify({
        prompt: 'How to list sessions?',
      })
      expect(toolCallSummary(call('invoke_agent', input))).toBe('How to list sessions?')
    })
  })

  describe('opencode edit', () => {
    it('shows the filePath', () => {
      const input = JSON.stringify({
        filePath: '/home/user/Codes/project/src/index.ts',
        oldString: 'const a = 1',
        newString: 'const a = 2',
      })
      expect(toolCallSummary(call('edit', input))).toBe('~/Codes/project/src/index.ts')
    })
  })

  describe('grok search_replace with truncated input', () => {
    it('shows the file_path even when JSON is truncated', () => {
      // Simulate a search_replace call where the input was clamped at 4000 chars,
      // cutting off the old_string value mid-way and making JSON.parse fail.
      const fullInput = JSON.stringify({
        file_path: '/home/user/Codes/project/src/index.ts',
        old_string: 'x'.repeat(5000),
        new_string: 'y'.repeat(100),
      })
      // Truncate at 4000 chars (like makeToolCall does)
      const truncated = fullInput.slice(0, 4000)
      expect(toolCallSummary(call('search_replace', truncated))).toBe(
        '~/Codes/project/src/index.ts',
      )
    })
  })

  describe('truncated input fallbacks', () => {
    it('shows cmd for truncated shell command JSON', () => {
      const fullInput = JSON.stringify({
        cmd: 'echo ' + 'x'.repeat(5000),
        workdir: '/tmp',
      })
      const truncated = fullInput.slice(0, 4000)
      const result = toolCallSummary(call('bash', truncated))
      expect(result).toContain('echo ')
      expect(result.length).toBeGreaterThan(100)
    })

    it('shows file path for truncated edit JSON', () => {
      const fullInput = JSON.stringify({
        filePath: '/home/user/Codes/project/src/index.ts',
        oldString: 'x'.repeat(5000),
      })
      const truncated = fullInput.slice(0, 4000)
      expect(toolCallSummary(call('edit', truncated))).toBe(
        '~/Codes/project/src/index.ts',
      )
    })

    it('shows description for truncated task JSON', () => {
      const fullInput = JSON.stringify({
        description: 'Research the codebase',
        prompt: 'x'.repeat(5000),
      })
      const truncated = fullInput.slice(0, 4000)
      expect(toolCallSummary(call('task', truncated))).toBe('Research the codebase')
    })

    it('shows agent_name for truncated invoke_agent JSON', () => {
      const fullInput = JSON.stringify({
        agent_name: 'cli_help',
        prompt: 'x'.repeat(5000),
      })
      const truncated = fullInput.slice(0, 4000)
      expect(toolCallSummary(call('invoke_agent', truncated))).toBe('cli_help')
    })
  })

  // ── Common fallbacks ─────────────────────────────────────────────
  describe('fallbacks', () => {
    it('returns empty string for empty input', () => {
      expect(toolCallSummary(call('unknown_tool'))).toBe('')
    })

    it('returns first string value for unknown tools', () => {
      const input = JSON.stringify({ foo: 'bar', baz: 42 })
      expect(toolCallSummary(call('unknown_tool', input))).toBe('bar')
    })

    it('strips quotes from fallback string values', () => {
      const input = JSON.stringify({ foo: '"quoted value"' })
      expect(toolCallSummary(call('unknown_tool', input))).toBe('quoted value')
    })

    it('extracts filename from apply_patch input', () => {
      const patch = '*** Begin Patch\n*** Update File: /home/user/Codes/spool/src/index.ts\n@@\n-old\n+new\n*** End Patch'
      expect(toolCallSummary(call('apply_patch', patch))).toBe('~/Codes/spool/src/index.ts')
    })

    it('shows first file + count for multi-file apply_patch', () => {
      const patch = '*** Begin Patch\n*** Update File: /tmp/a.ts\n*** Add File: /tmp/b.ts\n*** Delete File: /tmp/c.ts\n*** End Patch'
      expect(toolCallSummary(call('apply_patch', patch))).toBe('/tmp/a.ts (+2 more)')
    })

    it('returns first line for apply_patch without file markers', () => {
      expect(toolCallSummary(call('apply_patch', 'line one\nline two'))).toBe(
        'line one',
      )
    })
  })
})

import { describe, it, expect } from 'vitest'
import type { ToolCall } from '../types.js'
import { expandCodexExec, makeToolCall, stringifyToolPayload } from './tool-calls.js'

describe('expandCodexExec', () => {
  it('leaves non-exec calls unchanged', () => {
    const call = makeToolCall({ name: 'exec_command', input: '{"cmd":"ls"}' })
    expect(expandCodexExec(call)).toEqual([call])
  })

  it('converts a single-command exec to exec_command', () => {
    const input = `tools.exec_command({"cmd":"git status"})`
    const call = makeToolCall({ name: 'exec', input })
    const expanded = expandCodexExec(call)

    expect(expanded).toHaveLength(1)
    expect(expanded[0]!.name).toBe('exec_command')
    expect(expanded[0]!.input).toBe('{"cmd":"git status"}')
  })

  it('converts a single-command exec with workdir and result', () => {
    const input = `tools.exec_command({"cmd":"git status","workdir":"/tmp"})`
    const call: ToolCall = makeToolCall({
      name: 'exec',
      input,
      result: 'clean',
    })
    const expanded = expandCodexExec(call)

    expect(expanded).toHaveLength(1)
    expect(expanded[0]!.name).toBe('exec_command')
    expect(expanded[0]!.input).toBe('{"cmd":"git status","workdir":"/tmp"}')
    expect(expanded[0]!.result).toBe('clean')
  })

  it('expands a multi-command exec into individual exec_command calls', () => {
    const input = `const r = await Promise.all([
  tools.exec_command({"cmd":"git status","workdir":"/tmp"}),
  tools.exec_command({"cmd":"git diff","workdir":"/tmp"}),
  tools.exec_command({"cmd":"rg pattern src"}),
]);`
    const call = makeToolCall({ name: 'exec', input })
    const expanded = expandCodexExec(call)

    expect(expanded).toHaveLength(3)
    expect(expanded[0]!.name).toBe('exec_command')
    expect(expanded[0]!.input).toBe('{"cmd":"git status","workdir":"/tmp"}')
    expect(expanded[1]!.name).toBe('exec_command')
    expect(expanded[1]!.input).toBe('{"cmd":"git diff","workdir":"/tmp"}')
    expect(expanded[2]!.name).toBe('exec_command')
    expect(expanded[2]!.input).toBe('{"cmd":"rg pattern src"}')
  })

  it('appends a trailing exec entry with the combined result', () => {
    const input = `const r = await Promise.all([
  tools.exec_command({"cmd":"ls"}),
  tools.exec_command({"cmd":"pwd"}),
]);`
    const call: ToolCall = makeToolCall({ name: 'exec', input, result: 'file1\nfile2\n/tmp' })
    const expanded = expandCodexExec(call)

    expect(expanded).toHaveLength(3)
    // First two are exec_command calls without results
    expect(expanded[0]!.name).toBe('exec_command')
    expect(expanded[0]!.result).toBeUndefined()
    expect(expanded[1]!.name).toBe('exec_command')
    expect(expanded[1]!.result).toBeUndefined()
    // Trailing exec entry carries the combined result
    expect(expanded[2]!.name).toBe('exec')
    expect(expanded[2]!.result).toBe('file1\nfile2\n/tmp')
    expect(expanded[2]!.input).toBeUndefined()
  })

  it('preserves resultTruncated on the trailing exec entry', () => {
    const input = `tools.exec_command({"cmd":"ls"}), tools.exec_command({"cmd":"pwd"})`
    const call: ToolCall = {
      name: 'exec',
      input,
      result: 'x'.repeat(100),
      resultTruncated: true,
    }
    const expanded = expandCodexExec(call)
    expect(expanded[expanded.length - 1]!.resultTruncated).toBe(true)
  })

  it('handles exec commands with escaped quotes in cmd', () => {
    const input = `tools.exec_command({"cmd":"rg \\"pattern\\" file"}), tools.exec_command({"cmd":"pwd"})`
    const call = makeToolCall({ name: 'exec', input })
    const expanded = expandCodexExec(call)
    expect(expanded[0]!.input).toContain('rg \\"pattern\\" file')
  })

  it('returns original call when JS has no exec_command calls', () => {
    const input = `const x = 1 + 2;`
    const call = makeToolCall({ name: 'exec', input })
    expect(expandCodexExec(call)).toEqual([call])
  })

  it('preserves justification in expanded exec_command calls', () => {
    const input = `tools.exec_command({"cmd":"docker start asterinas-dev","workdir":"/home/user/repo","justification":"Do you want to start the existing asterinas-dev container?"}), tools.exec_command({"cmd":"pwd"})`
    const call = makeToolCall({ name: 'exec', input })
    const expanded = expandCodexExec(call)

    expect(expanded[0]!.name).toBe('exec_command')
    const parsed = JSON.parse(expanded[0]!.input!)
    expect(parsed.cmd).toBe('docker start asterinas-dev')
    expect(parsed.justification).toBe(
      'Do you want to start the existing asterinas-dev container?',
    )
  })

  it('preserves justification in single-command exec', () => {
    const input = `tools.exec_command({"cmd":"gh pr create --repo foo/bar","justification":"Allow GitHub API access?"})`
    const call = makeToolCall({ name: 'exec', input })
    const expanded = expandCodexExec(call)

    expect(expanded).toHaveLength(1)
    expect(expanded[0]!.name).toBe('exec_command')
    const parsed = JSON.parse(expanded[0]!.input!)
    expect(parsed.cmd).toBe('gh pr create --repo foo/bar')
    expect(parsed.justification).toBe('Allow GitHub API access?')
  })

  it('converts exec wrapping apply_patch into an apply_patch call', () => {
    const patch = '*** Begin Patch\n*** Update File: /tmp/test.txt\n@@\n-old\n+new\n*** End Patch'
    // Simulate the JS string: newlines are \\n in the JS source
    const patchJs = patch.replace(/\n/g, '\\n')
    const input = `const patch = "${patchJs}";\nconst result = await tools.apply_patch(patch);\ntext(typeof result === "string" ? result : JSON.stringify(result));`
    const call = makeToolCall({ name: 'exec', input })
    const expanded = expandCodexExec(call)

    expect(expanded).toHaveLength(1)
    expect(expanded[0]!.name).toBe('apply_patch')
    expect(expanded[0]!.input).toBe(patch)
  })

  it('converts exec wrapping apply_patch with single quotes', () => {
    const patch = '*** Begin Patch\n*** End Patch'
    const patchJs = patch.replace(/\n/g, '\\n')
    const input = `const patch = '${patchJs}';\ntools.apply_patch(patch);`
    const call = makeToolCall({ name: 'exec', input })
    const expanded = expandCodexExec(call)

    expect(expanded).toHaveLength(1)
    expect(expanded[0]!.name).toBe('apply_patch')
    expect(expanded[0]!.input).toBe(patch)
  })

  it('handles JS object literal with unquoted keys (cmd: instead of "cmd":)', () => {
    const input = `const r = await tools.exec_command({cmd:"git status",workdir:"/tmp"}); text(r.output);`
    const call = makeToolCall({ name: 'exec', input })
    const expanded = expandCodexExec(call)

    expect(expanded).toHaveLength(1)
    expect(expanded[0]!.name).toBe('exec_command')
    expect(expanded[0]!.input).toBe('{"cmd":"git status","workdir":"/tmp"}')
  })

  it('resolves template literal cmd with const variable', () => {
    const input = `const root = "/home/user/Codes/sub2api";\nconst out = await tools.exec_command({ cmd: \`cat \${root}/backend/file.go\` });\ntext(out.output);`
    const call = makeToolCall({ name: 'exec', input })
    const expanded = expandCodexExec(call)

    expect(expanded).toHaveLength(1)
    expect(expanded[0]!.name).toBe('exec_command')
    const parsed = JSON.parse(expanded[0]!.input!)
    expect(parsed.cmd).toBe('cat /home/user/Codes/sub2api/backend/file.go')
  })

  it('resolves template literal with variable in a loop', () => {
    const input = `const root = "/home/user/Codes/sub2api";\nfor (const f of ["a.go", "b.go"]) {\n  const out = await tools.exec_command({ cmd: \`wc -l \${root}/\${f}\` });\n  text(out.output + "\\n");\n}`
    const call = makeToolCall({ name: 'exec', input })
    const expanded = expandCodexExec(call)

    expect(expanded).toHaveLength(1)
    expect(expanded[0]!.name).toBe('exec_command')
    const parsed = JSON.parse(expanded[0]!.input!)
    expect(parsed.cmd).toBe('wc -l /home/user/Codes/sub2api/${f}')
  })

  it('extracts cmd from truncated exec input (object literal cut off)', () => {
    // Simulate makeToolCall clamping at 4000 chars: the closing `}`
    // and `)` of the exec_command call are cut off.
    const longCmd = 'echo ' + 'x'.repeat(4500)
    const fullCode = `const result = await tools.exec_command({"cmd":"${longCmd}","workdir":"/tmp"}); text(result);`
    // Simulate what makeToolCall does: clamp to 4000 chars
    const truncated = fullCode.slice(0, 4000)
    const call = makeToolCall({ name: 'exec', input: truncated })
    const expanded = expandCodexExec(call)

    // The fallback should still extract the cmd
    expect(expanded).toHaveLength(1)
    expect(expanded[0]!.name).toBe('exec_command')
    const parsed = JSON.parse(expanded[0]!.input!)
    expect(parsed.cmd).toContain('echo ')
    expect(parsed.cmd).toContain('xxxx')
  })

  it('extracts cmd from truncated multi-command exec', () => {
    // First command is complete, second is truncated
    const longCmd = 'echo ' + 'y'.repeat(4500)
    const fullCode = `const results = await Promise.all([
  tools.exec_command({"cmd":"echo first","workdir":"/tmp"}),
  tools.exec_command({"cmd":"${longCmd}","workdir":"/tmp"}),
]);`
    const truncated = fullCode.slice(0, 4000)
    const call = makeToolCall({ name: 'exec', input: truncated })
    const expanded = expandCodexExec(call)

    // First command should be found by the main regex
    expect(expanded.length).toBeGreaterThanOrEqual(1)
    expect(expanded[0]!.name).toBe('exec_command')
    const parsed = JSON.parse(expanded[0]!.input!)
    expect(parsed.cmd).toBe('echo first')
  })
})

describe('stringifyToolPayload', () => {
  it('passes through strings unchanged', () => {
    expect(stringifyToolPayload('hello world')).toBe('hello world')
  })

  it('passes through numbers as strings', () => {
    expect(stringifyToolPayload(42)).toBe('42')
  })

  it('extracts text from Codex output_text arrays', () => {
    const output = [
      { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'input_text', text: 'file1.txt\nfile2.txt\n' },
    ]
    expect(stringifyToolPayload(output)).toBe(
      'Script completed\nWall time 0.1 seconds\nOutput:\nfile1.txt\nfile2.txt\n',
    )
  })

  it('extracts text from arrays with a single part', () => {
    const output = [{ type: 'text', text: 'hello' }]
    expect(stringifyToolPayload(output)).toBe('hello')
  })

  it('falls back to JSON.stringify for non-text arrays', () => {
    const output = [{ foo: 'bar' }, { baz: 42 }]
    expect(stringifyToolPayload(output)).toBe(JSON.stringify(output, null, 2))
  })

  it('handles null and undefined', () => {
    expect(stringifyToolPayload(null)).toBe('')
    expect(stringifyToolPayload(undefined)).toBe('')
  })
})

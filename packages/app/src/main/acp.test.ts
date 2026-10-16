import { describe, expect, it } from 'vitest'
import { AcpManager } from './acp.js'

describe('AcpManager builtin agents', () => {
  it('includes Gemini CLI as a native ACP agent', () => {
    const manager = new AcpManager()
    const builtins = manager.getBuiltinAgents()

    expect(builtins['gemini']).toEqual({
      name: 'Gemini CLI',
      bin: 'gemini',
      acpMode: 'native',
    })
  })

  it('includes Claude Code as an extension ACP agent', () => {
    const manager = new AcpManager()
    const builtins = manager.getBuiltinAgents()

    expect(builtins['claude']).toEqual({
      name: 'Claude Code',
      bin: 'claude',
      acpMode: 'extension',
    })
  })

  it('includes Codex CLI as an extension ACP agent', () => {
    const manager = new AcpManager()
    const builtins = manager.getBuiltinAgents()

    expect(builtins['codex']).toEqual({
      name: 'Codex CLI',
      bin: 'codex',
      acpMode: 'extension',
    })
  })

  it('resolves ACP adapter via SPOOL_ACP_AGENT_BIN override', async () => {
    const manager = new AcpManager()
    const configs = (manager as unknown as { getEffectiveConfigs: () => Record<string, unknown> }).getEffectiveConfigs?.()
      ?? (manager as unknown as Record<string, unknown>)
    const prev = process.env['SPOOL_ACP_AGENT_BIN']
    try {
      process.env['SPOOL_ACP_AGENT_BIN'] = '/custom/mock-acp.js'
      const res = await (manager as unknown as {
        resolveAcpExtension: (name: string, config: unknown) => Promise<{ path: string; native: boolean }>
      }).resolveAcpExtension('claude', { name: 'Claude Code', bin: 'claude', acpMode: 'extension' })
      expect(res).toEqual({ path: '/custom/mock-acp.js', native: false })
    } finally {
      if (prev !== undefined) process.env['SPOOL_ACP_AGENT_BIN'] = prev
      else delete process.env['SPOOL_ACP_AGENT_BIN']
    }
  })

  it('resolves ACP adapter via SPOOL_ACP_<NAME>_BIN override', async () => {
    const manager = new AcpManager()
    const prev = process.env['SPOOL_ACP_CLAUDE_BIN']
    try {
      process.env['SPOOL_ACP_CLAUDE_BIN'] = '/usr/bin/claude-agent-acp'
      const res = await (manager as unknown as {
        resolveAcpExtension: (name: string, config: unknown) => Promise<{ path: string; native: boolean }>
      }).resolveAcpExtension('claude', { name: 'Claude Code', bin: 'claude', acpMode: 'extension' })
      expect(res).toEqual({ path: '/usr/bin/claude-agent-acp', native: true })
    } finally {
      if (prev !== undefined) process.env['SPOOL_ACP_CLAUDE_BIN'] = prev
      else delete process.env['SPOOL_ACP_CLAUDE_BIN']
    }
  })

  it('resolves globally installed claude-agent-acp on PATH', async () => {
    const manager = new AcpManager()
    const res = await (manager as unknown as {
      resolveAcpExtension: (name: string, config: unknown) => Promise<{ path: string; native: boolean }>
    }).resolveAcpExtension('claude', {
      name: 'Claude Code',
      bin: 'claude',
      acpMode: 'extension',
      acpBin: ['claude-agent-acp', 'acp-extension-claude'],
    })
    expect(res.path).toContain('claude-agent-acp')
    expect(res.native).toBe(true)
  })

  it('resolves globally installed codex-acp on PATH', async () => {
    const manager = new AcpManager()
    const res = await (manager as unknown as {
      resolveAcpExtension: (name: string, config: unknown) => Promise<{ path: string; native: boolean }>
    }).resolveAcpExtension('codex', {
      name: 'Codex CLI',
      bin: 'codex',
      acpMode: 'extension',
      acpBin: ['codex-acp', 'acp-extension-codex'],
    })
    expect(res.path).toContain('codex-acp')
    expect(res.native).toBe(true)
  })
})

import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexObserverAdapter } from '../electron/agents/adapters/codex/CodexObserverAdapter'
import { wslRuntimeCommand } from '../electron/agents/adapters/wslRuntimeCommand'
import { parseCodexHook } from '../electron/agents/adapters/codex/CodexHookParser'
import { CodexHookProjector } from '../electron/agents/adapters/codex/CodexHookProjector'
import {
  buildCodexInlineHookConfig,
  codexWindowsHookCommand
} from '../electron/agents/adapters/codex/CodexHookConfig'
import { CODEX_HOOK_CAPABILITIES } from '../electron/agents/adapters/codex/types'
import type { AdapterEvent } from '../electron/agents/adapters/types'
import { wslLaunchOptions } from '../electron/ai-cli-discovery'
import { projectAdapterEvents } from './helpers/agent-projection-contract'

test.describe('Codex observer adapter', () => {
  test('uses only guarded HRack hook transport names', () => {
    const entries = buildCodexInlineHookConfig()
    expect(entries).toHaveLength(11)
    expect(entries.every((entry) => entry.includes('-EncodedCommand'))).toBe(
      true
    )
    const encoded = codexWindowsHookCommand().match(
      /-EncodedCommand ([A-Za-z0-9+/=]+)$/
    )?.[1]
    expect(encoded).toBeTruthy()
    const windowsScript = Buffer.from(encoded!, 'base64').toString('utf16le')
    expect(windowsScript).toContain('HRACK_CODEX_HOOK_BRIDGE_WINDOWS')
    expect(windowsScript).toContain('Test-Path -LiteralPath')
    expect(windowsScript).not.toContain('VIBING_CODEX_')
    const config = entries.join('\n')
    expect(config).not.toContain('VIBING_CODEX_')
  })

  test('falls back to the wrapper directory when cached WSL PATH is unavailable', () => {
    const command = wslRuntimeCommand(
      {
        sessionId: 'session-fallback',
        adapterId: 'codex',
        platform: 'win32',
        workspace: '',
        args: [],
        runDir: 'C:/observer-runs/session-fallback',
        installation: {
          id: 'codex:wsl:fallback',
          definitionId: 'codex',
          runtime: { kind: 'wsl', distro: 'Ubuntu-22.04' },
          resolvedExecutable:
            '/home/user/.nvm/versions/node/v22.22.3/bin/codex',
          detectedVia: 'path',
          verification: 'verified'
        }
      },
      ['features', 'list'],
      'hrack-codex-features'
    )

    expect(command).toEqual({
      file: 'wsl.exe',
      args: [
        '--distribution',
        'Ubuntu-22.04',
        '--exec',
        '/bin/sh',
        '-lc',
        'p="$1"; shift; PATH="$(dirname "$p"):$PATH" exec "$p" "$@"',
        'hrack-codex-features',
        '/home/user/.nvm/versions/node/v22.22.3/bin/codex',
        'features',
        'list'
      ]
    })
  })

  test('projects a prompt and Stop into one structured turn without retaining content', () => {
    const canary = 'SECRET_CODEX_PROMPT_CANARY'
    const prompt = parseCodexHook({
      session_id: 'thr-1',
      turn_id: 'turn-1',
      hook_event_name: 'UserPromptSubmit',
      prompt: canary,
      cwd: 'C:/workspace',
      model: 'gpt-test'
    })
    const stop = parseCodexHook({
      session_id: 'thr-1',
      turn_id: 'turn-1',
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: canary
    })

    expect(prompt).not.toBeNull()
    expect(stop).not.toBeNull()
    expect(JSON.stringify([prompt, stop])).not.toContain(canary)

    const projector = new CodexHookProjector()
    const events = [prompt!, stop!].flatMap((fact, index) =>
      projector.project(fact, 1_000 + index)
    )
    expect(events.map((event) => event.kind)).toEqual([
      'turn.started',
      'thinking.started',
      'turn.completed'
    ])
    expect(events.at(-1)).toMatchObject({
      payload: { turnId: 'turn-1', outcome: 'completed' }
    })
  })

  test('deduplicates tool replay and lets tool terminal overwrite linked attention', () => {
    const canary = 'SECRET_CODEX_TOOL_CANARY'
    const values = [
      {
        session_id: 'thr-1',
        turn_id: 'turn-2',
        hook_event_name: 'UserPromptSubmit',
        prompt: canary
      },
      {
        session_id: 'thr-1',
        turn_id: 'turn-2',
        hook_event_name: 'PreToolUse',
        tool_use_id: 'call-1',
        tool_name: 'Bash',
        tool_input: { command: `npm test -- ${canary}` }
      },
      {
        session_id: 'thr-1',
        turn_id: 'turn-2',
        hook_event_name: 'PreToolUse',
        tool_use_id: 'call-1',
        tool_name: 'Bash',
        tool_input: { command: `npm test -- ${canary}` }
      },
      {
        session_id: 'thr-1',
        turn_id: 'turn-2',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: `npm test -- ${canary}` }
      },
      {
        session_id: 'thr-1',
        turn_id: 'turn-2',
        hook_event_name: 'PostToolUse',
        tool_use_id: 'call-1',
        tool_name: 'Bash',
        tool_input: { command: `npm test -- ${canary}` },
        tool_response: canary
      }
    ]
    const facts = values.map(parseCodexHook)
    expect(facts.every(Boolean)).toBe(true)
    expect(JSON.stringify(facts)).not.toContain(canary)

    const projector = new CodexHookProjector()
    const events = facts.flatMap((fact, index) =>
      projector.project(fact!, 2_000 + index)
    )
    expect(events.map((event) => event.kind)).toEqual([
      'turn.started',
      'thinking.started',
      'thinking.completed',
      'tool.started',
      'approval.requested',
      'tool.completed'
    ])
    const projection = projectAdapterEvents(events, {
      adapterId: 'codex',
      source: 'hook',
      capabilities: CODEX_HOOK_CAPABILITIES
    })
    expect(events.find((event) => event.kind === 'tool.started')).toMatchObject({
      payload: {
        callId: 'call-1',
        turnId: 'turn-2',
        name: 'Bash',
        category: 'shell'
      }
    })
    expect(
      events.find((event) => event.kind === 'approval.requested')
    ).toMatchObject({ payload: { callId: 'call-1', category: 'command' } })
    expect(projection.pendingAttentionCount).toBe(0)
  })

  test('uses Stop as the parent terminal for orphaned tools and ambiguous approvals', () => {
    const projector = new CodexHookProjector()
    const facts = [
      parseCodexHook({
        session_id: 'thr-retry',
        turn_id: 'turn-retry',
        hook_event_name: 'UserPromptSubmit'
      }),
      parseCodexHook({
        session_id: 'thr-retry',
        turn_id: 'turn-retry',
        hook_event_name: 'PreToolUse',
        tool_use_id: 'failed-before-permission',
        tool_name: 'Bash',
        tool_input: { command: 'node -e retry' }
      }),
      parseCodexHook({
        session_id: 'thr-retry',
        turn_id: 'turn-retry',
        hook_event_name: 'PreToolUse',
        tool_use_id: 'approved-retry',
        tool_name: 'Bash',
        tool_input: { command: 'node -e retry' }
      }),
      parseCodexHook({
        session_id: 'thr-retry',
        turn_id: 'turn-retry',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'node -e retry' }
      }),
      parseCodexHook({
        session_id: 'thr-retry',
        turn_id: 'turn-retry',
        hook_event_name: 'PostToolUse',
        tool_use_id: 'approved-retry',
        tool_name: 'Bash'
      }),
      parseCodexHook({
        session_id: 'thr-retry',
        turn_id: 'turn-retry',
        hook_event_name: 'Stop',
        stop_hook_active: false
      })
    ]
    expect(facts.every(Boolean)).toBe(true)
    const events = facts.flatMap((fact) => projector.project(fact!))
    const projection = projectAdapterEvents(events, {
      adapterId: 'codex',
      source: 'hook',
      capabilities: CODEX_HOOK_CAPABILITIES
    })
    expect(events.at(-1)?.kind).toBe('turn.completed')
    expect(events.filter((event) => event.kind === 'approval.resolved')).toHaveLength(0)
    expect(events.filter((event) => event.kind === 'tool.failed')).toHaveLength(0)
    expect(projection.status).toBe('done')
    expect(projection.pendingAttentionCount).toBe(0)
    expect(projection.activeToolCount).toBe(0)
  })

  test('projects subagents as Agent tools without counting compaction as a tool', () => {
    const projector = new CodexHookProjector()
    const facts = [
      parseCodexHook({
        session_id: 'thr-agent',
        turn_id: 'turn-agent',
        hook_event_name: 'UserPromptSubmit'
      }),
      parseCodexHook({
        session_id: 'thr-agent',
        turn_id: 'turn-agent',
        hook_event_name: 'PreCompact',
        trigger: 'auto'
      }),
      parseCodexHook({
        session_id: 'thr-agent',
        turn_id: 'turn-agent',
        hook_event_name: 'PostCompact',
        trigger: 'auto'
      }),
      parseCodexHook({
        session_id: 'thr-agent',
        turn_id: 'turn-agent',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-private-id',
        agent_type: 'reviewer'
      }),
      parseCodexHook({
        session_id: 'thr-agent',
        turn_id: 'turn-agent',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-private-id',
        agent_type: 'reviewer',
        last_assistant_message: 'SECRET_SUBAGENT_MESSAGE'
      })
    ]
    expect(facts.every(Boolean)).toBe(true)
    expect(JSON.stringify(facts)).not.toContain('SECRET_SUBAGENT_MESSAGE')
    const events = facts.flatMap((fact) => projector.project(fact!))
    expect(events.map((event) => event.kind)).toEqual([
      'turn.started',
      'thinking.started',
      'thinking.completed',
      'tool.started',
      'tool.completed'
    ])
    expect(events[3]).toMatchObject({
      payload: {
        callId: 'codex:agent:agent-private-id',
        turnId: 'turn-agent',
        name: 'Agent',
        category: 'other'
      }
    })
  })

  test('synthesizes a bounded lifecycle when PostToolUse arrives before PreToolUse', () => {
    const projector = new CodexHookProjector()
    const completed = parseCodexHook({
      session_id: 'thr-order',
      turn_id: 'turn-order',
      hook_event_name: 'PostToolUse',
      tool_use_id: 'call-order',
      tool_name: 'Bash'
    })!
    const lateStart = parseCodexHook({
      session_id: 'thr-order',
      turn_id: 'turn-order',
      hook_event_name: 'PreToolUse',
      tool_use_id: 'call-order',
      tool_name: 'Bash'
    })!
    const events = [
      ...projector.project(completed),
      ...projector.project(lateStart)
    ]
    expect(events.map((event) => event.kind)).toEqual([
      'turn.started',
      'tool.started',
      'tool.completed'
    ])
  })

  test('reopens a completed native turn when a continuation emits another tool', () => {
    const projector = new CodexHookProjector()
    const facts = [
      parseCodexHook({
        session_id: 'thr-continuation',
        turn_id: 'turn-continuation',
        hook_event_name: 'UserPromptSubmit'
      }),
      parseCodexHook({
        session_id: 'thr-continuation',
        turn_id: 'turn-continuation',
        hook_event_name: 'Stop'
      }),
      parseCodexHook({
        session_id: 'thr-continuation',
        turn_id: 'turn-continuation',
        hook_event_name: 'PreToolUse',
        tool_use_id: 'continued-call',
        tool_name: 'Bash'
      }),
      parseCodexHook({
        session_id: 'thr-continuation',
        turn_id: 'turn-continuation',
        hook_event_name: 'PostToolUse',
        tool_use_id: 'continued-call',
        tool_name: 'Bash'
      }),
      parseCodexHook({
        session_id: 'thr-continuation',
        turn_id: 'turn-continuation',
        hook_event_name: 'Stop'
      })
    ]
    const events = facts.flatMap((fact) => projector.project(fact!))
    const starts = events.filter((event) => event.kind === 'turn.started')
    expect(starts).toHaveLength(2)
    expect(starts[1].payload.turnId).not.toBe(starts[0].payload.turnId)
    expect(
      events.filter((event) => event.kind === 'turn.completed')
    ).toHaveLength(2)
  })

  test('treats native SessionEnd as an idle correlation reset, never a PTY exit', () => {
    const projector = new CodexHookProjector()
    const facts = [
      parseCodexHook({
        session_id: 'thr-1',
        hook_event_name: 'SessionStart',
        source: 'startup',
        cwd: 'C:/workspace'
      }),
      parseCodexHook({
        session_id: 'thr-1',
        turn_id: 'turn-3',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'private'
      }),
      parseCodexHook({
        session_id: 'thr-1',
        hook_event_name: 'SessionEnd',
        reason: 'other'
      })
    ]
    expect(facts.every(Boolean)).toBe(true)
    const events = facts.flatMap((fact, index) =>
      projector.project(fact!, 3_000 + index)
    )
    expect(events.map((event) => event.kind)).toEqual([
      'session.idle',
      'turn.started',
      'thinking.started',
      'turn.completed',
      'session.idle'
    ])
    expect(events.some((event) => event.kind === 'session.exited')).toBe(false)
    expect(events.at(-1)).toMatchObject({
      payload: { reason: 'protocol-idle', confidence: 'high' }
    })
  })

  test('honors explicit inline Hook overrides and degrades without probing', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'hrack-codex-conflict-'))
    let probed = false
    const adapter = new CodexObserverAdapter({
      runCommand: async () => {
        probed = true
        return { code: 0, stdout: 'hooks stable true\n' }
      }
    })
    try {
      const prepared = await adapter.prepare({
        sessionId: 'session-conflict',
        adapterId: 'codex',
        platform: 'win32',
        workspace: '',
        args: ['--config=features.hooks=false'],
        runDir,
        installation: {
          id: 'codex:conflict',
          definitionId: 'codex',
          runtime: { kind: 'host', platform: 'windows' },
          resolvedExecutable: 'codex.exe',
          detectedVia: 'path',
          verification: 'verified'
        }
      })
      expect(probed).toBe(false)
      expect(prepared.launch).toEqual({})
      expect(prepared.capabilities?.tools).toBe('none')
      const events: AdapterEvent[] = []
      await prepared.attach(
        {
          sessionId: 'session-conflict',
          installationId: 'codex:conflict',
          adapterId: 'codex',
          ptyId: 'pty-conflict',
          runDir,
          cols: 80,
          rows: 24
        },
        (event) => events.push(event)
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'observer.degraded',
          payload: expect.objectContaining({
            reason: 'codex-hook-config-conflict'
          })
        })
      )
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test('prepares a per-session host drop and delivers hooks through the adapter seam', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'hrack-codex-adapter-'))
    const adapter = new CodexObserverAdapter({
      runCommand: async () => ({ code: 0, stdout: 'hooks stable true\n' }),
      pollIntervalMs: 10
    })
    try {
      const prepared = await adapter.prepare({
        sessionId: 'session-1',
        adapterId: 'codex',
        platform: 'win32',
        workspace: 'C:/workspace',
        args: [],
        runDir,
        installation: {
          id: 'codex:windows',
          definitionId: 'codex',
          runtime: { kind: 'host', platform: 'windows' },
          resolvedExecutable: 'C:/bin/codex.exe',
          detectedVia: 'path',
          version: 'codex-cli 0.146.0',
          verification: 'verified'
        }
      })

      expect(prepared.launch.prependArgs).toHaveLength(14)
      expect(prepared.launch.prependArgs?.[0]).toContain(
        '--config=hooks.SessionStart=[{matcher=".*"'
      )
      expect(prepared.launch.prependArgs).not.toContain(
        '--dangerously-bypass-hook-trust'
      )
      const dropDir = prepared.launch.env?.HRACK_CODEX_HOOK_DROP
      expect(dropDir).toBeTruthy()
      expect(prepared.launch.prependArgs).toContain(
        `--config=shell_environment_policy.set.HRACK_CODEX_HOOK_DROP=${JSON.stringify(dropDir)}`
      )
      expect(prepared.launch.prependArgs).toContain(
        `--config=shell_environment_policy.set.HRACK_CODEX_HOOK_BRIDGE_WINDOWS=${JSON.stringify(prepared.launch.env?.HRACK_CODEX_HOOK_BRIDGE_WINDOWS)}`
      )

      const events: AdapterEvent[] = []
      const handle = await prepared.attach(
        {
          sessionId: 'session-1',
          installationId: 'codex:windows',
          adapterId: 'codex',
          ptyId: 'pty-1',
          runDir,
          cols: 80,
          rows: 24
        },
        (event) => events.push(event)
      )
      await writeFile(
        join(dropDir!, '0001.json'),
        JSON.stringify({
          session_id: 'thr-real',
          hook_event_name: 'SessionStart',
          source: 'startup'
        })
      )
      await expect
        .poll(() => events.map((event) => event.kind))
        .toContain('session.idle')

      await handle.dispose()
      await prepared.dispose()
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test('preserves non-ASCII hook JSON through the real Windows byte bridge', async () => {
    test.skip(process.platform !== 'win32')
    const runDir = await mkdtemp(join(tmpdir(), 'hrack-codex-bytes-'))
    const adapter = new CodexObserverAdapter({
      pollIntervalMs: 20,
      runCommand: async () => ({ code: 0, stdout: 'hooks stable true\n' })
    })
    try {
      const prepared = await adapter.prepare({
        sessionId: 'session-bytes',
        adapterId: 'codex',
        platform: 'win32',
        workspace: 'C:/工作区',
        args: [],
        runDir,
        installation: {
          id: 'codex:bytes',
          definitionId: 'codex',
          runtime: { kind: 'host', platform: 'windows' },
          resolvedExecutable: 'codex.exe',
          detectedVia: 'path',
          verification: 'verified'
        }
      })
      const events: AdapterEvent[] = []
      const handle = await prepared.attach(
        {
          sessionId: 'session-bytes',
          installationId: 'codex:bytes',
          adapterId: 'codex',
          ptyId: 'pty-bytes',
          runDir,
          cols: 80,
          rows: 24
        },
        (event) => events.push(event)
      )
      const env = { ...process.env, ...prepared.launch.env }
      const command = codexWindowsHookCommand()
      for (const [index, outer] of [
        { file: 'cmd.exe', args: ['/D', '/S', '/C', command] },
        { file: 'pwsh.exe', args: ['-NoProfile', '-Command', command] }
      ].entries()) {
        const child = spawn(outer.file, outer.args, {
          env,
          stdio: ['pipe', 'ignore', 'pipe'],
          windowsHide: true
        })
        let stderr = ''
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk
        })
        child.stdin.end(
          Buffer.from(
            JSON.stringify({
              session_id: `原生会话-${index}`,
              hook_event_name: 'SessionStart',
              source: 'startup',
              cwd: 'C:/工作区/中文'
            }),
            'utf8'
          )
        )
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code) =>
            code === 0
              ? resolve()
              : reject(
                  new Error(
                    `${outer.file} bridge exited ${code}: ${stderr.trim()}`
                  )
                )
          )
        })
        await expect
          .poll(
            () => events.filter((event) => event.kind === 'session.idle').length,
            { message: `${outer.file} should deliver hook JSON: ${stderr}` }
          )
          .toBe(index + 1)
      }
      expect(JSON.stringify(events)).not.toContain('工作区')
      await handle.dispose()
      await prepared.dispose()
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test('translates and round-trips a WSL drop without using curl.exe', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'hrack-codex-wsl-'))
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const adapter = new CodexObserverAdapter({
      runCommand: async (file, args) => {
        calls.push({ file, args })
        if (args.includes('features')) {
          return { code: 0, stdout: 'hooks stable true\n' }
        }
        if (args.includes('wslpath')) {
          return { code: 0, stdout: '/mnt/c/hrack-run\n' }
        }
        const nonce = args.at(-1)
        if (args.includes('hrack-codex-probe') && nonce) {
          await writeFile(join(runDir, 'codex-drop', `${nonce}.probe`), nonce)
          return { code: 0, stdout: '' }
        }
        return { code: 1, stdout: '' }
      }
    })
    try {
      const prepared = await adapter.prepare({
        sessionId: 'session-wsl',
        adapterId: 'codex',
        platform: 'win32',
        workspace: 'C:/workspace',
        args: [],
        runtimeEnvironment: {
          PATH: '/home/jesse/.nvm/versions/node/v22.22.3/bin:/usr/bin:/bin'
        },
        runDir,
        installation: {
          id: 'codex:wsl',
          definitionId: 'codex',
          runtime: { kind: 'wsl', distro: 'Ubuntu-22.04' },
          resolvedExecutable: '/home/jesse/.local/bin/codex',
          detectedVia: 'path',
          version: 'codex-cli 0.145.0',
          verification: 'verified'
        }
      })
      expect(prepared.launch.env?.HRACK_CODEX_HOOK_DROP).toBe(
        '/mnt/c/hrack-run/codex-drop'
      )
      expect(prepared.launch.env?.HRACK_CODEX_HOOK_BRIDGE).toBe(
        '/mnt/c/hrack-run/codex-hook-bridge.sh'
      )
      expect(calls[0]).toEqual({
        file: 'wsl.exe',
        args: [
          '--distribution',
          'Ubuntu-22.04',
          '--exec',
          'env',
          'PATH=/home/jesse/.nvm/versions/node/v22.22.3/bin:/usr/bin:/bin',
          '/home/jesse/.local/bin/codex',
          'features',
          'list'
        ]
      })
      expect(
        calls.some(({ file, args }) =>
          [file, ...args].some((value) => value.toLowerCase().includes('curl.exe'))
        )
      ).toBe(false)
      await prepared.dispose()
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test('passes hook bridge variables into the WSL process, not only wsl.exe', () => {
    const launch = wslLaunchOptions(
      {
        id: 'codex:wsl:test',
        definitionId: 'codex',
        runtime: { kind: 'wsl', distro: 'Ubuntu-Test' },
        resolvedExecutable: '/home/test/bin/codex',
        detectedVia: 'path',
        verification: 'verified'
      },
      '/home/test',
      [],
      {
        env: {
          HRACK_CODEX_HOOK_DROP: '/mnt/c/hrack-run/codex-drop',
          HRACK_CODEX_HOOK_BRIDGE: '/mnt/c/hrack-run/codex-hook-bridge.sh'
        }
      }
    )

    expect(launch.shell).toBe('wsl.exe')
    expect(launch.args).toEqual([
      '--distribution',
      'Ubuntu-Test',
      '--cd',
      '/home/test',
      '--exec',
      'env',
      'HRACK_CODEX_HOOK_DROP=/mnt/c/hrack-run/codex-drop',
      'HRACK_CODEX_HOOK_BRIDGE=/mnt/c/hrack-run/codex-hook-bridge.sh',
      '/home/test/bin/codex'
    ])
  })
})

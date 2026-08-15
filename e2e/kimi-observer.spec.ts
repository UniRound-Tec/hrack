import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildKimiManagedHookBlock,
  kimiWindowsBridgeScript,
  mergeKimiManagedHooks
} from '../electron/agents/adapters/kimi/KimiHookConfig'
import { ensureKimiManagedHooks } from '../electron/agents/adapters/kimi/KimiConfigStore'
import { parseKimiHook } from '../electron/agents/adapters/kimi/KimiHookParser'
import { KimiHookProjector } from '../electron/agents/adapters/kimi/KimiHookProjector'
import { KimiObserverAdapter } from '../electron/agents/adapters/kimi/KimiObserverAdapter'
import { ensureWslKimiManagedHooks } from '../electron/agents/adapters/kimi/KimiWslConfigStore'
import type { AdapterEvent } from '../electron/agents/adapters/types'
import { cliDefinitions } from '../electron/ai-cli-discovery'
import { projectAdapterEvents } from './helpers/agent-projection-contract'
import { KIMI_HOOK_CAPABILITIES } from '../electron/agents/adapters/kimi/types'

test.describe('Kimi observer adapter', () => {
  const windowsManagedCommand = (): string => {
    const line = buildKimiManagedHookBlock('windows')
      .split('\n')
      .find((candidate) => candidate.startsWith('command = '))
    if (!line) throw new Error('managed Kimi command is missing')
    return JSON.parse(line.slice('command = '.length)) as string
  }

  test('advertises Kimi as an implemented observer integration', () => {
    expect(cliDefinitions.find((definition) => definition.id === 'kimi')).toMatchObject({
      adapterId: 'kimi',
      observerImplemented: true
    })
  })

  test('installs one managed Hook block without rewriting user config', () => {
    const existing = [
      '# 用户配置',
      'default_model = "kimi-for-coding"',
      '',
      '[[hooks]]',
      'event = "Notification"',
      'command = "notify-user"'
    ].join('\n')

    const result = mergeKimiManagedHooks(existing, 'windows')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.content.startsWith(`${existing}\n\n`)).toBe(true)
    expect(result.content.match(/# >>> hrack:kimi-observer:v1/g)).toHaveLength(1)
    expect(result.content.match(/# <<< hrack:kimi-observer:v1/g)).toHaveLength(1)
    expect(result.content.match(/^\[\[hooks\]\]$/gm)).toHaveLength(14)
    expect(result.content).toContain('event = "Interrupt"')
    expect(result.content).toContain('HRACK_KIMI_HOOK_BRIDGE_WINDOWS')
  })

  test('is byte-stable when the managed Hook block is already current', () => {
    const installed = mergeKimiManagedHooks('', 'posix')
    expect(installed.ok).toBe(true)
    if (!installed.ok) return

    const repeated = mergeKimiManagedHooks(installed.content, 'posix')

    expect(repeated).toEqual({
      ok: true,
      changed: false,
      content: installed.content
    })
  })

  test('upgrades one complete older managed block without touching surrounding TOML', () => {
    const prefix = '# user prefix\ndefault_model = "custom"\n\n'
    const suffix = '\n\n# user suffix\n[providers.custom]\nbase_url = "https://example.test"\n'
    const oldBlock = [
      '# >>> hrack:kimi-observer:v0',
      '[[hooks]]',
      'event = "Stop"',
      'command = "old-command"',
      '# <<< hrack:kimi-observer:v0'
    ].join('\n')

    const result = mergeKimiManagedHooks(`${prefix}${oldBlock}${suffix}`, 'windows')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.content.startsWith(prefix)).toBe(true)
    expect(result.content.endsWith(suffix)).toBe(true)
    expect(result.content).not.toContain('kimi-observer:v0')
    expect(result.content.match(/# >>> hrack:kimi-observer:v1/g)).toHaveLength(1)
  })

  test('migrates the legacy Vibing managed block instead of installing duplicates', () => {
    const legacyBlock = [
      '# >>> vibing:kimi-observer:v1',
      '[[hooks]]',
      'event = "Stop"',
      'command = "legacy-command"',
      '# <<< vibing:kimi-observer:v1'
    ].join('\n')

    const result = mergeKimiManagedHooks(legacyBlock, 'windows')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).not.toContain('vibing:kimi-observer')
    expect(result.content.match(/# >>> hrack:kimi-observer:v1/g)).toHaveLength(1)
    expect(result.content.match(/^\[\[hooks\]\]$/gm)).toHaveLength(13)
  })

  test('is a silent no-op outside a HRack-launched Windows session', async () => {
    test.skip(process.platform !== 'win32')
    const runDir = await mkdtemp(join(tmpdir(), 'hrack-kimi-noop-'))
    const sentinel = join(runDir, 'unexpected.txt')
    const bridge = join(runDir, 'should-not-run.ps1')
    try {
      await writeFile(
        bridge,
        `[IO.File]::WriteAllText(${JSON.stringify(sentinel)}, 'ran')\n`,
        'utf8'
      )
      const env = { ...process.env }
      delete env.HRACK_KIMI_HOOK_BRIDGE_WINDOWS
      delete env.HRACK_KIMI_HOOK_BRIDGE
      delete env.HRACK_KIMI_HOOK_DROP
      const child = spawn(windowsManagedCommand(), {
        shell: true,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
      child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
      child.stdin.end('{"ignored":true}')
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })

      expect(code).toBe(0)
      expect(stdout).toBe('')
      expect(stderr).toBe('')
      await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test('preserves UTF-8 JSON through the real Windows bridge', async () => {
    test.skip(process.platform !== 'win32')
    const runDir = await mkdtemp(join(tmpdir(), 'hrack-kimi-bytes-'))
    const dropDir = join(runDir, 'drop')
    const bridge = join(runDir, 'bridge.ps1')
    const payload = JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: '原生会话',
      cwd: 'C:/工作区/中文'
    })
    try {
      await mkdir(dropDir)
      await writeFile(bridge, kimiWindowsBridgeScript(), 'utf8')
      const child = spawn(windowsManagedCommand(), {
        shell: true,
        env: {
          ...process.env,
          HRACK_KIMI_HOOK_DROP: dropDir,
          HRACK_KIMI_HOOK_BRIDGE_WINDOWS: bridge
        },
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true
      })
      child.stdin.end(Buffer.from(payload, 'utf8'))
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`bridge exited ${code}`))
        )
      })

      const files = (await readdir(dropDir)).filter((name) => name.endsWith('.json'))
      expect(files).toHaveLength(1)
      expect(await readFile(join(dropDir, files[0]), 'utf8')).toBe(payload)
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test('leaves the user config unchanged when Kimi rejects the candidate', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'hrack-kimi-config-'))
    const configPath = join(configDir, 'config.toml')
    const original = '# 用户配置\ndefault_model = "kimi-for-coding"\n'
    let candidate = ''
    try {
      await writeFile(configPath, original, 'utf8')

      const result = await ensureKimiManagedHooks({
        configPath,
        platform: 'windows',
        validate: async (candidatePath) => {
          candidate = await readFile(candidatePath, 'utf8')
          return false
        }
      })

      expect(result).toEqual({
        ok: false,
        reason: 'kimi-config-validation-failed'
      })
      expect(candidate).toContain('# >>> hrack:kimi-observer:v1')
      expect(await readFile(configPath, 'utf8')).toBe(original)
      expect(await readdir(configDir)).toEqual(['config.toml'])
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('accepts the generated block with an installed Kimi config doctor', async () => {
    test.skip(process.env.HRACK_E2E_REAL_KIMI !== '1')
    const configDir = await mkdtemp(join(tmpdir(), 'hrack-kimi-real-doctor-'))
    const configPath = join(configDir, 'config.toml')
    try {
      const result = await ensureKimiManagedHooks({
        configPath,
        platform: process.platform === 'win32' ? 'windows' : 'posix',
        validate: (candidatePath) =>
          new Promise<boolean>((resolve) => {
            const child = spawn('kimi', ['doctor', 'config', candidatePath], {
              stdio: ['ignore', 'ignore', 'ignore'],
              windowsHide: true
            })
            child.once('error', () => resolve(false))
            child.once('close', (code) => resolve(code === 0))
          })
      })

      expect(result).toEqual({ ok: true, changed: true })
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('serializes concurrent ensures and validates the managed block once', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'hrack-kimi-concurrent-'))
    const configPath = join(configDir, 'config.toml')
    let validationCalls = 0
    let allowFirstValidation!: () => void
    const firstValidationMayFinish = new Promise<void>(
      (resolve) => (allowFirstValidation = resolve)
    )
    let firstValidationEntered!: () => void
    const firstValidationStarted = new Promise<void>(
      (resolve) => (firstValidationEntered = resolve)
    )
    const validate = async (): Promise<boolean> => {
      validationCalls += 1
      if (validationCalls === 1) {
        firstValidationEntered()
        await firstValidationMayFinish
      }
      return true
    }
    try {
      const first = ensureKimiManagedHooks({
        configPath,
        platform: 'windows',
        validate
      })
      await firstValidationStarted
      const second = ensureKimiManagedHooks({
        configPath,
        platform: 'windows',
        validate
      })
      allowFirstValidation()

      const results = await Promise.all([first, second])
      expect(results).toEqual([
        { ok: true, changed: true },
        { ok: true, changed: false }
      ])
      expect(validationCalls).toBe(1)
      const installed = await readFile(configPath, 'utf8')
      expect(installed.match(/# >>> hrack:kimi-observer:v1/g)).toHaveLength(1)
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('retries from the user-edited config when it changes during validation', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'hrack-kimi-user-edit-'))
    const configPath = join(configDir, 'config.toml')
    const original = 'default_model = "kimi-for-coding"\n'
    const edited = '# edited while HRack validated\n' + original
    let validationCalls = 0
    try {
      await writeFile(configPath, original, 'utf8')
      const result = await ensureKimiManagedHooks({
        configPath,
        platform: 'windows',
        validate: async () => {
          validationCalls += 1
          if (validationCalls === 1) await writeFile(configPath, edited, 'utf8')
          return true
        }
      })

      expect(result).toEqual({ ok: true, changed: true })
      expect(validationCalls).toBe(2)
      const installed = await readFile(configPath, 'utf8')
      expect(installed.startsWith(edited)).toBe(true)
      expect(installed.match(/# >>> hrack:kimi-observer:v1/g)).toHaveLength(1)
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('times out on a live config lock without touching user config', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'hrack-kimi-lock-'))
    const configPath = join(configDir, 'config.toml')
    const lockPath = `${configPath}.vibing.lock`
    const original = '# keep this byte-for-byte\n'
    try {
      await writeFile(configPath, original, 'utf8')
      await mkdir(lockPath)
      await writeFile(
        join(lockPath, 'owner.json'),
        JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: 'other' }),
        'utf8'
      )

      const result = await ensureKimiManagedHooks({
        configPath,
        platform: 'windows',
        validate: async () => true,
        lockTimeoutMs: 30,
        lockPollIntervalMs: 5,
        staleLockMs: 60_000
      })

      expect(result).toEqual({ ok: false, reason: 'kimi-config-lock-timeout' })
      expect(await readFile(configPath, 'utf8')).toBe(original)
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('projects one prompt and Stop without retaining conversation content', () => {
    const canary = 'SECRET_KIMI_CONVERSATION_CANARY'
    const prompt = parseKimiHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'kimi-session-1',
      cwd: 'C:/workspace',
      prompt: canary,
      is_steer: false
    })
    const stop = parseKimiHook({
      hook_event_name: 'Stop',
      session_id: 'kimi-session-1',
      stop_hook_active: false,
      last_assistant_message: canary
    })

    expect(prompt).not.toBeNull()
    expect(stop).not.toBeNull()
    expect(JSON.stringify([prompt, stop])).not.toContain(canary)

    const projector = new KimiHookProjector()
    const events = [prompt!, stop!].flatMap((fact, index) =>
      projector.project(fact, 1_000 + index)
    )
    expect(events.map((event) => event.kind)).toEqual([
      'turn.started',
      'thinking.started',
      'turn.completed'
    ])
    const projection = projectAdapterEvents(events, {
      adapterId: 'kimi',
      source: 'hook',
      capabilities: KIMI_HOOK_CAPABILITIES
    })
    expect(events.at(-1)).toMatchObject({
      payload: {
        turnId: 'kimi:kimi-session-1:turn:1',
        outcome: 'completed'
      }
    })
    expect(projection.status).toBe('done')
  })

  test('reconciles out-of-order approval and tool terminal hooks', () => {
    const facts = [
      parseKimiHook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'kimi-session-order'
      }),
      parseKimiHook({
        hook_event_name: 'PermissionResult',
        session_id: 'kimi-session-order',
        turn_id: 1,
        tool_call_id: 'call-order',
        tool_name: 'ReadFile',
        decision: 'approved'
      }),
      parseKimiHook({
        hook_event_name: 'PermissionRequest',
        session_id: 'kimi-session-order',
        turn_id: 1,
        tool_call_id: 'call-order',
        tool_name: 'ReadFile'
      }),
      parseKimiHook({
        hook_event_name: 'PostToolUse',
        session_id: 'kimi-session-order',
        tool_call_id: 'call-order',
        tool_name: 'ReadFile'
      }),
      parseKimiHook({
        hook_event_name: 'Stop',
        session_id: 'kimi-session-order'
      })
    ]
    expect(facts.every(Boolean)).toBe(true)

    const projector = new KimiHookProjector()
    const events = facts.flatMap((fact, index) =>
      projector.project(fact!, 2_000 + index)
    )
    const projection = projectAdapterEvents(events, {
      adapterId: 'kimi',
      source: 'hook',
      capabilities: KIMI_HOOK_CAPABILITIES
    })

    const kinds = events.map((event) => event.kind)
    expect(kinds.indexOf('approval.resolved')).toBeLessThan(
      kinds.indexOf('approval.requested')
    )
    const resolved = events.filter((event) => event.kind === 'approval.resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ payload: { decision: 'approved' } })
    expect(events.filter((event) => event.kind === 'tool.started')).toHaveLength(1)
    expect(projection.status).toBe('done')
    expect(projection.pendingAttentionCount).toBe(0)
  })

  test('resolves a permission request that arrives after its tool completed', () => {
    const facts = [
      parseKimiHook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'kimi-session-late-permission'
      }),
      parseKimiHook({
        hook_event_name: 'PreToolUse',
        session_id: 'kimi-session-late-permission',
        tool_call_id: 'call-late',
        tool_name: 'Bash'
      }),
      parseKimiHook({
        hook_event_name: 'PostToolUse',
        session_id: 'kimi-session-late-permission',
        tool_call_id: 'call-late',
        tool_name: 'Bash'
      }),
      parseKimiHook({
        hook_event_name: 'PermissionRequest',
        session_id: 'kimi-session-late-permission',
        turn_id: 1,
        tool_call_id: 'call-late',
        tool_name: 'Bash'
      })
    ]
    expect(facts.every(Boolean)).toBe(true)

    const projector = new KimiHookProjector()
    const events = facts.flatMap((fact, index) =>
      projector.project(fact!, 3_000 + index)
    )

    const projection = projectAdapterEvents(events, {
      adapterId: 'kimi',
      source: 'hook',
      capabilities: KIMI_HOOK_CAPABILITIES
    })

    expect(events.filter((event) => event.kind === 'approval.requested')).toHaveLength(1)
    expect(events.filter((event) => event.kind === 'approval.resolved')).toHaveLength(0)
    expect(projection.status).toBe('working')
    expect(projection.pendingAttentionCount).toBe(0)
  })

  test('does not open a continuation for a late request from a closed turn', () => {
    const facts = [
      parseKimiHook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'kimi-session-closed-turn-request'
      }),
      parseKimiHook({
        hook_event_name: 'PreToolUse',
        session_id: 'kimi-session-closed-turn-request',
        tool_call_id: 'closed-call',
        tool_name: 'Bash'
      }),
      parseKimiHook({
        hook_event_name: 'PostToolUse',
        session_id: 'kimi-session-closed-turn-request',
        tool_call_id: 'closed-call',
        tool_name: 'Bash'
      }),
      parseKimiHook({
        hook_event_name: 'Stop',
        session_id: 'kimi-session-closed-turn-request'
      }),
      parseKimiHook({
        hook_event_name: 'PermissionRequest',
        session_id: 'kimi-session-closed-turn-request',
        tool_call_id: 'closed-call',
        tool_name: 'Bash'
      })
    ]
    expect(facts.every(Boolean)).toBe(true)

    const projector = new KimiHookProjector()
    const events = facts.flatMap((fact, index) =>
      projector.project(fact!, 3_100 + index)
    )
    const projection = projectAdapterEvents(events, {
      adapterId: 'kimi',
      source: 'hook',
      capabilities: KIMI_HOOK_CAPABILITIES
    })

    expect(events.filter((event) => event.kind === 'turn.started')).toHaveLength(1)
    expect(projection.status).toBe('done')
    expect(projection.pendingAttentionCount).toBe(0)
  })

  test('opens a new public turn occurrence when activity continues after Stop', () => {
    const facts = [
      parseKimiHook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'kimi-session-continuation'
      }),
      parseKimiHook({
        hook_event_name: 'Stop',
        session_id: 'kimi-session-continuation'
      }),
      parseKimiHook({
        hook_event_name: 'PreToolUse',
        session_id: 'kimi-session-continuation',
        tool_call_id: 'continued-call',
        tool_name: 'Shell'
      }),
      parseKimiHook({
        hook_event_name: 'PostToolUse',
        session_id: 'kimi-session-continuation',
        tool_call_id: 'continued-call',
        tool_name: 'Shell'
      }),
      parseKimiHook({
        hook_event_name: 'Stop',
        session_id: 'kimi-session-continuation'
      })
    ]
    expect(facts.every(Boolean)).toBe(true)

    const projector = new KimiHookProjector()
    const events = facts.flatMap((fact, index) =>
      projector.project(fact!, 3_000 + index)
    )
    const starts = events.filter((event) => event.kind === 'turn.started')
    const completions = events.filter((event) => event.kind === 'turn.completed')

    expect(starts).toHaveLength(2)
    expect(starts[0].payload.turnId).toBe('kimi:kimi-session-continuation:turn:1')
    expect(starts[1].payload.turnId).toBe('kimi:kimi-session-continuation:turn:2')
    expect(starts[1].payload.turnId).not.toBe(starts[0].payload.turnId)
    expect(starts[1].nativeId).toContain(':continued:')
    expect(completions).toHaveLength(2)
    expect(completions[1].nativeId).not.toBe(completions[0].nativeId)
  })

  test('uses id-less subagent hooks only to keep the root task working', () => {
    const canary = 'SECRET_KIMI_SUBAGENT_CANARY'
    const facts = [
      parseKimiHook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'kimi-session-subagent'
      }),
      parseKimiHook({
        hook_event_name: 'Stop',
        session_id: 'kimi-session-subagent'
      }),
      parseKimiHook({
        hook_event_name: 'SubagentStart',
        session_id: 'kimi-session-subagent',
        agent_name: 'coder',
        prompt: canary
      }),
      parseKimiHook({
        hook_event_name: 'SubagentStop',
        session_id: 'kimi-session-subagent',
        agent_name: 'coder',
        response: canary
      })
    ]
    expect(facts.every(Boolean)).toBe(true)
    expect(JSON.stringify(facts)).not.toContain(canary)
    expect(JSON.stringify(facts)).not.toContain('coder')

    const projector = new KimiHookProjector()
    const events = facts.flatMap((fact, index) =>
      projector.project(fact!, 4_000 + index)
    )
    const starts = events.filter((event) => event.kind === 'turn.started')

    expect(starts).toHaveLength(2)
    expect(starts[1].payload.turnId).not.toBe(starts[0].payload.turnId)
    expect(starts[1].payload.turnId).toBe('kimi:kimi-session-subagent:turn:2')
    expect(events.some((event) => event.kind === 'tool.started')).toBe(false)
  })

  test('rejects non-plain and control-character hook identities', () => {
    const inherited = Object.assign(Object.create({ polluted: true }), {
      hook_event_name: 'SessionStart',
      session_id: 'inherited-session'
    })
    expect(parseKimiHook(inherited)).toBeNull()
    expect(
      parseKimiHook({
        hook_event_name: 'PreToolUse',
        session_id: 'safe-session',
        tool_call_id: 'safe-call',
        tool_name: 'ReadFile\nforged'
      })
    ).toBeNull()
  })

  test('projects an exact tool approval lifecycle without retaining tool content', () => {
    const canary = 'SECRET_KIMI_TOOL_CANARY'
    const facts = [
      parseKimiHook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'kimi-session-tools',
        prompt: canary
      }),
      parseKimiHook({
        hook_event_name: 'PreToolUse',
        session_id: 'kimi-session-tools',
        tool_call_id: 'call-1',
        tool_name: 'Bash',
        tool_input: { command: `npm test -- ${canary}` }
      }),
      parseKimiHook({
        hook_event_name: 'PermissionRequest',
        session_id: 'kimi-session-tools',
        turn_id: 7,
        tool_call_id: 'call-1',
        tool_name: 'Bash',
        action: canary,
        display: { detail: canary }
      }),
      parseKimiHook({
        hook_event_name: 'PermissionResult',
        session_id: 'kimi-session-tools',
        turn_id: 7,
        tool_call_id: 'call-1',
        tool_name: 'Bash',
        decision: 'approved',
        feedback: canary
      }),
      parseKimiHook({
        hook_event_name: 'PostToolUse',
        session_id: 'kimi-session-tools',
        tool_call_id: 'call-1',
        tool_name: 'Bash',
        tool_output: canary
      }),
      parseKimiHook({
        hook_event_name: 'Stop',
        session_id: 'kimi-session-tools'
      })
    ]

    expect(facts.every(Boolean)).toBe(true)
    expect(JSON.stringify(facts)).not.toContain(canary)

    const projector = new KimiHookProjector()
    const events = facts.flatMap((fact) => projector.project(fact!))
    expect(events.map((event) => event.kind)).toEqual([
      'turn.started',
      'thinking.started',
      'thinking.completed',
      'tool.started',
      'approval.requested',
      'approval.resolved',
      'tool.completed',
      'turn.completed'
    ])
    expect(events.find((event) => event.kind === 'tool.started')).toMatchObject({
      payload: {
        callId: 'call-1',
        turnId: 'kimi:kimi-session-tools:turn:1',
        name: 'Bash',
        category: 'shell'
      }
    })
    expect(
      events.find((event) => event.kind === 'approval.requested')
    ).toMatchObject({
      payload: {
        requestId: 'kimi:approval:kimi-session-tools:call-1',
        callId: 'call-1',
        category: 'command'
      }
    })
  })

  test('resolves denied approval and projects a failed tool without leaking errors', () => {
    const canary = 'SECRET_KIMI_FAILURE_CANARY'
    const facts = [
      parseKimiHook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'kimi-session-denied'
      }),
      parseKimiHook({
        hook_event_name: 'PreToolUse',
        session_id: 'kimi-session-denied',
        tool_call_id: 'call-denied',
        tool_name: 'Bash'
      }),
      parseKimiHook({
        hook_event_name: 'PermissionRequest',
        session_id: 'kimi-session-denied',
        tool_call_id: 'call-denied',
        tool_name: 'Bash'
      }),
      parseKimiHook({
        hook_event_name: 'PermissionResult',
        session_id: 'kimi-session-denied',
        tool_call_id: 'call-denied',
        decision: 'denied',
        feedback: canary
      }),
      parseKimiHook({
        hook_event_name: 'PostToolUseFailure',
        session_id: 'kimi-session-denied',
        tool_call_id: 'call-denied',
        tool_name: 'Bash',
        error: canary
      }),
      parseKimiHook({
        hook_event_name: 'Stop',
        session_id: 'kimi-session-denied'
      })
    ]

    expect(facts.every(Boolean)).toBe(true)
    expect(JSON.stringify(facts)).not.toContain(canary)
    const projector = new KimiHookProjector()
    const projected = facts.flatMap((fact) => projector.project(fact!))
    expect(projected.map((event) => event.kind)).toEqual([
      'turn.started',
      'thinking.started',
      'thinking.completed',
      'tool.started',
      'approval.requested',
      'approval.resolved',
      'tool.failed',
      'turn.completed'
    ])
    expect(projected.find((event) => event.kind === 'approval.resolved')).toMatchObject({
      payload: { decision: 'denied' }
    })
    expect(projected.find((event) => event.kind === 'tool.failed')).toMatchObject({
      payload: { callId: 'call-denied', message: 'Tool failed' }
    })
  })

  test('uses Interrupt as a parent terminal without fabricating child results', () => {
    const facts = [
      parseKimiHook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'kimi-session-interrupt'
      }),
      parseKimiHook({
        hook_event_name: 'PreToolUse',
        session_id: 'kimi-session-interrupt',
        tool_call_id: 'call-running',
        tool_name: 'Bash'
      }),
      parseKimiHook({
        hook_event_name: 'PermissionRequest',
        session_id: 'kimi-session-interrupt',
        tool_call_id: 'call-running',
        tool_name: 'Bash'
      }),
      parseKimiHook({
        hook_event_name: 'Interrupt',
        session_id: 'kimi-session-interrupt',
        turn_id: 9,
        reason: 'SECRET_INTERRUPT_REASON'
      })
    ]
    expect(facts.every(Boolean)).toBe(true)
    expect(JSON.stringify(facts)).not.toContain('SECRET_INTERRUPT_REASON')

    const projector = new KimiHookProjector()
    const events = facts.flatMap((fact) => projector.project(fact!))
    const projection = projectAdapterEvents(events, {
      adapterId: 'kimi',
      source: 'hook',
      capabilities: KIMI_HOOK_CAPABILITIES
    })

    expect(events.filter((event) => event.kind === 'approval.resolved')).toHaveLength(0)
    expect(events.filter((event) => event.kind === 'tool.failed')).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({
      kind: 'turn.completed',
      payload: {
        turnId: 'kimi:kimi-session-interrupt:turn:1',
        outcome: 'cancelled'
      }
    })
    expect(projection.status).toBe('done')
    expect(projection.activeToolCount).toBe(0)
    expect(projection.pendingAttentionCount).toBe(0)
  })

  test('projects StopFailure as a bounded turn error', () => {
    const prompt = parseKimiHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'kimi-session-error'
    })
    const failure = parseKimiHook({
      hook_event_name: 'StopFailure',
      session_id: 'kimi-session-error',
      error_type: 'provider_error',
      error_message: 'SECRET_PROVIDER_RESPONSE'
    })
    expect(prompt).not.toBeNull()
    expect(failure).not.toBeNull()
    expect(JSON.stringify(failure)).not.toContain('SECRET_PROVIDER_RESPONSE')

    const projector = new KimiHookProjector()
    const events = [prompt!, failure!].flatMap((fact) => projector.project(fact))
    expect(events.map((event) => event.kind)).toEqual([
      'turn.started',
      'thinking.started',
      'turn.failed'
    ])
    expect(events.at(-1)).toMatchObject({
      payload: {
        turnId: 'kimi:kimi-session-error:turn:1',
        message: 'Kimi turn failed: provider_error'
      }
    })
  })

  test('treats SessionEnd as an idle reset and never as PTY exit', () => {
    const facts = [
      parseKimiHook({
        hook_event_name: 'SessionStart',
        session_id: 'kimi-session-boundary',
        source: 'startup'
      }),
      parseKimiHook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'kimi-session-boundary'
      }),
      parseKimiHook({
        hook_event_name: 'SessionEnd',
        session_id: 'kimi-session-boundary',
        reason: 'exit'
      })
    ]
    expect(facts.every(Boolean)).toBe(true)

    const projector = new KimiHookProjector()
    const events = facts.flatMap((fact, index) =>
      projector.project(fact!, 2_000 + index)
    )
    expect(events.map((event) => event.kind)).toEqual([
      'session.idle',
      'turn.started',
      'thinking.started',
      'turn.completed',
      'session.idle'
    ])
    expect(events.some((event) => event.kind === 'session.exited')).toBe(false)
    expect(events.at(-2)).toMatchObject({ payload: { outcome: 'cancelled' } })
    expect(events.at(-1)).toMatchObject({
      payload: {
        since: 2_002,
        reason: 'protocol-idle',
        confidence: 'high'
      }
    })
  })

  test('closes an active public turn before a native SessionStart reset', () => {
    const facts = [
      parseKimiHook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'kimi-session-reset'
      }),
      parseKimiHook({
        hook_event_name: 'SessionStart',
        session_id: 'kimi-session-reset',
        source: 'resume'
      })
    ]
    expect(facts.every(Boolean)).toBe(true)

    const projector = new KimiHookProjector()
    const events = facts.flatMap((fact, index) =>
      projector.project(fact!, 5_000 + index)
    )

    expect(events.map((event) => event.kind)).toEqual([
      'turn.started',
      'thinking.started',
      'turn.completed',
      'session.idle'
    ])
    expect(events.at(-2)).toMatchObject({ payload: { outcome: 'cancelled' } })
  })

  test('prepares a temporary route and delivers Hooks through the adapter seam', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'hrack-kimi-adapter-'))
    const kimiHome = join(runDir, 'kimi-home')
    const adapter = new KimiObserverAdapter({
      pollIntervalMs: 20,
      runCommand: async (_file, args) => {
        if (args[0] === '--version') {
          return { code: 0, stdout: 'kimi-code 0.30.0\n' }
        }
        if (args[0] === 'doctor' && args[1] === 'config') {
          return { code: 0, stdout: 'Configuration is valid.\n' }
        }
        return { code: 1, stdout: '' }
      }
    })
    try {
      const prepared = await adapter.prepare({
        sessionId: 'session-adapter',
        adapterId: 'kimi',
        platform: 'win32',
        workspace: 'C:/workspace',
        args: ['--prompt', 'doctor'],
        runtimeEnvironment: { KIMI_CODE_HOME: kimiHome },
        runDir,
        installation: {
          id: 'kimi:host:test',
          definitionId: 'kimi',
          runtime: { kind: 'host', platform: 'windows' },
          resolvedExecutable: 'kimi.exe',
          detectedVia: 'path',
          verification: 'verified'
        }
      })
      expect(prepared.capabilities).toMatchObject({
        thinking: 'phase',
        tools: 'lifecycle',
        approvals: 'structured'
      })
      const config = await readFile(join(kimiHome, 'config.toml'), 'utf8')
      expect(config).toContain('# >>> hrack:kimi-observer:v1')

      const events: AdapterEvent[] = []
      const handle = await prepared.attach(
        {
          sessionId: 'session-adapter',
          installationId: 'kimi:host:test',
          adapterId: 'kimi',
          ptyId: 'pty-adapter',
          runDir,
          cols: 80,
          rows: 24
        },
        (event) => events.push(event)
      )
      const dropDir = prepared.launch.env?.HRACK_KIMI_HOOK_DROP
      expect(dropDir).toBeTruthy()
      await writeFile(
        join(dropDir!, '0001.json'),
        JSON.stringify({
          hook_event_name: 'SessionStart',
          session_id: 'native-adapter',
          source: 'startup'
        })
      )
      await expect.poll(() => events.map((event) => event.kind)).toContain(
        'session.idle'
      )

      await writeFile(
        join(dropDir!, '0002.json'),
        JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'native-adapter'
        })
      )
      await expect
        .poll(() =>
          events
            .filter((event) => event.kind === 'activity.caption')
            .map((event) => event.payload.text)
        )
        .toContain('@agent:live-thinking:0:')

      await writeFile(
        join(dropDir!, '0003.json'),
        JSON.stringify({
          hook_event_name: 'Stop',
          session_id: 'native-adapter'
        })
      )
      await expect.poll(() => events.map((event) => event.kind)).toContain(
        'turn.completed'
      )
      const captionsAfterStop = events.filter(
        (event) => event.kind === 'activity.caption'
      ).length
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      expect(
        events.filter((event) => event.kind === 'activity.caption')
      ).toHaveLength(captionsAfterStop)

      await handle.dispose()
      await prepared.dispose()
      expect(await readFile(join(kimiHome, 'config.toml'), 'utf8')).toBe(config)
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test('reports a distinct timeout when another WSL process owns the config lock', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'hrack-kimi-wsl-lock-'))
    try {
      const result = await ensureWslKimiManagedHooks(
        {
          sessionId: 'session-wsl-lock',
          adapterId: 'kimi',
          platform: 'win32',
          workspace: '/home/test/workspace',
          args: [],
          runtimeEnvironment: { PATH: '/usr/bin:/bin' },
          runDir,
          installation: {
            id: 'kimi:wsl:lock',
            definitionId: 'kimi',
            runtime: { kind: 'wsl', distro: 'Ubuntu-Test' },
            resolvedExecutable: '/usr/bin/kimi',
            detectedVia: 'path',
            verification: 'verified'
          }
        },
        '/mnt/c/hrack-kimi-wsl-lock',
        async (_file, args) => {
          if (args.includes('hrack-kimi-config-shell')) {
            return { code: 0, stdout: '/bin/bash\n' }
          }
          if (args.includes('hrack-kimi-config-home')) {
            return { code: 0, stdout: 'HOME=/home/test\0' }
          }
          if (args.includes('hrack-kimi-config-lock')) {
            return { code: 73, stdout: '' }
          }
          return { code: 1, stdout: '' }
        }
      )

      expect(result).toEqual({ ok: false, reason: 'kimi-config-lock-timeout' })
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test('retries a WSL install after a concurrent user config edit', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'hrack-kimi-wsl-edit-'))
    let reads = 0
    let installs = 0
    try {
      const result = await ensureWslKimiManagedHooks(
        {
          sessionId: 'session-wsl-edit',
          adapterId: 'kimi',
          platform: 'win32',
          workspace: '/home/test/workspace',
          args: [],
          runtimeEnvironment: { PATH: '/usr/bin:/bin' },
          runDir,
          installation: {
            id: 'kimi:wsl:edit',
            definitionId: 'kimi',
            runtime: { kind: 'wsl', distro: 'Ubuntu-Test' },
            resolvedExecutable: '/usr/bin/kimi',
            detectedVia: 'path',
            verification: 'verified'
          }
        },
        '/mnt/c/hrack-kimi-wsl-edit',
        async (_file, args) => {
          if (args.includes('hrack-kimi-config-shell')) {
            return { code: 0, stdout: '/bin/bash\n' }
          }
          if (args.includes('hrack-kimi-config-home')) {
            return { code: 0, stdout: 'HOME=/home/test\0' }
          }
          if (args.includes('hrack-kimi-config-lock')) {
            return { code: 0, stdout: '' }
          }
          if (args.includes('hrack-kimi-config-read')) {
            reads += 1
            return {
              code: 0,
              stdout:
                reads === 1
                  ? 'default_model = "first"\n'
                  : '# user edit\ndefault_model = "second"\n'
            }
          }
          if (args.includes('doctor') && args.includes('config')) {
            return { code: 0, stdout: '' }
          }
          if (args.includes('hrack-kimi-config-install')) {
            installs += 1
            return { code: installs === 1 ? 42 : 0, stdout: '' }
          }
          if (args.includes('hrack-kimi-config-unlock')) {
            return { code: 0, stdout: '' }
          }
          return { code: 1, stdout: '' }
        }
      )

      expect(result).toEqual({ ok: true, changed: true })
      expect(reads).toBe(2)
      expect(installs).toBe(2)
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test('serializes two WSL ensures before acquiring the distro config lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hrack-kimi-wsl-concurrent-'))
    const firstRunDir = join(root, 'first')
    const secondRunDir = join(root, 'second')
    await mkdir(firstRunDir)
    await mkdir(secondRunDir)
    const installedContent = mergeKimiManagedHooks('', 'posix')
    expect(installedContent.ok).toBe(true)
    if (!installedContent.ok) return
    let installed = false
    let installs = 0
    let activeLocks = 0
    let maximumLocks = 0
    let doctorCalls = 0
    let firstDoctorEntered!: () => void
    const firstDoctorStarted = new Promise<void>(
      (resolve) => (firstDoctorEntered = resolve)
    )
    let allowFirstDoctor!: () => void
    const firstDoctorMayFinish = new Promise<void>(
      (resolve) => (allowFirstDoctor = resolve)
    )
    const runner = async (_file: string, args: readonly string[]) => {
      if (args.includes('hrack-kimi-config-shell')) {
        return { code: 0, stdout: '/bin/bash\n' }
      }
      if (args.includes('hrack-kimi-config-home')) {
        return { code: 0, stdout: 'HOME=/home/test\0' }
      }
      if (args.includes('hrack-kimi-config-lock')) {
        activeLocks += 1
        maximumLocks = Math.max(maximumLocks, activeLocks)
        return { code: 0, stdout: '' }
      }
      if (args.includes('hrack-kimi-config-read')) {
        return installed
          ? { code: 0, stdout: installedContent.content }
          : { code: 3, stdout: '' }
      }
      if (args.includes('doctor') && args.includes('config')) {
        doctorCalls += 1
        if (doctorCalls === 1) {
          firstDoctorEntered()
          await firstDoctorMayFinish
        }
        return { code: 0, stdout: '' }
      }
      if (args.includes('hrack-kimi-config-install')) {
        installs += 1
        installed = true
        return { code: 0, stdout: '' }
      }
      if (args.includes('hrack-kimi-config-unlock')) {
        activeLocks -= 1
        return { code: 0, stdout: '' }
      }
      return { code: 1, stdout: '' }
    }
    const context = (sessionId: string, runDir: string) => ({
      sessionId,
      adapterId: 'kimi',
      platform: 'win32' as const,
      workspace: '/home/test/workspace',
      args: [],
      runtimeEnvironment: { PATH: '/usr/bin:/bin' },
      runDir,
      installation: {
        id: `kimi:wsl:${sessionId}`,
        definitionId: 'kimi',
        runtime: { kind: 'wsl' as const, distro: 'Ubuntu-Test' },
        resolvedExecutable: '/usr/bin/kimi',
        detectedVia: 'path' as const,
        verification: 'verified' as const
      }
    })
    try {
      const first = ensureWslKimiManagedHooks(
        context('first', firstRunDir),
        '/mnt/c/hrack-kimi-wsl-concurrent/first',
        runner
      )
      await firstDoctorStarted
      const second = ensureWslKimiManagedHooks(
        context('second', secondRunDir),
        '/mnt/c/hrack-kimi-wsl-concurrent/second',
        runner
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      allowFirstDoctor()

      expect(await Promise.all([first, second])).toEqual([
        { ok: true, changed: true },
        { ok: true, changed: false }
      ])
      expect(maximumLocks).toBe(1)
      expect(installs).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('installs Hooks and round-trips the drop inside the selected WSL distro', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'hrack-kimi-wsl-'))
    const calls: Array<{ file: string; args: readonly string[] }> = []
    let installed = false
    const adapter = new KimiObserverAdapter({
      runCommand: async (file, args) => {
        calls.push({ file, args })
        if (args.includes('--version')) {
          return { code: 0, stdout: 'kimi-code 0.30.0\n' }
        }
        if (args.includes('hrack-kimi-config-shell')) {
          return { code: 0, stdout: '/bin/bash\n' }
        }
        if (args.includes('hrack-kimi-config-home')) {
          return {
            code: 0,
            stdout: 'HOME=/home/test\0KIMI_CODE_HOME=/srv/custom-kimi\0'
          }
        }
        if (args.includes('hrack-kimi-config-lock')) {
          return { code: 0, stdout: '' }
        }
        if (args.includes('hrack-kimi-config-read')) {
          return { code: 3, stdout: '' }
        }
        if (args.includes('wslpath')) {
          return { code: 0, stdout: '/mnt/c/hrack-kimi-run\n' }
        }
        if (args.includes('doctor') && args.includes('config')) {
          return { code: 0, stdout: 'Configuration is valid.\n' }
        }
        if (args.includes('hrack-kimi-config-install')) {
          installed = true
          return { code: 0, stdout: '' }
        }
        if (args.includes('hrack-kimi-config-unlock')) {
          return { code: 0, stdout: '' }
        }
        const nonce = args.at(-1)
        if (args.includes('hrack-kimi-drop-probe') && nonce) {
          await writeFile(join(runDir, 'kimi-drop', `${nonce}.probe`), nonce)
          return { code: 0, stdout: '' }
        }
        return { code: 1, stdout: '' }
      }
    })
    try {
      const prepared = await adapter.prepare({
        sessionId: 'session-wsl',
        adapterId: 'kimi',
        platform: 'win32',
        workspace: '/home/test/workspace',
        args: [],
        runtimeEnvironment: {
          PATH: '/home/test/.local/bin:/usr/bin:/bin'
        },
        runDir,
        installation: {
          id: 'kimi:wsl:test',
          definitionId: 'kimi',
          runtime: { kind: 'wsl', distro: 'Ubuntu-Test' },
          resolvedExecutable: '/home/test/.kimi-code/bin/kimi',
          detectedVia: 'known-path',
          verification: 'verified'
        }
      })

      expect(prepared.capabilities).toMatchObject({ tools: 'lifecycle' })
      expect(prepared.launch.env?.HRACK_KIMI_HOOK_DROP).toBe(
        '/mnt/c/hrack-kimi-run/kimi-drop'
      )
      expect(prepared.launch.env?.HRACK_KIMI_HOOK_BRIDGE).toBe(
        '/mnt/c/hrack-kimi-run/kimi-hook-bridge.sh'
      )
      expect(installed).toBe(true)
      expect(
        calls.some(({ args }) => args.includes('hrack-kimi-config-shell'))
      ).toBe(true)
      expect(
        calls.some(
          ({ args }) =>
            args.includes('hrack-kimi-config-home') && args.includes('/bin/bash')
        )
      ).toBe(true)
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
})

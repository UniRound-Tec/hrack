import { expect, test } from '@playwright/test'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildGrokManagedHookFile,
  grokWindowsBridgeScript,
  grokWindowsHookCommand,
  isHrackGrokHookFile
} from '../electron/agents/adapters/grok/GrokHookConfig'
import { parseGrokHook } from '../electron/agents/adapters/grok/GrokHookParser'
import { GrokHookProjector } from '../electron/agents/adapters/grok/GrokHookProjector'
import { ensureGrokManagedHooks } from '../electron/agents/adapters/grok/GrokHookStore'
import { GrokObserverAdapter } from '../electron/agents/adapters/grok/GrokObserverAdapter'
import { GROK_HOOK_CAPABILITIES } from '../electron/agents/adapters/grok/types'
import type { AdapterEvent } from '../electron/agents/adapters/types'
import { cliDefinitions } from '../electron/ai-cli-discovery'
import { projectAdapterEvents } from './helpers/agent-projection-contract'

test.describe('Grok observer adapter', () => {
  test('advertises Grok as an implemented observer integration', () => {
    expect(cliDefinitions.find((definition) => definition.id === 'grok')).toMatchObject({
      adapterId: 'grok',
      observerImplemented: true
    })
  })

  test('installs a dedicated hook file without rewriting sibling hooks', async () => {
    const grokHome = await mkdtemp(join(tmpdir(), 'hrack-grok-hooks-'))
    const sibling = join(grokHome, 'hooks', 'user-session-start.json')
    try {
      await mkdir(join(grokHome, 'hooks'), { recursive: true })
      await writeFile(sibling, '{"hooks":{"SessionStart":[]}}\n', 'utf8')
      const first = await ensureGrokManagedHooks({
        grokHome,
        platform: 'windows'
      })
      expect(first.ok).toBe(true)
      if (!first.ok) return
      expect(first.changed).toBe(true)
      const installed = await readFile(first.path, 'utf8')
      expect(isHrackGrokHookFile(JSON.parse(installed))).toBe(true)
      expect(installed).toContain('EncodedCommand')
      expect(installed).toContain('"matcher": "permission_prompt"')
      expect(installed).toContain('"timeout": 3')
      expect(await readFile(sibling, 'utf8')).toBe('{"hooks":{"SessionStart":[]}}\n')

      const again = await ensureGrokManagedHooks({
        grokHome,
        platform: 'windows'
      })
      expect(again).toEqual({ ok: true, changed: false, path: first.path })
    } finally {
      await rm(grokHome, { recursive: true, force: true })
    }
  })

  test('refuses to overwrite a foreign hrack-observer.json', async () => {
    const grokHome = await mkdtemp(join(tmpdir(), 'hrack-grok-conflict-'))
    const hookPath = join(grokHome, 'hooks', 'hrack-observer.json')
    const original = '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo hi"}]}]}}\n'
    try {
      await mkdir(join(grokHome, 'hooks'), { recursive: true })
      await writeFile(hookPath, original, 'utf8')
      const result = await ensureGrokManagedHooks({
        grokHome,
        platform: 'posix'
      })
      expect(result).toEqual({ ok: false, reason: 'grok-hook-file-conflict' })
      expect(await readFile(hookPath, 'utf8')).toBe(original)
    } finally {
      await rm(grokHome, { recursive: true, force: true })
    }
  })

  test('is a silent no-op outside a HRack-launched Windows session', async () => {
    test.skip(process.platform !== 'win32')
    const runDir = await mkdtemp(join(tmpdir(), 'hrack-grok-noop-'))
    const sentinel = join(runDir, 'unexpected.txt')
    const bridge = join(runDir, 'should-not-run.ps1')
    try {
      await writeFile(
        bridge,
        `[IO.File]::WriteAllText(${JSON.stringify(sentinel)}, 'ran')\n`,
        'utf8'
      )
      const env = { ...process.env }
      delete env.HRACK_GROK_HOOK_BRIDGE_WINDOWS
      delete env.HRACK_GROK_HOOK_BRIDGE
      delete env.HRACK_GROK_HOOK_DROP
      const child = spawn(grokWindowsHookCommand(), {
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
    const runDir = await mkdtemp(join(tmpdir(), 'hrack-grok-bytes-'))
    const dropDir = join(runDir, 'drop')
    const bridge = join(runDir, 'bridge.ps1')
    const payload = JSON.stringify({
      hookEventName: 'session_start',
      sessionId: '原生会话',
      cwd: 'C:/工作区/中文'
    })
    try {
      await mkdir(dropDir)
      await writeFile(bridge, grokWindowsBridgeScript(), 'utf8')
      const child = spawn(grokWindowsHookCommand(), {
        shell: true,
        env: {
          ...process.env,
          HRACK_GROK_HOOK_DROP: dropDir,
          HRACK_GROK_HOOK_BRIDGE_WINDOWS: bridge
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

  test('projects one prompt and Stop without retaining conversation content', () => {
    const canary = 'SECRET_GROK_CONVERSATION_CANARY'
    const prompt = parseGrokHook({
      hookEventName: 'user_prompt_submit',
      sessionId: 'grok-session-1',
      cwd: 'C:/workspace',
      prompt: canary
    })
    const stop = parseGrokHook({
      hookEventName: 'stop',
      sessionId: 'grok-session-1',
      reason: 'end_turn',
      lastAssistantMessage: canary
    })
    expect(prompt).not.toBeNull()
    expect(stop).not.toBeNull()
    expect(JSON.stringify([prompt, stop])).not.toContain(canary)

    const projector = new GrokHookProjector()
    const events = [prompt!, stop!].flatMap((fact, index) =>
      projector.project(fact, 1_000 + index)
    )
    expect(events.map((event) => event.kind)).toEqual([
      'turn.started',
      'thinking.started',
      'turn.completed'
    ])
    const projection = projectAdapterEvents(events, {
      adapterId: 'grok',
      source: 'hook',
      capabilities: GROK_HOOK_CAPABILITIES
    })
    expect(projection.status).toBe('done')
  })

  test('maps permission_prompt and PermissionDenied onto structured approvals', () => {
    const facts = [
      parseGrokHook({
        hookEventName: 'UserPromptSubmit',
        sessionId: 'grok-session-perm'
      }),
      parseGrokHook({
        hookEventName: 'PreToolUse',
        sessionId: 'grok-session-perm',
        toolUseId: 'call-1',
        toolName: 'run_terminal_command',
        toolInput: { command: 'SECRET_GROK_TOOL_INPUT' }
      }),
      parseGrokHook({
        hookEventName: 'notification',
        sessionId: 'grok-session-perm',
        notificationType: 'permission_prompt',
        toolUseId: 'call-1',
        toolName: 'run_terminal_command'
      }),
      parseGrokHook({
        hookEventName: 'PermissionDenied',
        sessionId: 'grok-session-perm',
        toolUseId: 'call-1',
        toolName: 'run_terminal_command'
      }),
      parseGrokHook({
        hookEventName: 'StopCancelled',
        sessionId: 'grok-session-perm',
        reason: 'permission_rejected'
      })
    ]
    expect(facts.every(Boolean)).toBe(true)
    expect(JSON.stringify(facts)).not.toContain('SECRET_GROK_TOOL_INPUT')

    const projector = new GrokHookProjector()
    const events = facts.flatMap((fact, index) =>
      projector.project(fact!, 2_000 + index)
    )
    const projection = projectAdapterEvents(events, {
      adapterId: 'grok',
      source: 'hook',
      capabilities: GROK_HOOK_CAPABILITIES
    })
    expect(events.filter((event) => event.kind === 'approval.requested')).toHaveLength(1)
    expect(events.filter((event) => event.kind === 'approval.resolved')).toHaveLength(1)
    expect(
      events.find((event) => event.kind === 'approval.resolved')
    ).toMatchObject({ payload: { decision: 'denied' } })
    expect(projection.status).toBe('done')
    expect(projection.pendingAttentionCount).toBe(0)
  })

  test('does not settle a Stop continuation while stopHookActive is true', () => {
    const projector = new GrokHookProjector()
    const started = parseGrokHook({
      hookEventName: 'UserPromptSubmit',
      sessionId: 'grok-session-gate'
    })
    const gated = parseGrokHook({
      hookEventName: 'Stop',
      sessionId: 'grok-session-gate',
      reason: 'end_turn',
      stopHookActive: true
    })
    const finished = parseGrokHook({
      hookEventName: 'Stop',
      sessionId: 'grok-session-gate',
      reason: 'end_turn',
      stopHookActive: false
    })
    expect(started && gated && finished).toBeTruthy()
    const mid = [started!, gated!].flatMap((fact, index) =>
      projector.project(fact, 3_000 + index)
    )
    expect(mid.map((event) => event.kind)).toEqual([
      'turn.started',
      'thinking.started'
    ])
    const end = projector.project(finished!, 3_002)
    expect(end.map((event) => event.kind)).toEqual(['turn.completed'])
  })

  test('opens a new public turn when activity continues after Stop', () => {
    const facts = [
      parseGrokHook({
        hookEventName: 'UserPromptSubmit',
        sessionId: 'grok-session-cont'
      }),
      parseGrokHook({
        hookEventName: 'Stop',
        sessionId: 'grok-session-cont',
        reason: 'end_turn'
      }),
      parseGrokHook({
        hookEventName: 'PreToolUse',
        sessionId: 'grok-session-cont',
        toolUseId: 'continued-call',
        toolName: 'read_file'
      }),
      parseGrokHook({
        hookEventName: 'PostToolUse',
        sessionId: 'grok-session-cont',
        toolUseId: 'continued-call',
        toolName: 'read_file'
      }),
      parseGrokHook({
        hookEventName: 'Stop',
        sessionId: 'grok-session-cont',
        reason: 'end_turn'
      })
    ]
    expect(facts.every(Boolean)).toBe(true)
    const projector = new GrokHookProjector()
    const events = facts.flatMap((fact, index) =>
      projector.project(fact!, 4_000 + index)
    )
    const starts = events.filter((event) => event.kind === 'turn.started')
    expect(starts).toHaveLength(2)
    expect(starts[1].payload.turnId).not.toBe(starts[0].payload.turnId)
  })

  test('prepares a temporary route and delivers Hooks through the adapter seam', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'hrack-grok-adapter-'))
    const grokHome = join(runDir, 'grok-home')
    const adapter = new GrokObserverAdapter({
      pollIntervalMs: 20,
      runCommand: async (_file, args) => {
        if (args.includes('--version') || args[0] === '--version') {
          return { code: 0, stdout: 'grok 1.0.5 (deadbeef) [stable]\n' }
        }
        return { code: 1, stdout: '' }
      }
    })
    try {
      const prepared = await adapter.prepare({
        sessionId: 'session-adapter',
        adapterId: 'grok',
        platform: 'win32',
        workspace: 'C:/workspace',
        args: [],
        runtimeEnvironment: { GROK_HOME: grokHome },
        runDir,
        installation: {
          id: 'grok:host:test',
          definitionId: 'grok',
          runtime: { kind: 'host', platform: 'windows' },
          resolvedExecutable: 'grok.exe',
          detectedVia: 'path',
          verification: 'verified'
        }
      })
      expect(prepared.capabilities).toMatchObject({
        thinking: 'phase',
        tools: 'lifecycle',
        approvals: 'structured'
      })
      const hookFile = await readFile(
        join(grokHome, 'hooks', 'hrack-observer.json'),
        'utf8'
      )
      expect(isHrackGrokHookFile(JSON.parse(hookFile))).toBe(true)

      const events: AdapterEvent[] = []
      const handle = await prepared.attach(
        {
          sessionId: 'session-adapter',
          installationId: 'grok:host:test',
          adapterId: 'grok',
          ptyId: 'pty-adapter',
          runDir,
          cols: 80,
          rows: 24
        },
        (event) => events.push(event)
      )
      const dropDir = prepared.launch.env?.HRACK_GROK_HOOK_DROP
      expect(dropDir).toBeTruthy()
      await writeFile(
        join(dropDir!, '0001.json'),
        JSON.stringify({
          hookEventName: 'session_start',
          sessionId: 'native-adapter'
        })
      )
      await expect.poll(() => events.map((event) => event.kind)).toContain(
        'session.idle'
      )
      await writeFile(
        join(dropDir!, '0002.json'),
        JSON.stringify({
          hookEventName: 'user_prompt_submit',
          sessionId: 'native-adapter'
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
          hookEventName: 'stop',
          sessionId: 'native-adapter',
          reason: 'end_turn'
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
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test('degrades headless and management commands to lifecycle-only', async () => {
    const adapter = new GrokObserverAdapter({
      runCommand: async () => ({ code: 0, stdout: 'grok 1.0.5\n' })
    })
    const prepared = await adapter.prepare({
      sessionId: 'session-headless',
      adapterId: 'grok',
      platform: 'win32',
      workspace: 'C:/workspace',
      args: ['-p', 'do not observe this'],
      runDir: join(tmpdir(), 'hrack-grok-unused'),
      installation: {
        id: 'grok:host:test',
        definitionId: 'grok',
        runtime: { kind: 'host', platform: 'windows' },
        resolvedExecutable: 'grok.exe',
        detectedVia: 'path',
        verification: 'verified'
      }
    })
    expect(prepared.capabilities).toMatchObject({
      thinking: 'none',
      tools: 'none'
    })
    const events: AdapterEvent[] = []
    const handle = await prepared.attach(
      {
        sessionId: 'session-headless',
        installationId: 'grok:host:test',
        adapterId: 'grok',
        ptyId: 'pty',
        runDir: join(tmpdir(), 'hrack-grok-unused'),
        cols: 80,
        rows: 24
      },
      (event) => events.push(event)
    )
    expect(events[0]).toMatchObject({
      kind: 'observer.degraded',
      payload: { reason: 'grok-command-unsupported' }
    })
    await handle.dispose()
    await prepared.dispose()
  })

  test('managed hook file is valid JSON and byte-stable', () => {
    const windows = buildGrokManagedHookFile('windows')
    const posix = buildGrokManagedHookFile('posix')
    expect(() => JSON.parse(windows)).not.toThrow()
    expect(() => JSON.parse(posix)).not.toThrow()
    expect(buildGrokManagedHookFile('windows')).toBe(windows)
    expect(posix).toContain('HRACK_GROK_HOOK_BRIDGE')
    expect(posix).not.toContain('powershell.exe')
  })

  test('installs the WSL hook file and proves drop interop on a real distro', async () => {
    test.skip(process.platform !== 'win32', 'WSL launch is a Windows host concern')
    let distro = ''
    try {
      const listed = await promisify(execFile)(
        'wsl.exe',
        ['--list', '--quiet'],
        { encoding: 'utf16le', timeout: 8_000, windowsHide: true }
      )
      distro =
        listed.stdout
          .split(/\r?\n/)
          .map((value) => value.replaceAll('\0', '').trim())
          .find((value) => value && value !== 'docker-desktop' && value !== 'docker-desktop-data') ??
        ''
    } catch {
      test.skip(true, 'No WSL distro is available')
    }
    test.skip(!distro, 'No WSL distro is available')

    const runDir = await mkdtemp(join(tmpdir(), 'hrack-grok-wsl-'))
    const exec = promisify(execFile)
    const runCommand = async (
      file: string,
      args: readonly string[]
    ): Promise<{ code: number | null; stdout: string }> => {
      if (args.includes('--version') || args[0] === '--version') {
        return { code: 0, stdout: 'grok 1.0.5 (deadbeef) [stable]\n' }
      }
      try {
        const result = await exec(file, [...args], {
          encoding: 'utf8',
          timeout: 20_000,
          windowsHide: true,
          maxBuffer: 256 * 1024
        })
        return { code: 0, stdout: String(result.stdout ?? '') }
      } catch (error) {
        const failure = error as {
          code?: string | number
          stdout?: string
        }
        return {
          code: typeof failure.code === 'number' ? failure.code : 1,
          stdout: String(failure.stdout ?? '')
        }
      }
    }
    const adapter = new GrokObserverAdapter({ pollIntervalMs: 20, runCommand })
    try {
      const prepared = await adapter.prepare({
        sessionId: 'session-wsl',
        adapterId: 'grok',
        platform: 'win32',
        workspace: '/tmp',
        args: [],
        runtimeEnvironment: { PATH: '/usr/bin:/bin' },
        runDir,
        installation: {
          id: `grok:wsl:${distro}`,
          definitionId: 'grok',
          runtime: { kind: 'wsl', distro },
          resolvedExecutable: '/bin/true',
          detectedVia: 'path',
          verification: 'verified'
        }
      })
      expect(prepared.launch.env?.HRACK_GROK_HOOK_DROP?.startsWith('/')).toBe(true)
      expect(prepared.capabilities?.tools).toBe('lifecycle')
      const hostDrops = await readdir(join(runDir, 'grok-drop'))
      expect(hostDrops.some((name) => name.endsWith('.probe'))).toBe(false)
      await prepared.dispose()
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })
})

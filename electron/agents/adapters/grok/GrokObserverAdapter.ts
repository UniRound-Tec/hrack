import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, posix } from 'node:path'
import type { ObserverCapabilities } from '../../../../shared/agent-events'
import { HookDropPoller } from '../../../hooks/HookDropPoller'
import type {
  AgentObserverAdapter,
  ObserverHandle,
  ObserverPreparationContext,
  PreparedObserver
} from '../types'
import { ADAPTER_COMMAND_TIMEOUT_MS } from '../adapterTimeouts'
import { ThinkingCaptionClock } from '../ThinkingCaptionClock'
import { wslRuntimeCommand } from '../wslRuntimeCommand'
import {
  grokPosixBridgeScript,
  grokWindowsBridgeScript
} from './GrokHookConfig'
import { parseGrokHook } from './GrokHookParser'
import { GrokHookProjector } from './GrokHookProjector'
import { ensureGrokManagedHooks } from './GrokHookStore'
import { ensureWslGrokManagedHooks } from './GrokWslHookStore'
import { GROK_HOOK_CAPABILITIES, GROK_HOOK_SCHEMA } from './types'

const NO_CAPABILITIES: ObserverCapabilities = {
  thinking: 'none',
  tools: 'none',
  approvals: 'none',
  inputRequests: 'none',
  usage: 'none',
  messages: 'none'
}

export interface GrokCommandResult {
  code: number | null
  stdout: string
  stderr?: string
  timedOut?: boolean
}

export type GrokCommandRunner = (
  file: string,
  args: readonly string[]
) => Promise<GrokCommandResult>

export interface GrokObserverAdapterOptions {
  runCommand?: GrokCommandRunner
  pollIntervalMs?: number
}

function defaultRunCommand(
  file: string,
  args: readonly string[]
): Promise<GrokCommandResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        encoding: 'utf8',
        timeout: ADAPTER_COMMAND_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const failure = error as
          | (NodeJS.ErrnoException & {
              code?: string | number
              killed?: boolean
            })
          | null
        resolve({
          code: typeof failure?.code === 'number' ? failure.code : error ? null : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: Boolean(failure?.killed)
        })
      }
    )
  })
}

function degradedPrepared(reason: string): PreparedObserver {
  return {
    launch: {},
    capabilities: NO_CAPABILITIES,
    attach: async (_context, emit): Promise<ObserverHandle> => {
      emit({
        kind: 'observer.degraded',
        payload: { reason, remaining: NO_CAPABILITIES },
        nativeId: `grok:degraded:${reason}`,
        nativeType: 'GrokAdapterPrepare'
      })
      return { capabilities: NO_CAPABILITIES, dispose: async () => {} }
    },
    dispose: async () => {}
  }
}

const UNSUPPORTED_COMMANDS = new Set([
  'agent',
  'completions',
  'dashboard',
  'doctor',
  'du',
  'disk-usage',
  'export',
  'help',
  'inspect',
  'leader',
  'login',
  'logout',
  'mcp',
  'memory',
  'models',
  'plugin',
  'sessions',
  'setup',
  'trace',
  'update',
  'version',
  'v',
  'worktree',
  'wrap'
])

const VALUE_OPTIONS = new Set([
  '--agent',
  '--agents',
  '--allow',
  '--cwd',
  '--debug-file',
  '--deny',
  '--disallowed-tools',
  '--leader-socket',
  '-m',
  '--model',
  '--max-turns',
  '--output-format',
  '--permission-mode',
  '--prompt-file',
  '--prompt-json',
  '-r',
  '--resume',
  '--reasoning-effort',
  '--effort',
  '--rules',
  '-s',
  '--session-id',
  '--sandbox',
  '--system-prompt-override',
  '--tools',
  '-w',
  '--worktree',
  '--worktree-ref',
  '--ref'
])

function unsupportedCommand(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const lower = arg.toLowerCase()
    if (lower === '--') return false
    if (lower === '-h' || lower === '--help' || lower === '-v' || lower === '--version') {
      return true
    }
    if (lower === '-p' || lower === '--single') return true
    if (VALUE_OPTIONS.has(lower)) {
      if (args[index + 1] && !args[index + 1].startsWith('-')) index += 1
      continue
    }
    if (lower.startsWith('-')) continue
    return UNSUPPORTED_COMMANDS.has(lower)
  }
  return false
}

function supportedVersion(stdout: string): boolean {
  const match = stdout.match(/\b(\d+)\.(\d+)(?:\.\d+)?\b/)
  if (!match) return false
  return Number(match[1]) >= 1
}

function hostGrokHome(context: ObserverPreparationContext): string | null {
  const configured =
    context.runtimeEnvironment?.GROK_HOME ?? process.env.GROK_HOME
  if (configured && configured.length > 0) {
    return isAbsolute(configured) ? configured : null
  }
  return join(homedir(), '.grok')
}

export class GrokObserverAdapter implements AgentObserverAdapter {
  readonly id = 'grok'
  readonly source = 'hook' as const
  readonly capabilities = GROK_HOOK_CAPABILITIES
  private readonly runCommand: GrokCommandRunner
  private readonly pollIntervalMs: number

  constructor(options: GrokObserverAdapterOptions = {}) {
    this.runCommand = options.runCommand ?? defaultRunCommand
    this.pollIntervalMs = options.pollIntervalMs ?? 300
  }

  supports(context: ObserverPreparationContext): boolean {
    return context.adapterId === this.id
  }

  async prepare(context: ObserverPreparationContext): Promise<PreparedObserver> {
    if (unsupportedCommand(context.args)) {
      return degradedPrepared('grok-command-unsupported')
    }
    const version = await this.probeVersion(context)
    if (version.code !== 0 || !supportedVersion(version.stdout)) {
      return degradedPrepared('grok-version-unsupported')
    }

    if (context.installation.runtime.kind !== 'wsl') {
      const grokHome = hostGrokHome(context)
      if (!grokHome) return degradedPrepared('grok-hook-path-unavailable')
      const configured = await ensureGrokManagedHooks({
        grokHome,
        platform: context.platform === 'win32' ? 'windows' : 'posix'
      })
      if (!configured.ok) return degradedPrepared(configured.reason)
    }

    const dropDir = join(context.runDir, 'grok-drop')
    const posixBridge = join(context.runDir, 'grok-hook-bridge.sh')
    const windowsBridge = join(context.runDir, 'grok-hook-bridge.ps1')
    try {
      await mkdir(dropDir, { recursive: false, mode: 0o700 })
      await writeFile(posixBridge, grokPosixBridgeScript(), {
        encoding: 'utf8',
        mode: 0o700,
        flag: 'wx'
      })
      await writeFile(windowsBridge, grokWindowsBridgeScript(), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      if (context.platform !== 'win32') {
        await chmod(dropDir, 0o700)
        await chmod(posixBridge, 0o700)
        await chmod(windowsBridge, 0o600)
      }
    } catch {
      await Promise.allSettled([
        rm(dropDir, { recursive: true, force: true }),
        rm(posixBridge, { force: true }),
        rm(windowsBridge, { force: true })
      ])
      return degradedPrepared('grok-hook-drop-unavailable')
    }

    const runtimePaths = await this.runtimePaths(
      context,
      dropDir,
      posixBridge,
      windowsBridge
    )
    if (!runtimePaths) {
      await Promise.allSettled([
        rm(dropDir, { recursive: true, force: true }),
        rm(posixBridge, { force: true }),
        rm(windowsBridge, { force: true })
      ])
      return degradedPrepared('grok-wsl-drop-unavailable')
    }
    if (context.installation.runtime.kind === 'wsl') {
      const configured = await ensureWslGrokManagedHooks(
        context,
        runtimePaths.runDir,
        this.runCommand
      )
      if (!configured.ok) {
        await Promise.allSettled([
          rm(dropDir, { recursive: true, force: true }),
          rm(posixBridge, { force: true }),
          rm(windowsBridge, { force: true })
        ])
        return degradedPrepared(configured.reason)
      }
    }

    let attachedHandle: ObserverHandle | null = null
    let disposed = false
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      await attachedHandle?.dispose().catch(() => {})
      attachedHandle = null
      await Promise.allSettled([
        rm(dropDir, { recursive: true, force: true }),
        rm(posixBridge, { force: true }),
        rm(windowsBridge, { force: true })
      ])
    }

    return {
      launch: {
        env: {
          HRACK_GROK_HOOK_DROP: runtimePaths.dropDir,
          HRACK_GROK_HOOK_BRIDGE: runtimePaths.posixBridge,
          HRACK_GROK_HOOK_BRIDGE_WINDOWS: runtimePaths.windowsBridge,
          HRACK_GROK_HOOK_SCHEMA: GROK_HOOK_SCHEMA
        }
      },
      capabilities: GROK_HOOK_CAPABILITIES,
      attach: async (_running, emit): Promise<ObserverHandle> => {
        const projector = new GrokHookProjector()
        const thinkingClock = new ThinkingCaptionClock(
          `grok:${context.sessionId}:thinking`,
          'GrokThinkingTimer',
          emit
        )
        const emitProjected = (event: Parameters<typeof emit>[0]): void => {
          if (event.kind === 'thinking.started') {
            emit(event)
            thinkingClock.start()
            return
          }
          if (
            event.kind === 'thinking.completed' ||
            event.kind === 'tool.started' ||
            event.kind === 'turn.completed' ||
            event.kind === 'turn.failed' ||
            event.kind === 'session.idle' ||
            event.kind === 'session.exited'
          ) {
            thinkingClock.stop()
          }
          emit(event)
        }
        const poller = new HookDropPoller(
          dropDir,
          (payload) => {
            const fact = parseGrokHook(payload)
            if (!fact) return
            for (const event of projector.project(fact)) emitProjected(event)
          },
          this.pollIntervalMs
        )
        poller.start()
        let handleDisposed = false
        const handle: ObserverHandle = {
          capabilities: GROK_HOOK_CAPABILITIES,
          dispose: async () => {
            if (handleDisposed) return
            handleDisposed = true
            thinkingClock.stop()
            await poller.dispose()
          }
        }
        attachedHandle = handle
        return handle
      },
      dispose
    }
  }

  private probeVersion(
    context: ObserverPreparationContext
  ): Promise<GrokCommandResult> {
    if (context.installation.runtime.kind === 'wsl') {
      const command = wslRuntimeCommand(
        context,
        ['--version'],
        'hrack-grok-version'
      )
      return this.runCommand(command.file, command.args)
    }
    return this.runCommand(context.installation.resolvedExecutable, ['--version'])
  }

  private async runtimePaths(
    context: ObserverPreparationContext,
    hostDropDir: string,
    hostPosixBridge: string,
    hostWindowsBridge: string
  ): Promise<
    | {
        runDir: string
        dropDir: string
        posixBridge: string
        windowsBridge: string
      }
    | null
  > {
    if (context.installation.runtime.kind !== 'wsl') {
      return {
        runDir: context.runDir,
        dropDir: hostDropDir,
        posixBridge: hostPosixBridge,
        windowsBridge: hostWindowsBridge
      }
    }
    const distro = context.installation.runtime.distro
    const translated = await this.runCommand('wsl.exe', [
      '--distribution',
      distro,
      '--exec',
      'wslpath',
      '-a',
      '-u',
      context.runDir
    ])
    const runtimeRunDir = translated.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith('/'))
    if (translated.code !== 0 || !runtimeRunDir) return null

    const runtimeDropDir = posix.join(runtimeRunDir, 'grok-drop')
    const nonce = randomBytes(12).toString('hex')
    const probe = await this.runCommand('wsl.exe', [
      '--distribution',
      distro,
      '--exec',
      '/bin/sh',
      '-c',
      'set -eu; d="$1"; n="$2"; p="$d/.$n.partial"; printf "%s" "$n" > "$p"; mv "$p" "$d/$n.probe"',
      'hrack-grok-drop-probe',
      runtimeDropDir,
      nonce
    ])
    if (probe.code !== 0) return null
    const hostProbe = join(hostDropDir, `${nonce}.probe`)
    try {
      if ((await readFile(hostProbe, 'utf8')) !== nonce) return null
    } catch {
      return null
    } finally {
      await rm(hostProbe, { force: true }).catch(() => {})
    }
    return {
      runDir: runtimeRunDir,
      dropDir: runtimeDropDir,
      posixBridge: posix.join(runtimeRunDir, 'grok-hook-bridge.sh'),
      windowsBridge: hostWindowsBridge
    }
  }
}

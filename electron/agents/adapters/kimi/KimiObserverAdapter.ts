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
import { ThinkingCaptionClock } from '../ThinkingCaptionClock'
import { wslRuntimeCommand } from '../wslRuntimeCommand'
import { ensureKimiManagedHooks } from './KimiConfigStore'
import {
  kimiPosixBridgeScript,
  kimiWindowsBridgeScript
} from './KimiHookConfig'
import { parseKimiHook } from './KimiHookParser'
import { KimiHookProjector } from './KimiHookProjector'
import { ensureWslKimiManagedHooks } from './KimiWslConfigStore'
import { KIMI_HOOK_CAPABILITIES } from './types'

const NO_CAPABILITIES: ObserverCapabilities = {
  thinking: 'none',
  tools: 'none',
  approvals: 'none',
  inputRequests: 'none',
  usage: 'none',
  messages: 'none'
}
const PROBE_TIMEOUT_MS = 3_000

export interface KimiCommandResult {
  code: number | null
  stdout: string
}

export type KimiCommandRunner = (
  file: string,
  args: readonly string[]
) => Promise<KimiCommandResult>

export interface KimiObserverAdapterOptions {
  runCommand?: KimiCommandRunner
  pollIntervalMs?: number
}

function defaultRunCommand(
  file: string,
  args: readonly string[]
): Promise<KimiCommandResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        windowsHide: true
      },
      (error, stdout) => {
        const failure = error as
          | (NodeJS.ErrnoException & { code?: string | number })
          | null
        resolve({
          code: typeof failure?.code === 'number' ? failure.code : error ? null : 0,
          stdout: String(stdout ?? '')
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
        nativeId: `kimi:degraded:${reason}`,
        nativeType: 'KimiAdapterPrepare'
      })
      return { capabilities: NO_CAPABILITIES, dispose: async () => {} }
    },
    dispose: async () => {}
  }
}

function unsupportedCommand(args: readonly string[]): boolean {
  const unsupported = new Set([
    'export',
    'acp',
    'web',
    'server',
    'doctor',
    'login',
    'logout',
    'vis',
    'migrate',
    'upgrade',
    'update',
    'provider',
    'plugin'
  ])
  const valueOptions = new Set([
    '-m',
    '--model',
    '-p',
    '--prompt',
    '--output-format',
    '--skills-dir',
    '--agent',
    '--agent-file',
    '--add-dir'
  ])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const lower = arg.toLowerCase()
    if (lower === '--') return false
    if (lower === '-h' || lower === '--help' || lower === '-v' || lower === '--version') {
      return true
    }
    if (valueOptions.has(lower)) {
      index += 1
      continue
    }
    if (lower === '-s' || lower === '--session') {
      if (args[index + 1] && !args[index + 1].startsWith('-')) index += 1
      continue
    }
    if (lower.startsWith('-')) continue
    return unsupported.has(lower)
  }
  return false
}

function supportedVersion(stdout: string): boolean {
  const match = stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 0 || minor >= 30
}

function hostConfigPath(context: ObserverPreparationContext): string | null {
  const configured =
    context.runtimeEnvironment?.KIMI_CODE_HOME ?? process.env.KIMI_CODE_HOME
  if (configured === undefined || configured.length === 0) {
    return join(homedir(), '.kimi-code', 'config.toml')
  }
  return isAbsolute(configured) ? join(configured, 'config.toml') : null
}

export class KimiObserverAdapter implements AgentObserverAdapter {
  readonly id = 'kimi'
  readonly source = 'hook' as const
  readonly capabilities = KIMI_HOOK_CAPABILITIES
  private readonly runCommand: KimiCommandRunner
  private readonly pollIntervalMs: number

  constructor(options: KimiObserverAdapterOptions = {}) {
    this.runCommand = options.runCommand ?? defaultRunCommand
    this.pollIntervalMs = options.pollIntervalMs ?? 300
  }

  supports(context: ObserverPreparationContext): boolean {
    return context.adapterId === this.id
  }

  async prepare(context: ObserverPreparationContext): Promise<PreparedObserver> {
    if (unsupportedCommand(context.args)) {
      return degradedPrepared('kimi-command-unsupported')
    }
    const version = await this.probeVersion(context)
    if (version.code !== 0 || !supportedVersion(version.stdout)) {
      return degradedPrepared('kimi-version-unsupported')
    }

    if (context.installation.runtime.kind !== 'wsl') {
      const configPath = hostConfigPath(context)
      if (!configPath) return degradedPrepared('kimi-config-path-unavailable')
      const platform = context.platform === 'win32' ? 'windows' : 'posix'
      const configured = await ensureKimiManagedHooks({
        configPath,
        platform,
        validate: async (candidatePath) => {
          const result = await this.runCommand(
            context.installation.resolvedExecutable,
            ['doctor', 'config', candidatePath]
          )
          return result.code === 0
        }
      })
      if (!configured.ok) return degradedPrepared(configured.reason)
    }

    const dropDir = join(context.runDir, 'kimi-drop')
    const posixBridge = join(context.runDir, 'kimi-hook-bridge.sh')
    const windowsBridge = join(context.runDir, 'kimi-hook-bridge.ps1')
    try {
      await mkdir(dropDir, { recursive: false, mode: 0o700 })
      await writeFile(posixBridge, kimiPosixBridgeScript(), {
        encoding: 'utf8',
        mode: 0o700,
        flag: 'wx'
      })
      await writeFile(windowsBridge, kimiWindowsBridgeScript(), {
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
      return degradedPrepared('kimi-hook-drop-unavailable')
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
      return degradedPrepared('kimi-wsl-drop-unavailable')
    }
    if (context.installation.runtime.kind === 'wsl') {
      const configured = await ensureWslKimiManagedHooks(
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
          VIBING_KIMI_HOOK_DROP: runtimePaths.dropDir,
          VIBING_KIMI_HOOK_BRIDGE: runtimePaths.posixBridge,
          VIBING_KIMI_HOOK_BRIDGE_WINDOWS: runtimePaths.windowsBridge,
          VIBING_KIMI_HOOK_SCHEMA: '1'
        }
      },
      capabilities: KIMI_HOOK_CAPABILITIES,
      attach: async (_running, emit): Promise<ObserverHandle> => {
        const projector = new KimiHookProjector()
        const thinkingClock = new ThinkingCaptionClock(
          `kimi:${context.sessionId}:thinking`,
          'KimiThinkingTimer',
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
            const fact = parseKimiHook(payload)
            if (!fact) return
            for (const event of projector.project(fact)) emitProjected(event)
          },
          this.pollIntervalMs
        )
        poller.start()
        let handleDisposed = false
        const handle: ObserverHandle = {
          capabilities: KIMI_HOOK_CAPABILITIES,
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
  ): Promise<KimiCommandResult> {
    if (context.installation.runtime.kind === 'wsl') {
      const command = wslRuntimeCommand(
        context,
        ['--version'],
        'vibing-kimi-version'
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

    const runtimeDropDir = posix.join(runtimeRunDir, 'kimi-drop')
    const nonce = randomBytes(12).toString('hex')
    const probe = await this.runCommand('wsl.exe', [
      '--distribution',
      distro,
      '--exec',
      '/bin/sh',
      '-c',
      'set -eu; d="$1"; n="$2"; p="$d/.$n.partial"; printf "%s" "$n" > "$p"; mv "$p" "$d/$n.probe"',
      'vibing-kimi-drop-probe',
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
      posixBridge: posix.join(runtimeRunDir, 'kimi-hook-bridge.sh'),
      windowsBridge: hostWindowsBridge
    }
  }
}

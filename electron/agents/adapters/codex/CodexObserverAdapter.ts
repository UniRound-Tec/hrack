import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { ObserverCapabilities } from '../../../../shared/agent-events'
import { HookDropPoller } from '../../../hooks/HookDropPoller'
import type {
  AdapterEvent,
  AgentObserverAdapter,
  ObserverHandle,
  ObserverPreparationContext,
  PreparedObserver
} from '../types'
import { ADAPTER_COMMAND_TIMEOUT_MS } from '../adapterTimeouts'
import { wslRuntimeCommand } from '../wslRuntimeCommand'
import {
  buildCodexInlineHookConfig,
  codexPosixBridgeScript,
  codexWindowsBridgeScript
} from './CodexHookConfig'
import { parseCodexHook } from './CodexHookParser'
import { CodexHookProjector } from './CodexHookProjector'
import { CODEX_HOOK_CAPABILITIES } from './types'

const NO_CAPABILITIES: ObserverCapabilities = {
  thinking: 'none',
  tools: 'none',
  approvals: 'none',
  inputRequests: 'none',
  usage: 'none',
  messages: 'none'
}

export interface CodexCommandResult {
  code: number | null
  stdout: string
}

export type CodexCommandRunner = (
  file: string,
  args: readonly string[]
) => Promise<CodexCommandResult>

export interface CodexObserverAdapterOptions {
  runCommand?: CodexCommandRunner
  pollIntervalMs?: number
}

function defaultRunCommand(
  file: string,
  args: readonly string[]
): Promise<CodexCommandResult> {
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
        nativeId: `codex:degraded:${reason}`,
        nativeType: 'CodexAdapterPrepare'
      })
      return { capabilities: NO_CAPABILITIES, dispose: async () => {} }
    },
    dispose: async () => {}
  }
}

function hasUnsupportedArgs(args: readonly string[]): boolean {
  const unsupported = new Set([
    'exec',
    'review',
    'app-server',
    'mcp-server',
    'exec-server',
    'remote-control',
    'cloud',
    'app',
    'update',
    'login',
    'logout',
    'features',
    'doctor'
  ])
  return args.some(
    (arg) =>
      arg === '--remote' ||
      arg.startsWith('--remote=') ||
      unsupported.has(arg.toLowerCase())
  )
}

function hasHookConflict(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const next = args[index + 1]
    const inlineConfig =
      arg.startsWith('--config=') || arg.startsWith('-c=')
        ? arg.slice(arg.indexOf('=') + 1)
        : undefined
    const configValue =
      arg === '-c' || arg === '--config' ? next : inlineConfig
    if (
      (arg === '--disable' && next === 'hooks') ||
      arg === '--disable=hooks' ||
      configValue === 'features.hooks=false' ||
      configValue?.startsWith('hooks=') ||
      configValue?.startsWith('hooks.')
    ) {
      return true
    }
  }
  return false
}

export class CodexObserverAdapter implements AgentObserverAdapter {
  readonly id = 'codex'
  readonly source = 'hook' as const
  readonly capabilities = CODEX_HOOK_CAPABILITIES
  private readonly runCommand: CodexCommandRunner
  private readonly pollIntervalMs: number

  constructor(options: CodexObserverAdapterOptions = {}) {
    this.runCommand = options.runCommand ?? defaultRunCommand
    this.pollIntervalMs = options.pollIntervalMs ?? 300
  }

  supports(context: ObserverPreparationContext): boolean {
    return context.adapterId === this.id
  }

  async prepare(context: ObserverPreparationContext): Promise<PreparedObserver> {
    if (hasUnsupportedArgs(context.args)) {
      return degradedPrepared('codex-unsupported-command')
    }
    if (hasHookConflict(context.args)) {
      return degradedPrepared('codex-hook-config-conflict')
    }

    const probe = await this.probeHooks(context)
    if (probe.code !== 0 || !/^\s*hooks\s+stable\s+true\s*$/im.test(probe.stdout)) {
      return degradedPrepared('codex-hooks-unavailable')
    }

    const dropDir = join(context.runDir, 'codex-drop')
    const posixBridge = join(context.runDir, 'codex-hook-bridge.sh')
    const windowsBridge = join(context.runDir, 'codex-hook-bridge.ps1')
    try {
      await mkdir(dropDir, { recursive: false, mode: 0o700 })
      await writeFile(posixBridge, codexPosixBridgeScript(), {
        encoding: 'utf8',
        mode: 0o700,
        flag: 'wx'
      })
      await writeFile(windowsBridge, codexWindowsBridgeScript(), {
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
      await rm(dropDir, { recursive: true, force: true }).catch(() => {})
      return degradedPrepared('codex-drop-path-unavailable')
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
      return degradedPrepared('codex-drop-path-unavailable')
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

    const hookEnvironment = {
      HRACK_CODEX_HOOK_DROP: runtimePaths.dropDir,
      HRACK_CODEX_HOOK_BRIDGE: runtimePaths.posixBridge,
      HRACK_CODEX_HOOK_BRIDGE_WINDOWS: runtimePaths.windowsBridge
    }

    return {
      launch: {
        env: hookEnvironment,
        // Keep key=value in one argv entry. ConPTY/node-pty can otherwise
        // detach a quote-heavy TOML value from `-c`, and Codex exits before
        // the TUI starts with "a value is required for --config".
        prependArgs: [
          ...buildCodexInlineHookConfig().map(
            (config) => `--config=${config}`
          ),
          ...Object.entries(hookEnvironment).map(
            ([key, value]) =>
              `--config=shell_environment_policy.set.${key}=${JSON.stringify(value)}`
          )
        ]
      },
      capabilities: CODEX_HOOK_CAPABILITIES,
      attach: async (_running, emit): Promise<ObserverHandle> => {
        const projector = new CodexHookProjector()
        const poller = new HookDropPoller(
          dropDir,
          (payload) => {
            const fact = parseCodexHook(payload)
            if (!fact) return
            for (const event of projector.project(fact)) emit(event)
          },
          this.pollIntervalMs
        )
        poller.start()
        let handleDisposed = false
        const handle: ObserverHandle = {
          capabilities: CODEX_HOOK_CAPABILITIES,
          dispose: async () => {
            if (handleDisposed) return
            handleDisposed = true
            await poller.dispose()
          }
        }
        attachedHandle = handle
        return handle
      },
      dispose
    }
  }

  private probeHooks(
    context: ObserverPreparationContext
  ): Promise<CodexCommandResult> {
    if (context.installation.runtime.kind === 'wsl') {
      const command = wslRuntimeCommand(
        context,
        ['features', 'list'],
        'hrack-codex-features'
      )
      return this.runCommand(command.file, command.args)
    }
    return this.runCommand(context.installation.resolvedExecutable, [
      'features',
      'list'
    ])
  }

  private async runtimePaths(
    context: ObserverPreparationContext,
    hostDropDir: string,
    hostPosixBridge: string,
    hostWindowsBridge: string
  ): Promise<
    | { dropDir: string; posixBridge: string; windowsBridge: string }
    | null
  > {
    if (context.installation.runtime.kind !== 'wsl') {
      return {
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
    const runtimeDropDir = posix.join(runtimeRunDir, 'codex-drop')
    const nonce = randomBytes(12).toString('hex')
    const probe = await this.runCommand('wsl.exe', [
      '--distribution',
      distro,
      '--exec',
      '/bin/sh',
      '-c',
      'set -eu; d="$1"; n="$2"; p="$d/.$n.partial"; printf "%s" "$n" > "$p"; mv "$p" "$d/$n.probe"',
      'hrack-codex-probe',
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
      dropDir: runtimeDropDir,
      posixBridge: posix.join(runtimeRunDir, 'codex-hook-bridge.sh'),
      // WSL never selects commandWindows, but keeping the key stable avoids
      // changing the Hook definition across runtimes.
      windowsBridge: hostWindowsBridge
    }
  }
}

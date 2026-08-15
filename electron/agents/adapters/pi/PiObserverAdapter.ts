import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'
import type { ObserverCapabilities } from '../../../../shared/agent-events'
import { HookDropPoller } from '../../../hooks/HookDropPoller'
import { ThinkingCaptionClock } from '../ThinkingCaptionClock'
import type {
  AgentObserverAdapter,
  ObserverHandle,
  ObserverPreparationContext,
  PreparedObserver
} from '../types'
import { wslRuntimeCommand } from '../wslRuntimeCommand'
import { PiEventProjector } from './PiEventProjector'
import { buildPiExtensionSource } from './PiExtensionSource'
import { parsePiHook } from './PiHookParser'
import { PI_OBSERVER_CAPABILITIES } from './types'

const PROBE_TIMEOUT_MS = 3_000

const NO_CAPABILITIES: ObserverCapabilities = {
  thinking: 'none',
  tools: 'none',
  approvals: 'none',
  inputRequests: 'none',
  usage: 'none',
  messages: 'none'
}

export interface PiCommandResult {
  code: number | null
  stdout: string
}

export type PiCommandRunner = (
  file: string,
  args: readonly string[]
) => Promise<PiCommandResult>

export interface PiObserverAdapterOptions {
  runCommand?: PiCommandRunner
  pollIntervalMs?: number
}

function defaultRunCommand(
  file: string,
  args: readonly string[]
): Promise<PiCommandResult> {
  const quoteCmdArg = (value: string): string =>
    `"${value.replace(/"/g, '""')}"`
  const command =
    process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file)
      ? {
          file: process.env.ComSpec ?? 'cmd.exe',
          args: [
            '/d',
            '/v:off',
            '/c',
            `call ${[file, ...args].map(quoteCmdArg).join(' ')}`
          ],
          windowsVerbatimArguments: true
        }
      : { file, args: [...args], windowsVerbatimArguments: false }
  return new Promise((resolve) => {
    execFile(
      command.file,
      command.args,
      {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        windowsVerbatimArguments: command.windowsVerbatimArguments
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
        nativeId: `pi:degraded:${reason}`,
        nativeType: 'PiAdapterPrepare'
      })
      return { capabilities: NO_CAPABILITIES, dispose: async () => {} }
    },
    dispose: async () => {}
  }
}

function parseVersion(value: string): [number, number, number] | null {
  const match = value.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\s|$)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function supportedVersion(version: [number, number, number]): boolean {
  const [major, minor] = version
  return major > 0 || minor >= 80
}

function hasAgentSettled(version: [number, number, number]): boolean {
  const [major, minor] = version
  return major > 0 || minor >= 82
}

function hasUnsupportedCommand(args: readonly string[]): boolean {
  const unsupported = new Set([
    'install',
    'remove',
    'uninstall',
    'update',
    'list',
    'config'
  ])
  return args.some((arg) => {
    const normalized = arg.toLowerCase()
    return (
      unsupported.has(normalized) ||
      normalized === '--help' ||
      normalized === '-h' ||
      normalized === '--version' ||
      normalized === '-v' ||
      normalized === '--export' ||
      normalized.startsWith('--export=') ||
      normalized === '--list-models' ||
      normalized.startsWith('--list-models=')
    )
  })
}

async function removePiArtifacts(
  runDir: string,
  dropDir: string,
  extensionPath: string
): Promise<void> {
  const root = resolve(runDir)
  const targets = [
    { path: dropDir, expected: resolve(root, 'pi-drop'), directory: true },
    {
      path: extensionPath,
      expected: resolve(root, 'pi-observer.ts'),
      directory: false
    }
  ]
  await Promise.allSettled(
    targets.map(async (target) => {
      if (resolve(target.path) !== target.expected) return
      let info: Awaited<ReturnType<typeof lstat>>
      try {
        info = await lstat(target.path)
      } catch {
        return
      }
      if (info.isSymbolicLink()) {
        await rm(target.path, { force: true })
        return
      }
      if (target.directory ? info.isDirectory() : info.isFile()) {
        await rm(target.path, {
          force: true,
          recursive: target.directory
        })
      }
    })
  )
}

export class PiObserverAdapter implements AgentObserverAdapter {
  readonly id = 'pi'
  readonly source = 'native-stream' as const
  readonly capabilities = PI_OBSERVER_CAPABILITIES
  private readonly runCommand: PiCommandRunner
  private readonly pollIntervalMs: number

  constructor(options: PiObserverAdapterOptions = {}) {
    this.runCommand = options.runCommand ?? defaultRunCommand
    this.pollIntervalMs = options.pollIntervalMs ?? 100
  }

  supports(context: ObserverPreparationContext): boolean {
    return context.adapterId === this.id
  }

  async prepare(context: ObserverPreparationContext): Promise<PreparedObserver> {
    if (hasUnsupportedCommand(context.args)) {
      return degradedPrepared('pi-unsupported-command')
    }
    const probe = await this.probeVersion(context)
    const version = probe.code === 0 ? parseVersion(probe.stdout) : null
    if (!version || !supportedVersion(version)) {
      return degradedPrepared('pi-extension-api-unavailable')
    }
    const supportsAgentSettled = hasAgentSettled(version)
    const dropDir = join(context.runDir, 'pi-drop')
    const extensionPath = join(context.runDir, 'pi-observer.ts')
    try {
      await mkdir(dropDir, { recursive: false, mode: 0o700 })
      await writeFile(
        extensionPath,
        buildPiExtensionSource({ supportsAgentSettled }),
        { encoding: 'utf8', mode: 0o600, flag: 'wx' }
      )
      if (context.platform !== 'win32') {
        await chmod(dropDir, 0o700)
        await chmod(extensionPath, 0o600)
      }
    } catch {
      await removePiArtifacts(context.runDir, dropDir, extensionPath)
      return degradedPrepared('pi-extension-path-unavailable')
    }

    const runtimePaths = await this.runtimePaths(context, dropDir, extensionPath)
    if (!runtimePaths) {
      await removePiArtifacts(context.runDir, dropDir, extensionPath)
      return degradedPrepared('pi-wsl-drop-unavailable')
    }

    let attachedHandle: ObserverHandle | null = null
    let disposed = false
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      await attachedHandle?.dispose().catch(() => {})
      attachedHandle = null
      await removePiArtifacts(context.runDir, dropDir, extensionPath)
    }

    return {
      launch: {
        prependArgs: ['--extension', runtimePaths.extensionPath],
        env: {
          HRACK_PI_DROP_DIR: runtimePaths.dropDir,
          HRACK_PI_SESSION_ID: context.sessionId,
          HRACK_PI_SCHEMA: '1'
        }
      },
      capabilities: PI_OBSERVER_CAPABILITIES,
      attach: async (_running, emit): Promise<ObserverHandle> => {
        const projector = new PiEventProjector({ supportsAgentSettled })
        const thinkingClock = new ThinkingCaptionClock(
          `pi:${context.sessionId}:thinking`,
          'PiThinkingTimer',
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
            const fact = parsePiHook(payload, context.sessionId)
            if (!fact) return
            for (const event of projector.project(fact)) emitProjected(event)
          },
          this.pollIntervalMs
        )
        poller.start()
        let handleDisposed = false
        const handle: ObserverHandle = {
          capabilities: PI_OBSERVER_CAPABILITIES,
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
  ): Promise<PiCommandResult> {
    if (context.installation.runtime.kind === 'wsl') {
      const command = wslRuntimeCommand(
        context,
        ['--version'],
        'hrack-pi-version'
      )
      return this.runCommand(command.file, command.args)
    }
    return this.runCommand(context.installation.resolvedExecutable, ['--version'])
  }

  private async runtimePaths(
    context: ObserverPreparationContext,
    hostDropDir: string,
    hostExtensionPath: string
  ): Promise<{ dropDir: string; extensionPath: string } | null> {
    if (context.installation.runtime.kind !== 'wsl') {
      return { dropDir: hostDropDir, extensionPath: hostExtensionPath }
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
    const runtimeDropDir = posix.join(runtimeRunDir, 'pi-drop')
    const nonce = randomBytes(12).toString('hex')
    const probe = await this.runCommand('wsl.exe', [
      '--distribution',
      distro,
      '--exec',
      '/bin/sh',
      '-c',
      'set -eu; d="$1"; n="$2"; p="$d/.$n.partial"; printf "%s" "$n" > "$p"; mv "$p" "$d/$n.probe"',
      'hrack-pi-probe',
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
      extensionPath: posix.join(runtimeRunDir, 'pi-observer.ts')
    }
  }
}

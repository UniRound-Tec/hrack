import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { posix, join } from 'node:path'
import type { ObserverCapabilities } from '../../../../shared/agent-events'
import type { HookIngress, HookRoute } from '../../../hooks/HookIngress'
import { WslHookDropPoller } from '../../../hooks/WslHookDropPoller'
import type {
  AdapterEvent,
  AgentObserverAdapter,
  ObserverHandle,
  ObserverPreparationContext,
  PreparedObserver
} from '../types'
import { claudeEnvironmentAugmentation } from './claudeEnvironment'
import {
  probeHttpHookPolicy,
  writeClaudeHookSettings,
  type ClaudeHookHandler
} from './claudeHookSettings'
import { parseClaudeHook } from './ClaudeHookParser'
import { ClaudeHookProjector } from './ClaudeHookProjector'
import {
  CLAUDE_HOOK_CAPABILITIES,
  type ClaudeObserverDegradedReason
} from './types'

const NO_CAPABILITIES: ObserverCapabilities = {
  thinking: 'none',
  tools: 'none',
  approvals: 'none',
  inputRequests: 'none',
  usage: 'none',
  messages: 'none'
}
const PROBE_TIMEOUT_MS = 3_000
const REQUEST_SWEEP_MS = 60_000

interface CommandResult {
  code: number | null
  stdout: string
}

interface PreparedTransport {
  handler: ClaudeHookHandler
  settingsPathForRuntime: string
  route?: HookRoute
  pollerFactory?: (listener: (payload: unknown) => void) => WslHookDropPoller
  dispose(): Promise<void>
}

function runCommand(file: string, args: readonly string[]): Promise<CommandResult> {
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
        const failure = error as (NodeJS.ErrnoException & { code?: string | number }) | null
        resolve({
          code: typeof failure?.code === 'number' ? failure.code : error ? null : 0,
          stdout: String(stdout ?? '')
        })
      }
    )
  })
}

function runWsl(distro: string, executable: string, args: readonly string[]): Promise<CommandResult> {
  return runCommand('wsl.exe', [
    '--distribution',
    distro,
    '--exec',
    executable,
    ...args
  ])
}

function versionSupported(version: string | undefined): boolean {
  if (!version) return true
  const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/)
  return !match || Number(match[1]) >= 2
}

function hasSettingsConflict(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--settings' || arg.startsWith('--settings='))
}

function degradedPrepared(reason: ClaudeObserverDegradedReason): PreparedObserver {
  return {
    launch: {},
    capabilities: NO_CAPABILITIES,
    attach: async (_context, emit): Promise<ObserverHandle> => {
      emit({
        kind: 'observer.degraded',
        payload: { reason, remaining: NO_CAPABILITIES },
        nativeId: `claude-degraded:${reason}`,
        nativeType: 'ClaudeAdapterPrepare'
      })
      return { capabilities: NO_CAPABILITIES, dispose: async () => {} }
    },
    dispose: async () => {}
  }
}

async function writeOwner(context: ObserverPreparationContext): Promise<void> {
  await writeFile(
    join(context.runDir, 'owner.json'),
    JSON.stringify(
      {
        schema: 1,
        sessionId: context.sessionId,
        pid: process.pid,
        createdAt: Date.now(),
        nonce: randomBytes(16).toString('hex')
      },
      null,
      2
    ),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  )
}

function bridgeScript(): string {
  return `#!/bin/sh
set -eu
umask 077
drop="$1"
tmp="$(mktemp "$drop/.vibing-hook.XXXXXX.partial")" || exit 0
trap 'rm -f "$tmp"' EXIT HUP INT TERM
dd bs=1048577 count=1 of="$tmp" 2>/dev/null || true
size="$(wc -c < "$tmp" | tr -d ' ')"
[ "$size" -gt 0 ] || exit 0
[ "$size" -le 1048576 ] || exit 0
final="$drop/$(date +%s).$$.$(basename "$tmp" .partial).json"
mv "$tmp" "$final"
trap - EXIT HUP INT TERM
`
}

async function translateWslPath(distro: string, windowsPath: string): Promise<string | null> {
  const result = await runWsl(distro, 'wslpath', ['-a', '-u', windowsPath])
  const path = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('/'))
  return result.code === 0 && path ? path : null
}

async function probeFileRoundTrip(
  distro: string,
  hostDropDir: string,
  runtimeDropDir: string
): Promise<boolean> {
  const nonce = randomBytes(12).toString('hex')
  const hostResult = join(hostDropDir, `${nonce}.probe`)
  const script = 'set -eu; d="$1"; n="$2"; p="$d/.$n.partial"; printf "%s" "$n" > "$p"; mv "$p" "$d/$n.probe"'
  const result = await runWsl(distro, '/bin/sh', ['-c', script, 'vibing-probe', runtimeDropDir, nonce])
  if (result.code !== 0) return false
  try {
    return (await readFile(hostResult, 'utf8')) === nonce
  } catch {
    return false
  } finally {
    await rm(hostResult, { force: true }).catch(() => {})
  }
}

export class ClaudeObserverAdapter implements AgentObserverAdapter {
  readonly id = 'claude-code'
  readonly source = 'hook' as const
  readonly capabilities = CLAUDE_HOOK_CAPABILITIES

  constructor(private readonly ingress: HookIngress) {}

  supports(context: ObserverPreparationContext): boolean {
    return context.adapterId === this.id
  }

  async prepare(context: ObserverPreparationContext): Promise<PreparedObserver> {
    if (hasSettingsConflict(context.args)) return degradedPrepared('user-settings-conflict')
    if (!versionSupported(context.installation.version)) return degradedPrepared('unsupported-version')

    try {
      await writeOwner(context)
      if (process.platform !== 'win32') await chmod(join(context.runDir, 'owner.json'), 0o600)
    } catch {
      return degradedPrepared('settings-create-failed')
    }

    const transport = context.installation.runtime.kind === 'wsl'
      ? await this.prepareWslTransport(context)
      : await this.prepareHostTransport(context)
    if ('reason' in transport) return degradedPrepared(transport.reason)

    const settingsPath = join(context.runDir, 'claude-settings.json')
    try {
      await writeClaudeHookSettings(settingsPath, transport.handler)
    } catch {
      await transport.dispose()
      return degradedPrepared('settings-create-failed')
    }

    let disposed = false
    let attachedHandle: ObserverHandle | null = null
    const disposePrepared = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      await attachedHandle?.dispose().catch(() => {})
      attachedHandle = null
      await transport.dispose()
    }

    return {
      launch: {
        ...claudeEnvironmentAugmentation(),
        prependArgs: ['--settings', transport.settingsPathForRuntime]
      },
      capabilities: CLAUDE_HOOK_CAPABILITIES,
      attach: async (_running, emit): Promise<ObserverHandle> => {
        const projector = new ClaudeHookProjector()
        let invalidReported = false
        let overflowReported = false
        const onPayload = (payload: unknown): void => {
          const sentinel = payload && typeof payload === 'object'
            ? (payload as Record<string, unknown>).__vibing_degraded
            : undefined
          if (sentinel === 'hook-queue-overflow') {
            if (!overflowReported) {
              overflowReported = true
              emit({
                kind: 'observer.degraded',
                payload: {
                  reason: 'hook-queue-overflow',
                  remaining: CLAUDE_HOOK_CAPABILITIES
                },
                nativeId: `claude:${context.sessionId}:hook-overflow`,
                nativeType: 'HookIngress'
              })
            }
            return
          }
          const fact = parseClaudeHook(payload)
          if (!fact) {
            if (!invalidReported) {
              invalidReported = true
              emit({
                kind: 'observer.degraded',
                payload: { reason: 'invalid-payload', remaining: CLAUDE_HOOK_CAPABILITIES },
                nativeId: `claude:${context.sessionId}:invalid-payload`,
                nativeType: 'ClaudeHookParser'
              })
            }
            return
          }
          for (const event of projector.project(fact)) emit(event)
        }

        const unsubscribe = transport.route?.subscribe(onPayload) ?? (() => {})
        const poller = transport.pollerFactory?.(onPayload)
        poller?.start()
        const sweep = setInterval(() => {
          for (const event of projector.expireRequests()) emit(event)
        }, REQUEST_SWEEP_MS)
        let handleDisposed = false
        const handle: ObserverHandle = {
          capabilities: CLAUDE_HOOK_CAPABILITIES,
          dispose: async () => {
            if (handleDisposed) return
            handleDisposed = true
            clearInterval(sweep)
            unsubscribe()
            await poller?.dispose()
          }
        }
        attachedHandle = handle
        return handle
      },
      dispose: disposePrepared
    }
  }

  private async prepareHostTransport(
    context: ObserverPreparationContext
  ): Promise<PreparedTransport | { reason: ClaudeObserverDegradedReason }> {
    let route: HookRoute
    try {
      route = await this.ingress.register(context.sessionId, this.id)
    } catch {
      return { reason: 'hook-ingress-unavailable' }
    }
    const policy = await probeHttpHookPolicy(route.url, context.workspace)
    if (policy.policy === 'denied') {
      await route.dispose()
      return { reason: policy.reason ?? 'http-hooks-not-allowed' }
    }
    return {
      handler: { type: 'http', url: route.url, timeout: 2 },
      settingsPathForRuntime: join(context.runDir, 'claude-settings.json'),
      route,
      dispose: () => route.dispose()
    }
  }

  private async prepareWslTransport(
    context: ObserverPreparationContext
  ): Promise<PreparedTransport | { reason: ClaudeObserverDegradedReason }> {
    if (context.installation.runtime.kind !== 'wsl') {
      return { reason: 'wsl-transport-unavailable' }
    }
    const distro = context.installation.runtime.distro
    const dropDir = join(context.runDir, 'drop')
    await mkdir(dropDir, { recursive: false, mode: 0o700 }).catch(() => {})
    const [runtimeRunDir, curlProbe] = await Promise.all([
      translateWslPath(distro, context.runDir),
      runWsl(distro, 'curl.exe', ['--version'])
    ])
    if (!runtimeRunDir) return { reason: 'wsl-transport-unavailable' }

    const runtimeDropDir = posix.join(runtimeRunDir, 'drop')
    const fileAvailable = await probeFileRoundTrip(distro, dropDir, runtimeDropDir)
    if (fileAvailable) {
      const bridgePath = join(context.runDir, 'bridge.sh')
      await writeFile(bridgePath, bridgeScript(), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      return {
        handler: {
          type: 'command',
          command: '/bin/sh',
          args: [posix.join(runtimeRunDir, 'bridge.sh'), runtimeDropDir],
          timeout: 10
        },
        settingsPathForRuntime: posix.join(runtimeRunDir, 'claude-settings.json'),
        pollerFactory: (listener) => new WslHookDropPoller(dropDir, listener),
        dispose: async () => {}
      }
    }

    if (curlProbe.code === 0) {
      let route: HookRoute
      try {
        route = await this.ingress.register(context.sessionId, this.id)
      } catch {
        return { reason: 'hook-ingress-unavailable' }
      }
      return {
        handler: {
          type: 'command',
          command: 'curl.exe',
          args: [
            '--silent',
            '--show-error',
            '--max-time',
            '2',
            '--header',
            'Content-Type: application/json',
            '--data-binary',
            '@-',
            route.url
          ],
          timeout: 3
        },
        settingsPathForRuntime: posix.join(runtimeRunDir, 'claude-settings.json'),
        route,
        dispose: () => route.dispose()
      }
    }
    return { reason: 'wsl-transport-unavailable' }
  }
}

import { randomInt } from 'node:crypto'
import { createServer } from 'node:net'
import type { ObserverCapabilities } from '../../../../shared/agent-events'
import type {
  AdapterEvent,
  AgentObserverAdapter,
  ObserverHandle,
  ObserverPreparationContext,
  PreparedObserver
} from '../types'
import { parseOpenCodeEvent } from './OpenCodeEventParser'
import { OpenCodeEventProjector } from './OpenCodeEventProjector'
import {
  HostOpenCodeTransport,
  OpenCodeTransportError,
  runWslCommand,
  WslOpenCodeTransport,
  type OpenCodeConnection,
  type OpenCodeTransport
} from './OpenCodeTransport'
import {
  OPENCODE_CAPABILITIES,
  type OpenCodeObserverDegradedReason
} from './types'

const NO_CAPABILITIES: ObserverCapabilities = {
  thinking: 'none',
  tools: 'none',
  approvals: 'none',
  inputRequests: 'none',
  usage: 'none',
  messages: 'none'
}
const HEALTH_BUDGET_MS = 5_000
const CONNECTED_BUDGET_MS = 1_500
const CONNECT_RETRY_BUDGET_MS = 15_000
const RECONCILE_BUDGET_MS = 3_000
const MAX_BUFFERED_EVENTS = 512
const MAX_BUFFERED_BYTES = 1024 * 1024
const reservedPorts = new Set<string>()

interface LaunchEndpoint {
  port: number
  hostname: string
  appendArgs: string[]
  reservationKey?: string
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function versionSupported(version: string | undefined): boolean {
  if (!version) return true
  const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/)
  return !match || Number(match[1]) >= 1
}

function flagValue(args: readonly string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    if (value === name) return args[index + 1]
    if (value.startsWith(`${name}=`)) return value.slice(name.length + 1)
  }
  return undefined
}

function countFlag(args: readonly string[], name: string): number {
  return args.filter((value) => value === name || value.startsWith(`${name}=`))
    .length
}

function hasUnsupportedCommand(args: readonly string[]): boolean {
  const commands = new Set([
    'attach',
    'run',
    'serve',
    'web',
    'acp',
    'completion',
    'mcp',
    'auth',
    'providers',
    'agent',
    'upgrade',
    'uninstall',
    'models',
    'stats',
    'export',
    'import',
    'github',
    'pr',
    'session',
    'plugin',
    'plug',
    'db',
    'debug'
  ])
  return args.some(
    (value) => !value.startsWith('-') && commands.has(value.toLowerCase())
  )
}

function loopback(hostname: string): boolean {
  const clean = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
  return clean === '127.0.0.1' || clean === 'localhost' || clean === '::1'
}

function endpointHost(hostname: string): string {
  const clean = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
  return clean === '::1' ? '[::1]' : clean === 'localhost' ? '127.0.0.1' : clean
}

function degradedPrepared(
  reason: OpenCodeObserverDegradedReason
): PreparedObserver {
  return {
    launch: {},
    capabilities: NO_CAPABILITIES,
    attach: async (_context, emit): Promise<ObserverHandle> => {
      emit({
        kind: 'observer.degraded',
        payload: { reason, remaining: NO_CAPABILITIES },
        nativeId: `opencode:degraded:${reason}`,
        nativeType: 'OpenCodeAdapterPrepare'
      })
      return { capabilities: NO_CAPABILITIES, dispose: async () => {} }
    },
    dispose: async () => {}
  }
}

function allocateHostPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close((error) => {
        if (error || port <= 0)
          reject(error ?? new Error('No host port allocated'))
        else resolve(port)
      })
    })
  })
}

function hostPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => resolve(!error))
    })
  })
}

async function wslPortFree(distro: string, port: number): Promise<boolean> {
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  const script =
    'h="$1"; ! grep -Eqi ":$h[[:space:]]" /proc/net/tcp /proc/net/tcp6 2>/dev/null'
  const result = await runWslCommand(distro, '/bin/sh', [
    '-c',
    script,
    'vibing-port',
    hex
  ])
  return result.code === 0
}

async function allocateWslPort(distro: string): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = randomInt(49_152, 65_536)
    const key = `wsl:${distro}:${port}`
    if (reservedPorts.has(key)) continue
    if (await wslPortFree(distro, port)) return port
  }
  throw new Error('No WSL port available')
}

async function prepareEndpoint(
  context: ObserverPreparationContext
): Promise<LaunchEndpoint | { reason: OpenCodeObserverDegradedReason }> {
  if (hasUnsupportedCommand(context.args))
    return { reason: 'unsupported-command-shape' }
  if (
    countFlag(context.args, '--port') > 1 ||
    countFlag(context.args, '--hostname') > 1
  )
    return { reason: 'server-argument-conflict' }
  if (
    context.args.some(
      (value) => value === '--mdns' || value.startsWith('--mdns=')
    )
  ) {
    return { reason: 'unsafe-server-binding' }
  }

  const rawHostname = flagValue(context.args, '--hostname')
  if (countFlag(context.args, '--hostname') > 0 && rawHostname === undefined) {
    return { reason: 'server-argument-conflict' }
  }
  if (rawHostname !== undefined && !loopback(rawHostname)) {
    return { reason: 'unsafe-server-binding' }
  }
  const hostname = rawHostname ?? '127.0.0.1'
  const rawPort = flagValue(context.args, '--port')
  if (countFlag(context.args, '--port') > 0 && rawPort === undefined) {
    return { reason: 'server-argument-conflict' }
  }
  let port: number
  if (rawPort !== undefined) {
    port = Number(rawPort)
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      return { reason: 'server-argument-conflict' }
    }
    const available =
      context.installation.runtime.kind === 'wsl'
        ? await wslPortFree(context.installation.runtime.distro, port)
        : await hostPortFree(port)
    if (!available) return { reason: 'port-unavailable' }
  } else {
    try {
      port =
        context.installation.runtime.kind === 'wsl'
          ? await allocateWslPort(context.installation.runtime.distro)
          : await allocateHostPort()
    } catch {
      return { reason: 'port-unavailable' }
    }
  }

  const runtimeKey =
    context.installation.runtime.kind === 'wsl'
      ? `wsl:${context.installation.runtime.distro}:${port}`
      : `host:${port}`
  if (reservedPorts.has(runtimeKey)) return { reason: 'port-unavailable' }
  reservedPorts.add(runtimeKey)

  const appendArgs: string[] = []
  if (rawHostname === undefined) appendArgs.push('--hostname', hostname)
  if (rawPort === undefined) appendArgs.push('--port', String(port))
  return { port, hostname, appendArgs, reservationKey: runtimeKey }
}

async function probeWslCurl(distro: string): Promise<string | null> {
  const found = await runWslCommand(distro, '/bin/sh', [
    '-c',
    'command -v curl 2>/dev/null || true'
  ])
  const path = found.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('/'))
  if (!path) return null
  const version = await runWslCommand(distro, path, ['--version'])
  return version.code === 0 ? path : null
}

async function waitForHealth(
  transport: OpenCodeTransport
): Promise<{ version: string }> {
  const startedAt = Date.now()
  let delay = 50
  let lastError: unknown
  while (Date.now() - startedAt < HEALTH_BUDGET_MS) {
    try {
      return await transport.health()
    } catch (error) {
      lastError = error
      if (
        error instanceof OpenCodeTransportError &&
        error.code === 'auth-required'
      )
        throw error
      await sleep(delay)
      delay = Math.min(delay * 2, 400)
    }
  }
  throw lastError ?? new Error('OpenCode server did not become ready')
}

function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function approximateBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return MAX_BUFFERED_BYTES + 1
  }
}

export class OpenCodeObserverAdapter implements AgentObserverAdapter {
  readonly id = 'opencode'
  readonly source = 'rpc' as const
  readonly capabilities = OPENCODE_CAPABILITIES

  supports(context: ObserverPreparationContext): boolean {
    return context.adapterId === this.id
  }

  async prepare(
    context: ObserverPreparationContext
  ): Promise<PreparedObserver> {
    if (!versionSupported(context.installation.version)) {
      return degradedPrepared('unsupported-version')
    }
    const endpoint = await prepareEndpoint(context)
    if ('reason' in endpoint) return degradedPrepared(endpoint.reason)

    let transport: OpenCodeTransport
    if (context.installation.runtime.kind === 'wsl') {
      const curlPath = await probeWslCurl(context.installation.runtime.distro)
      if (!curlPath) {
        if (endpoint.reservationKey)
          reservedPorts.delete(endpoint.reservationKey)
        return degradedPrepared('wsl-sse-client-unavailable')
      }
      transport = new WslOpenCodeTransport(
        context.installation.runtime.distro,
        curlPath,
        `http://${endpointHost(endpoint.hostname)}:${endpoint.port}`
      )
    } else {
      transport = new HostOpenCodeTransport(
        `http://${endpointHost(endpoint.hostname)}:${endpoint.port}`
      )
    }

    const projector = new OpenCodeEventProjector()
    let disposed = false
    let activeConnection: OpenCodeConnection | null = null

    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      if (endpoint.reservationKey) reservedPorts.delete(endpoint.reservationKey)
      await activeConnection?.dispose().catch(() => {})
      activeConnection = null
      await transport.dispose()
    }

    const openHandle = async (
      emit: (event: AdapterEvent) => void
    ): Promise<ObserverHandle> => {
      try {
        await waitForHealth(transport)
      } catch (error) {
        throw new Error(`OpenCode health handshake failed: ${String(error)}`)
      }
      if (disposed) throw new Error('OpenCode observer disposed')

      let buffering = true
      let bufferedBytes = 0
      let bufferOverflow = false
      let connected = false
      let resolveConnected: (() => void) | null = null
      const buffered: unknown[] = []
      const disconnectListeners = new Set<(reason: string) => void>()
      const projectRaw = (raw: unknown): void => {
        const fact = parseOpenCodeEvent(raw)
        // Bus 还包含 file/lsp/todo/installation 等与 pane 状态无关的事件；
        // 未识别事件必须安静忽略，不能把正常扩展事件误报成 schema 漂移。
        if (!fact) return
        if (fact.type === 'server-connected') {
          if (!connected) {
            connected = true
            resolveConnected?.()
          }
          return
        }
        for (const projected of projector.project(fact)) emit(projected)
      }

      const onRaw = (raw: unknown): void => {
        const fact = parseOpenCodeEvent(raw)
        if (fact?.type === 'server-connected' && !connected) {
          connected = true
          resolveConnected?.()
        }
        if (!buffering) {
          projectRaw(raw)
          return
        }
        const bytes = approximateBytes(raw)
        if (
          buffered.length >= MAX_BUFFERED_EVENTS ||
          bufferedBytes + bytes > MAX_BUFFERED_BYTES
        ) {
          bufferOverflow = true
          return
        }
        bufferedBytes += bytes
        buffered.push(raw)
      }

      let connection: OpenCodeConnection | null = null
      let connectError: unknown
      const connectStartedAt = Date.now()
      let connectAttempt = 0
      while (Date.now() - connectStartedAt < CONNECT_RETRY_BUDGET_MS) {
        connectAttempt++
        connected = false
        const connectedPromise = new Promise<void>((resolve) => {
          resolveConnected = resolve
        })
        try {
          const candidate = await transport.connect(onRaw, (reason) => {
            for (const listener of disconnectListeners) listener(reason)
          })
          try {
            await withTimeout(
              connectedPromise,
              CONNECTED_BUDGET_MS,
              'OpenCode server.connected timed out'
            )
            connection = candidate
            break
          } catch (error) {
            connectError = error
            await candidate.dispose()
          }
        } catch (error) {
          connectError = error
        }
        // OpenCode TUI 的初始 project instance 切换可能短暂 reset 首条连接。
        // 每次失败都丢弃该连接的未确认 frame，再重新 health-check。
        buffered.length = 0
        bufferedBytes = 0
        bufferOverflow = false
        await sleep(Math.min(100 * 2 ** (connectAttempt - 1), 1_000))
        try {
          await waitForHealth(transport)
        } catch (error) {
          connectError = error
        }
      }
      if (!connection) {
        throw new Error(
          `OpenCode SSE handshake failed: ${String(connectError ?? 'unavailable')}`
        )
      }
      activeConnection = connection

      try {
        const snapshot = await withTimeout(
          transport.snapshot(),
          RECONCILE_BUDGET_MS,
          'OpenCode status reconciliation timed out'
        )
        for (const projected of projector.reconcile(snapshot)) emit(projected)
      } catch {
        emit({
          kind: 'observer.degraded',
          payload: {
            reason: 'reconcile-unavailable',
            remaining: OPENCODE_CAPABILITIES
          },
          nativeId: `opencode:${context.sessionId}:reconcile-unavailable`,
          nativeType: 'OpenCodeStatusReconcile'
        })
      }
      buffering = false
      for (const raw of buffered) projectRaw(raw)
      if (bufferOverflow) {
        emit({
          kind: 'observer.degraded',
          payload: {
            reason: 'sse-event-too-large',
            remaining: OPENCODE_CAPABILITIES
          },
          nativeId: `opencode:${context.sessionId}:reconcile-buffer-overflow`,
          nativeType: 'OpenCodeStatusReconcile'
        })
      }

      let handleDisposed = false
      const handle: ObserverHandle = {
        capabilities: OPENCODE_CAPABILITIES,
        onDisconnect(listener) {
          disconnectListeners.add(listener)
          return () => disconnectListeners.delete(listener)
        },
        reconnect: async () => {
          await connection.dispose()
          if (activeConnection === connection) activeConnection = null
          return openHandle(emit)
        },
        dispose: async () => {
          if (handleDisposed) return
          handleDisposed = true
          disconnectListeners.clear()
          await connection.dispose()
          if (activeConnection === connection) activeConnection = null
        }
      }
      return handle
    }

    return {
      launch: { appendArgs: endpoint.appendArgs },
      capabilities: OPENCODE_CAPABILITIES,
      attach: async (_running, emit) => openHandle(emit),
      dispose
    }
  }
}

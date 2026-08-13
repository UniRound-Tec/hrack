/**
 * 官方 dsh-client-connection 的 IPC 替换件。
 *
 * npm 产物是 __ModuleLoader__ banner，不能当普通 ESM import。P1 seam
 * 是 loadBundle：拦截该插件 client.js，物化官方 factory，取出
 * AbstractApiClient / RpcId，再注册一份 apply()——ctx.connection 使用
 * IpcApiClient（doFetch + WS 下行都走 vibing IPC），不再依赖全局
 * fetch/WebSocket 包装。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { DshWireFetchResponse } from '../../shared/dsh-ipc'

export const DSH_CONNECTION_ID = '@deepseek-ai/dsh-client-connection'
const INTERNAL_BASE = 'http://dsh.internal'
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface FactoryHandoff {
  id: string
  factory: (require: (spec: string) => unknown) => unknown
}

interface ModuleLoaderSink {
  load(handoff: FactoryHandoff): void
}

type ConnectionState = 'connected' | 'reconnecting'

interface ConnectionSinks {
  onMuxEnvelope?: (envelope: { rpcId: string; payload: unknown }) => void
  onHostEnvelope?: (envelope: { rpcId: string; payload: unknown }) => void
  onConnected?: (description: unknown) => void
  onStateChange?: (state: ConnectionState) => void
}

interface ConnectionConfig {
  backoffBaseMs?: number
  backoffFactor?: number
  backoffMaxMs?: number
  streamOpenTimeoutMs?: number
}

interface OfficialExports {
  AbstractApiClient: new (timeoutMs?: number) => OfficialClient
  RpcId: (id: string) => string
  apply?: (ctx: Context) => void
  inject?: string[]
}

interface OfficialClient {
  host: {
    describe(
      payload: Record<string, never>,
      signal?: AbortSignal
    ): Promise<{
      result:
        | { ok: true; value: unknown }
        | { ok: false; error: { code: string; message: string } }
    }>
  }
  events: {
    mux(
      payload: Record<string, never>,
      signal: AbortSignal,
      onOpen?: () => void
    ): AsyncIterable<{ rpcId: string; payload: { type: string } }>
    host(
      payload: Record<string, never>,
      signal: AbortSignal,
      onOpen?: () => void
    ): AsyncIterable<{ rpcId: string; payload: { type: string } }>
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    const timer = window.setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer)
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      },
      { once: true }
    )
  })
}

function resolveBase(): string {
  const origin = window.location.origin
  return origin !== '' && origin !== 'null' ? origin : INTERNAL_BASE
}

function normalizeHeaders(init: HeadersInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!init) return headers
  new Headers(init).forEach((value, key) => {
    headers[key] = value
  })
  return headers
}

async function ipcFetch(input: URL, init?: RequestInit): Promise<Response> {
  const body = init?.body
  if (body !== undefined && body !== null && typeof body !== 'string') {
    throw new Error('dsh wire: non-string request body is not supported over IPC yet')
  }
  const requestId = crypto.randomUUID()
  const signal = init?.signal ?? null
  const onAbort = (): void => {
    void window.dshWireApi.abortFetch(requestId)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  let response: DshWireFetchResponse
  try {
    response = await Promise.race([
      window.dshWireApi.fetch({
        requestId,
        method: init?.method ?? 'GET',
        path: input.pathname + input.search,
        headers: normalizeHeaders(init?.headers),
        body: body ?? undefined
      }),
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true }
        )
      })
    ])
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  return new Response(response.body, {
    status: response.status,
    headers: response.headers
  })
}

function assertTarget(channel: string, endpoint: string): void {
  const segments = endpoint.split('/')
  if (
    !CHANNEL_PATTERN.test(channel) ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        !ENDPOINT_SEGMENT_PATTERN.test(segment)
    )
  ) {
    throw new Error(
      `connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`
    )
  }
}

function createIpcConnectionRpc(mintRpcId: (id: string) => string): {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
} {
  return {
    async call(channel, endpoint, payload, signal) {
      assertTarget(channel, endpoint)
      const rpcId = mintRpcId(crypto.randomUUID())
      const response = await ipcFetch(
        new URL(`${channel}/${endpoint}`, resolveBase()),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId,
            method: endpoint,
            payload
          }),
          ...(signal === undefined ? {} : { signal })
        }
      )
      if (!response.ok) {
        throw new Error(
          `transport failure for ${channel}/${endpoint}: HTTP ${response.status}`
        )
      }
      const full = (await response.json()) as {
        rpcId?: string
        result?: { ok: boolean; value?: unknown; error?: unknown }
      }
      if (full.rpcId !== rpcId) {
        throw new Error(
          `rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${String(full.rpcId)}`
        )
      }
      if (!full.result) throw new Error(`missing result for ${endpoint}`)
      return full.result
    }
  }
}

async function* readIpcStream(
  path: string,
  signal: AbortSignal,
  onEnvelope: (message: unknown) => void,
  onOpen?: () => void
): AsyncGenerator<{ rpcId: string; payload: { type: string } }> {
  const streamId = crypto.randomUUID()
  type Item =
    | { kind: 'frame'; envelope: { rpcId: string; payload: { type: string } } }
    | { kind: 'end' }
  const inbox: Item[] = []
  let wake: (() => void) | undefined
  const enqueue = (item: Item): void => {
    inbox.push(item)
    wake?.()
    wake = undefined
  }
  const api = window.dshWireApi
  const stopOpened = api.onStreamOpened((event) => {
    if (event.streamId !== streamId) return
    onOpen?.()
  })
  const stopMessage = api.onStreamMessage((event) => {
    if (event.streamId !== streamId) return
    try {
      const full = JSON.parse(event.data) as {
        type?: string
        rpcId?: string
        payload?: { type?: string }
      }
      if (full.type !== 'server-request' || typeof full.rpcId !== 'string') return
      if (!full.payload || typeof full.payload.type !== 'string') return
      onEnvelope(full)
      enqueue({
        kind: 'frame',
        envelope: { rpcId: full.rpcId, payload: full.payload as { type: string } }
      })
    } catch (error) {
      console.error('[dsh-ipc-connection] dropping malformed frame on', path, error)
    }
  })
  const stopClosed = api.onStreamClosed((event) => {
    if (event.streamId !== streamId) return
    enqueue({ kind: 'end' })
  })
  const handleAbort = (): void => {
    void api.closeStream(streamId)
  }
  signal.addEventListener('abort', handleAbort, { once: true })
  if (signal.aborted) handleAbort()
  try {
    await api.openStream({ streamId, path })
    while (true) {
      while (inbox.length > 0) {
        const item = inbox.shift()
        if (!item || item.kind === 'end') return
        yield item.envelope
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  } finally {
    signal.removeEventListener('abort', handleAbort)
    stopOpened()
    stopMessage()
    stopClosed()
    handleAbort()
  }
}

class IpcConnectionController {
  private generation = 0
  private attempt = 0
  private current: AbortController | null = null
  private running = false
  private lastState: ConnectionState | null = null
  private readonly config: Required<ConnectionConfig>

  constructor(
    private readonly api: OfficialClient,
    private readonly sinks: ConnectionSinks,
    config: ConnectionConfig
  ) {
    this.config = {
      backoffBaseMs: config.backoffBaseMs ?? 500,
      backoffFactor: config.backoffFactor ?? 2,
      backoffMaxMs: config.backoffMaxMs ?? 8_000,
      streamOpenTimeoutMs: config.streamOpenTimeoutMs ?? 2_000
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop(): void {
    this.running = false
    this.current?.abort()
    this.current = null
  }

  private backoffDelay(attempt: number): number {
    const { backoffBaseMs, backoffFactor, backoffMaxMs } = this.config
    const cap = Math.min(
      backoffMaxMs,
      backoffBaseMs * backoffFactor ** Math.max(0, attempt - 1)
    )
    return cap / 2 + Math.random() * (cap / 2)
  }

  private emitState(state: ConnectionState): void {
    if (this.lastState === state) return
    this.lastState = state
    this.callSink(() => this.sinks.onStateChange?.(state))
  }

  private callSink(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      console.error('[dsh-ipc-connection] sink threw:', error)
    }
  }

  private async pumpStream(
    stream: AsyncIterable<{ rpcId: string; payload: { type: string } }>,
    sink: ((envelope: { rpcId: string; payload: unknown }) => void) | undefined,
    onEnd: () => void
  ): Promise<void> {
    try {
      for await (const envelope of stream) {
        if (envelope.payload.type === 'stream/error') break
        if (sink !== undefined) this.callSink(() => sink(envelope))
      }
    } catch {
      /* generation abort / transport close */
    }
    onEnd()
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const generation = ++this.generation
      const abort = new AbortController()
      this.current = abort
      let muxOpened = (): void => undefined
      let hostOpened = (): void => undefined
      const streamsOpen = Promise.all([
        new Promise<void>((resolve) => {
          muxOpened = resolve
        }),
        new Promise<void>((resolve) => {
          hostOpened = resolve
        })
      ])
      const failed = new Promise<void>((resolve) => {
        const settle = (): void => {
          if (generation === this.generation && !abort.signal.aborted) abort.abort()
          resolve()
        }
        void this.pumpStream(
          this.api.events.mux({}, abort.signal, muxOpened),
          this.sinks.onMuxEnvelope,
          settle
        )
        void this.pumpStream(
          this.api.events.host({}, abort.signal, hostOpened),
          this.sinks.onHostEnvelope,
          settle
        )
      })
      try {
        const timeout = new AbortController()
        const [description] = await Promise.all([
          this.api.host.describe({}),
          Promise.race([
            streamsOpen,
            sleep(this.config.streamOpenTimeoutMs, timeout.signal)
          ])
        ])
        timeout.abort()
        if (!description.result.ok) {
          throw new Error(
            `host.describe failed: ${description.result.error.code}: ${description.result.error.message}`
          )
        }
        if (abort.signal.aborted) throw new Error('generation aborted')
        this.attempt = 0
        this.emitState('connected')
        if (this.running && !abort.signal.aborted) {
          const value = description.result.value
          this.callSink(() => this.sinks.onConnected?.(value))
        }
      } catch {
        if (!abort.signal.aborted) abort.abort()
      }
      await failed
      if (!this.running) return
      this.emitState('reconnecting')
      this.attempt += 1
      await sleep(this.backoffDelay(this.attempt)).catch(() => undefined)
    }
  }
}

function createIpcApiClient(AbstractApiClient: OfficialExports['AbstractApiClient']): OfficialClient {
  class IpcApiClient extends AbstractApiClient {
    protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
      return ipcFetch(input, init)
    }

    protected resolveBase(): string {
      return resolveBase()
    }

    protected openMux(
      _payload: Record<string, never>,
      signal: AbortSignal,
      onOpen?: () => void
    ): AsyncIterable<{ rpcId: string; payload: { type: string } }> {
      return readIpcStream('/api/events.mux', signal, (message) => {
        this.onEnvelope(message)
      }, onOpen)
    }

    protected openHost(
      _payload: Record<string, never>,
      signal: AbortSignal,
      onOpen?: () => void
    ): AsyncIterable<{ rpcId: string; payload: { type: string } }> {
      return readIpcStream('/api/events.host', signal, (message) => {
        this.onEnvelope(message)
      }, onOpen)
    }

    protected onEnvelope(message: unknown): void {
      const proto = Object.getPrototypeOf(IpcApiClient.prototype) as {
        onEnvelope?: (value: unknown) => void
      }
      proto.onEnvelope?.call(this, message)
    }
  }
  return new IpcApiClient()
}

function applyIpcConnection(official: OfficialExports, ctx: Context): void {
  const api = createIpcApiClient(official.AbstractApiClient)
  const rpc = createIpcConnectionRpc(official.RpcId)
  let started = false
  let description: unknown
  const listeners = new Set<() => void>()
  const publishDescription = (next: unknown): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-ipc-connection] host-description listener threw:', error)
      }
    }
  }
  ctx.provide('connection', {
    api,
    isLoopback: true,
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    },
    rpc,
    start(sinks: ConnectionSinks, config?: ConnectionConfig) {
      if (started) {
        throw new Error('connection: the stream loop is already owned by another consumer')
      }
      started = true
      const controller = new IpcConnectionController(
        api,
        {
          ...sinks,
          onConnected: (next) => {
            publishDescription(next)
            sinks.onConnected?.(next)
          },
          onStateChange: (state) => {
            if (state === 'reconnecting') publishDescription(undefined)
            sinks.onStateChange?.(state)
          }
        },
        config ?? {}
      )
      controller.start()
      return {
        stop: () => {
          controller.stop()
          publishDescription(undefined)
        }
      }
    }
  })
}

function materializeOfficialConnection(source: string): OfficialExports {
  const win = window as unknown as { __ModuleLoader__?: ModuleLoaderSink }
  const previous = win.__ModuleLoader__
  let captured: FactoryHandoff | undefined
  win.__ModuleLoader__ = {
    load: (handoff) => {
      captured = handoff
    }
  }
  try {
    ;(0, eval)(source)
  } finally {
    if (previous) win.__ModuleLoader__ = previous
    else delete win.__ModuleLoader__
  }
  if (!captured || captured.id !== DSH_CONNECTION_ID) {
    throw new Error('dsh ipc connection: official bundle did not register')
  }
  const materialized = captured.factory((spec) => {
    throw new Error(`dsh ipc connection: unexpected require ${spec}`)
  }) as OfficialExports
  if (typeof materialized.AbstractApiClient !== 'function') {
    throw new Error('dsh ipc connection: official bundle has no AbstractApiClient')
  }
  return materialized
}

export function isDshConnectionBundle(url: string): boolean {
  return url.includes(`/plugins/${DSH_CONNECTION_ID}/`)
}

export function installIpcConnectionBundle(source: string): void {
  const official = materializeOfficialConnection(source)
  const win = window as unknown as { __ModuleLoader__?: ModuleLoaderSink }
  if (win.__ModuleLoader__ === undefined) {
    throw new Error('dsh ipc connection: module loader is not installed')
  }
  win.__ModuleLoader__.load({
    id: DSH_CONNECTION_ID,
    factory: () => ({
      ...official,
      inject: official.inject ?? [],
      apply: (ctx: Context) => applyIpcConnection(official, ctx)
    })
  })
}

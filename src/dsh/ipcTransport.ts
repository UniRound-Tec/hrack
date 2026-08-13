/**
 * dsh wire 协议的 renderer 传输层（P0 形态：全局 fetch/WebSocket 包装）。
 *
 * 背景：dsh 官方浏览器客户端 WebApiClient 直接用全局 fetch 与 new WebSocket()，
 * base 推导自 location.origin（file:// 下回退到 http://dsh.internal）。
 * Electron renderer 两种 origin 都过不了 host 的信任栅栏，因此这里把发往
 * <base>/api/* 的请求拦截到 vibing 的 IPC wire 通道（主进程 loopback 直连
 * host），其余流量原样放行。
 *
 * P1 将迁移到官方预留形态：替换 dsh-client-connection 的 client bundle
 *（提供同款 ctx.connection 服务、内部使用 AbstractApiClient 子类），届时本
 * 文件随之删除。参见 .dev-shots/dsh-p0/ipc-api-client.md。
 */

import type { DshWireFetchResponse } from '../../shared/dsh-ipc'

/** dsh client 在 file:// 下推导出的固定假 base（apiproxy fetch/client.ts）。 */
const INTERNAL_SENTINEL_HOST = 'dsh.internal'
const INSTALL_FLAG = '__vibingDshIpcTransportInstalled__'

function isDshApiUrl(url: URL): boolean {
  if (!url.pathname.startsWith('/api/')) return false
  // prod（file:// → http://dsh.internal）或 dev（vite 同源）。
  return (
    url.host === INTERNAL_SENTINEL_HOST || url.host === window.location.host
  )
}

function toUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === 'string' || input instanceof URL) {
      return new URL(input, window.location.href)
    }
    return new URL(input.url)
  } catch {
    return null
  }
}

function normalizeHeaders(init: HeadersInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!init) return headers
  new Headers(init).forEach((value, key) => {
    headers[key] = value
  })
  return headers
}

function installFetchWrapper(): void {
  const originalFetch = window.fetch.bind(window)
  window.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = toUrl(input)
    if (url === null || !isDshApiUrl(url)) {
      return originalFetch(input, init)
    }
    const body = init?.body
    if (body !== undefined && body !== null && typeof body !== 'string') {
      // attachment 上传等二进制体在 P0 不支持；显式报错优于静默失败。
      throw new Error(
        'dsh wire: non-string request body is not supported over IPC yet'
      )
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
          path: url.pathname + url.search,
          headers: normalizeHeaders(init?.headers),
          body: body ?? undefined
        }),
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () =>
              reject(
                new DOMException('The operation was aborted.', 'AbortError')
              ),
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
  }) as typeof fetch
}

/**
 * 拦截 new WebSocket(<base>/api/events.*)：官方客户端的下行流。IPC 通道语义：
 * open → onopen；message(文本) → onmessage；close/error → onclose；
 * 本地 close() → 主进程关 socket（abort 传播）；send() 非法（downlink only）。
 */
function installWebSocketShim(): void {
  const NativeWebSocket = window.WebSocket

  class IpcWebSocketShim extends EventTarget {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readonly CONNECTING = 0
    readonly OPEN = 1
    readonly CLOSING = 2
    readonly CLOSED = 3

    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    readyState: number = 0
    binaryType: BinaryType = 'blob'
    readonly extensions = ''
    readonly protocol = ''
    readonly bufferedAmount = 0

    private readonly streamId = crypto.randomUUID()
    private readonly disposeListeners: Array<() => void> = []

    constructor(readonly url: string) {
      super()
      const api = window.dshWireApi
      this.disposeListeners.push(
        api.onStreamOpened((event) => {
          if (event.streamId !== this.streamId) return
          this.readyState = 1
          const domEvent = new Event('open')
          this.onopen?.(domEvent)
          this.dispatchEvent(domEvent)
        }),
        api.onStreamMessage((event) => {
          if (event.streamId !== this.streamId) return
          const domEvent = new MessageEvent('message', { data: event.data })
          this.onmessage?.(domEvent)
          this.dispatchEvent(domEvent)
        }),
        api.onStreamClosed((event) => {
          if (event.streamId !== this.streamId) return
          this.readyState = 3
          this.teardown()
          const domEvent = new CloseEvent('close', {
            code: event.code ?? 1006,
            reason: event.reason ?? event.error ?? ''
          })
          this.onclose?.(domEvent)
          this.dispatchEvent(domEvent)
        })
      )
      api.openStream({
        streamId: this.streamId,
        path: new URL(this.url).pathname + new URL(this.url).search
      }).catch((error: unknown) => {
        this.readyState = 3
        this.teardown()
        this.onerror?.(new Event('error'))
        const domEvent = new CloseEvent('close', {
          code: 1006,
          reason: error instanceof Error ? error.message : String(error)
        })
        this.onclose?.(domEvent)
        this.dispatchEvent(domEvent)
      })
    }

    private teardown(): void {
      for (const dispose of this.disposeListeners.splice(0)) dispose()
    }

    send(): never {
      throw new Error('dsh wire: downlink stream is read-only')
    }

    close(code?: number, reason?: string): void {
      if (this.readyState >= 2) return
      this.readyState = 2
      void code
      void reason
      const api = window.dshWireApi
      const { streamId } = this
      this.readyState = 3
      this.teardown()
      void api.closeStream(streamId)
      const domEvent = new CloseEvent('close', { code: 1000 })
      this.onclose?.(domEvent)
      this.dispatchEvent(domEvent)
    }
  }

  // 非 dsh 目标（如 vite HMR）透传原生实现：构造函数返回原生实例。
  const WrappedWebSocket = function (
    this: unknown,
    url: string | URL,
    protocols?: string | string[]
  ): WebSocket {
    const parsed = new URL(String(url), window.location.href)
    if (isDshApiUrl(parsed)) {
      return new IpcWebSocketShim(
        String(url)
      ) as unknown as WebSocket
    }
    return new NativeWebSocket(url, protocols)
  } as unknown as typeof WebSocket
  Object.assign(WrappedWebSocket, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3
  })
  window.WebSocket = WrappedWebSocket
}

let installed = false

/** 幂等；必须在任何 dsh client bundle 执行前安装。 */
export function installDshIpcTransport(): void {
  const flagged = globalThis as Record<string, unknown>
  if (installed || flagged[INSTALL_FLAG] === true) return
  installed = true
  flagged[INSTALL_FLAG] = true
  installFetchWrapper()
  installWebSocketShim()
}

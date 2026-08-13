import type {
  DshWireFetchRequest,
  DshWireFetchResponse,
  DshWireStreamOpenRequest
} from '../../shared/dsh-ipc'
import { DshEventChannel } from '../../shared/dsh-ipc'
import type { DshHostManager } from './DshHostManager'

/**
 * DshWireProxy —— dsh wire 协议的主进程转发器。
 *
 * 为什么需要它（P0 调研结论，见 PLAN-DSH-INTEGRATION §2）：dsh host 的信任
 * 栅栏要求 Host 为 loopback 且 Origin（若存在）必须与 Host 一致；Electron
 * renderer 在 prod 是 file://（Origin: null 必被拒）、dev 是 vite origin——
 * 两种形态都不能直连。官方预留的载体替换点就是把传输换成 Electron IPC：
 * renderer 里的 IpcApiClient 走本代理，主进程以 Node fetch/WebSocket
 * （无 Origin 头、Host 为 127.0.0.1）直连 host，天然过栅栏。
 *
 * 协议事实（packages/host/apiproxy 与 packages/client/connection）：
 * - 上行仅 POST /api/<method> 与 /api/respond，content-type: application/json；
 *   业务错误也返回 200 + ServerResponse 信封，所以这里原样透传 status/body。
 * - 下行是 /api/events.mux 与 /api/events.host 的 WebSocket，纯文本 JSON 帧；
 *   WS 上客户端发数据会被 host 以 1008 关闭（downlink only），故不提供发送。
 * - 无应用层心跳：liveness 由 close 事件驱动，close 必须传播给 renderer。
 */

// /api/* 是 wire 协议；/plugins/*/client.js 是 host serve 的 client bundle
//（renderer 的 loadBundle 经此取回，保证与 host 版本严格一致）。
const PATH_PATTERN = /^\/(api|plugins)\/[A-Za-z0-9._~@/-]+(\?[A-Za-z0-9._~=&%/-]*)?$/
const MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_STREAMS = 16

function decodeWireBody(
  body: string | undefined,
  encoding: 'utf8' | 'base64' | undefined
): string | Uint8Array | undefined {
  if (body === undefined) return undefined
  if (encoding !== 'base64') return body
  return Buffer.from(body, 'base64')
}

export class DshWireProxy {
  private readonly pendingFetches = new Map<string, AbortController>()
  private readonly streams = new Map<string, WebSocket>()

  constructor(
    private readonly host: DshHostManager,
    private readonly broadcast: (channel: string, payload: unknown) => void
  ) {}

  private requireBaseUrl(): string {
    const status = this.host.getStatus()
    if (status.state !== 'ready' || !status.baseUrl) {
      throw new Error('dsh host is not ready')
    }
    return status.baseUrl
  }

  async handleFetch(request: DshWireFetchRequest): Promise<DshWireFetchResponse> {
    const baseUrl = this.requireBaseUrl()
    if (
      typeof request.requestId !== 'string' ||
      request.requestId.length === 0 ||
      request.requestId.length > 128 ||
      typeof request.path !== 'string' ||
      !PATH_PATTERN.test(request.path) ||
      (request.method !== 'GET' && request.method !== 'POST') ||
      (request.body !== undefined &&
        (typeof request.body !== 'string' ||
          request.body.length > MAX_BODY_BYTES)) ||
      (request.bodyEncoding !== undefined &&
        request.bodyEncoding !== 'utf8' &&
        request.bodyEncoding !== 'base64')
    ) {
      throw new Error('invalid dsh wire fetch request')
    }
    const controller = new AbortController()
    this.pendingFetches.set(request.requestId, controller)
    try {
      const response = await fetch(baseUrl + request.path, {
        method: request.method,
        headers: request.headers ?? {},
        body: decodeWireBody(request.body, request.bodyEncoding),
        signal: controller.signal
      })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key] = value
      })
      return {
        status: response.status,
        headers,
        body: await response.text()
      }
    } finally {
      this.pendingFetches.delete(request.requestId)
    }
  }

  abortFetch(requestId: string): void {
    this.pendingFetches.get(requestId)?.abort()
  }

  /** 抓取 host index.html 并提取注入的 window.__DSH_BOOT__（JSON）。 */
  async getBootManifest(): Promise<unknown> {
    const baseUrl = this.requireBaseUrl()
    const response = await fetch(baseUrl + '/', {
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) {
      throw new Error(`dsh host index responded ${response.status}`)
    }
    const html = await response.text()
    const marker = 'window.__DSH_BOOT__ = '
    const at = html.indexOf(marker)
    if (at === -1) throw new Error('dsh host index carries no __DSH_BOOT__')
    const end = html.indexOf('</script>', at)
    if (end === -1) throw new Error('dsh host index __DSH_BOOT__ is unterminated')
    return JSON.parse(html.slice(at + marker.length, end))
  }

  openStream(request: DshWireStreamOpenRequest): void {
    const baseUrl = this.requireBaseUrl()
    if (
      typeof request.streamId !== 'string' ||
      request.streamId.length === 0 ||
      request.streamId.length > 128 ||
      !PATH_PATTERN.test(request.path) ||
      this.streams.has(request.streamId) ||
      this.streams.size >= MAX_STREAMS
    ) {
      throw new Error('invalid dsh wire stream request')
    }
    const url = baseUrl.replace(/^http/, 'ws') + request.path
    const socket = new WebSocket(url)
    this.streams.set(request.streamId, socket)
    const { streamId } = request
    socket.onopen = () => {
      this.broadcast(DshEventChannel.WireStreamOpened, { streamId })
    }
    socket.onmessage = (event) => {
      // host 只发文本帧；二进制按协议视为非法，直接断开让对端重连。
      if (typeof event.data !== 'string') {
        socket.close(1003, 'unsupported data')
        return
      }
      this.broadcast(DshEventChannel.WireStreamMessage, {
        streamId,
        data: event.data
      })
    }
    socket.onerror = () => {
      // error 后必跟 close；统一在 close 里清理与通知。
    }
    socket.onclose = (event) => {
      this.streams.delete(streamId)
      this.broadcast(DshEventChannel.WireStreamClosed, {
        streamId,
        code: event.code,
        reason: event.reason
      })
    }
  }

  closeStream(streamId: string): void {
    const socket = this.streams.get(streamId)
    if (!socket) return
    this.streams.delete(streamId)
    try {
      socket.close()
    } catch {
      /* already closed */
    }
  }

  dispose(): void {
    for (const controller of this.pendingFetches.values()) controller.abort()
    this.pendingFetches.clear()
    for (const [streamId] of this.streams) this.closeStream(streamId)
  }
}

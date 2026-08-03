import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

const MAX_BODY_BYTES = 1024 * 1024
const MAX_ROUTE_ITEMS = 512
const MAX_ROUTE_BYTES = 4 * 1024 * 1024

export interface HookRoute {
  readonly url: string
  subscribe(listener: (payload: unknown) => void): () => void
  dispose(): Promise<void>
}

interface QueuedPayload {
  value: unknown
  bytes: number
}

interface RouteState {
  sessionId: string
  adapterId: string
  token: string
  listeners: Set<(payload: unknown) => void>
  queue: QueuedPayload[]
  queuedBytes: number
  drainScheduled: boolean
  overflowReported: boolean
  closed: boolean
}

function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function respond(response: ServerResponse, status: number): void {
  response.statusCode = status
  response.setHeader('Cache-Control', 'no-store')
  response.end()
}

function isTerminalHook(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const name = (payload as Record<string, unknown>).hook_event_name
  return [
    'PostToolUse',
    'PostToolUseFailure',
    'Stop',
    'StopFailure',
    'SessionEnd'
  ].includes(String(name))
}

/** App 级 loopback Hook 入口；所有 Session 共享一个随机端口。 */
export class HookIngress {
  private readonly baseToken = randomBytes(16).toString('hex')
  private readonly routes = new Map<string, RouteState>()
  private server: Server | null = null
  private port = 0
  private starting: Promise<void> | null = null
  private disposed = false

  async register(sessionId: string, adapterId: string): Promise<HookRoute> {
    if (this.disposed) throw new Error('Hook ingress is disposed')
    await this.ensureStarted()
    const token = randomBytes(24).toString('hex')
    const state: RouteState = {
      sessionId,
      adapterId,
      token,
      listeners: new Set(),
      queue: [],
      queuedBytes: 0,
      drainScheduled: false,
      overflowReported: false,
      closed: false
    }
    this.routes.set(token, state)
    const url = `http://127.0.0.1:${this.port}/v1/${encodeURIComponent(adapterId)}/${this.baseToken}/${token}`
    return {
      url,
      subscribe: (listener) => {
        if (state.closed) return () => {}
        state.listeners.add(listener)
        this.scheduleDrain(state)
        return () => state.listeners.delete(listener)
      },
      dispose: async () => {
        if (state.closed) return
        state.closed = true
        state.listeners.clear()
        state.queue = []
        state.queuedBytes = 0
        this.routes.delete(token)
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const route of this.routes.values()) {
      route.closed = true
      route.listeners.clear()
      route.queue = []
    }
    this.routes.clear()
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private ensureStarted(): Promise<void> {
    if (this.server && this.port > 0) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request, response)
      })
      const fail = (error: Error): void => {
        server.close()
        this.server = null
        this.starting = null
        reject(error)
      }
      server.once('error', fail)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', fail)
        server.on('error', (error) => {
          console.error('[hook-ingress] server error:', error)
        })
        const address = server.address()
        if (!address || typeof address === 'string') {
          fail(new Error('Hook ingress did not bind a TCP port'))
          return
        }
        this.server = server
        this.port = address.port
        this.starting = null
        resolve()
      })
    })
    return this.starting
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (request.method !== 'POST') {
      respond(response, 405)
      return
    }
    const contentType = String(request.headers['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      respond(response, 415)
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean)
    if (
      parts.length !== 4 ||
      parts[0] !== 'v1' ||
      !safeEqual(parts[2] ?? '', this.baseToken)
    ) {
      respond(response, 404)
      return
    }
    const route = this.routes.get(parts[3] ?? '')
    if (
      !route ||
      route.closed ||
      !safeEqual(parts[1] ?? '', encodeURIComponent(route.adapterId)) ||
      !safeEqual(parts[3] ?? '', route.token)
    ) {
      respond(response, 404)
      return
    }
    const declared = Number(request.headers['content-length'] ?? 0)
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      request.resume()
      respond(response, 413)
      return
    }

    const chunks: Buffer[] = []
    let bytes = 0
    try {
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > MAX_BODY_BYTES) {
          respond(response, 413)
          return
        }
        chunks.push(buffer)
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      this.enqueue(route, { value: payload, bytes })
      // 入有界内存队列后立即确认，不等待 parser/projector/IPC。
      respond(response, 204)
    } catch {
      respond(response, 400)
    }
  }

  private enqueue(route: RouteState, incoming: QueuedPayload): void {
    while (
      route.queue.length >= MAX_ROUTE_ITEMS ||
      route.queuedBytes + incoming.bytes > MAX_ROUTE_BYTES
    ) {
      const removable = route.queue.findIndex((item) => !isTerminalHook(item.value))
      if (removable < 0) break
      const [removed] = route.queue.splice(removable, 1)
      route.queuedBytes -= removed.bytes
    }
    if (
      route.queue.length >= MAX_ROUTE_ITEMS ||
      route.queuedBytes + incoming.bytes > MAX_ROUTE_BYTES
    ) {
      if (!route.overflowReported) {
        route.overflowReported = true
        route.queue.push({ value: { __vibing_degraded: 'hook-queue-overflow' }, bytes: 64 })
        route.queuedBytes += 64
      }
      return
    }
    route.queue.push(incoming)
    route.queuedBytes += incoming.bytes
    this.scheduleDrain(route)
  }

  private scheduleDrain(route: RouteState): void {
    if (route.drainScheduled || route.closed || route.listeners.size === 0) return
    route.drainScheduled = true
    queueMicrotask(() => {
      route.drainScheduled = false
      if (route.closed || route.listeners.size === 0) return
      const batch = route.queue.splice(0, route.queue.length)
      route.queuedBytes = 0
      for (const item of batch) {
        for (const listener of route.listeners) {
          try {
            listener(item.value)
          } catch (error) {
            console.error('[hook-ingress] route listener failed:', error)
          }
        }
      }
    })
  }
}

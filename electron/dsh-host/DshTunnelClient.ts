import { request, type ClientRequest, type IncomingMessage } from 'node:http'
import WebSocket, { type RawData } from 'ws'
import type { DshHostManager } from './DshHostManager'
import {
  DSH_TUNNEL_LIMITS,
  encodeDshTunnelBinary,
  encodeDshTunnelControl,
  normalizeDshWebSocketCloseCode,
  parseDshTunnelBinary,
  parseDshTunnelControl,
  type DshTunnelControl,
  type DshTunnelHeaders
} from '../../shared/dsh-tunnel-protocol'

export interface DshTunnelLease {
  tunnelUrl: string
  roomId: string
  seatToken: string
  publicOrigin: string
}

export type DshTunnelClientState = 'stopped' | 'connecting' | 'open' | 'closed'

interface FlowState {
  credit: number
  sequence: number
  queue: Buffer[]
  queuedBytes: number
  endPending: boolean
}

interface HttpStream {
  kind: 'http'
  id: number
  request: ClientRequest
  response: IncomingMessage | null
  requestSequence: number
  requestCredit: number
  requestBytes: number
  requestCreditPending: number
  responseBytes: number
  requestExpectedBytes: number | null
  sse: boolean
  flow: FlowState
  requestEnded: boolean
}

interface WsStream {
  kind: 'ws'
  id: number
  socket: WebSocket
  flow: FlowState
}

type Stream = HttpStream | WsStream

const REQUEST_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-type',
  'if-modified-since',
  'if-none-match',
  'range'
])

const RESPONSE_HEADER_ALLOWLIST = new Set([
  'accept-ranges',
  'cache-control',
  'content-encoding',
  'content-length',
  'content-range',
  'content-security-policy',
  'content-type',
  'etag',
  'last-modified',
  'location',
  'referrer-policy',
  'vary',
  'x-content-type-options'
])

function isSafeRelativePath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\0\r\n]/.test(path)) return false
  let parsed: URL
  try {
    parsed = new URL(path, 'https://dsh.invalid')
  } catch {
    return false
  }
  if (parsed.origin !== 'https://dsh.invalid' || parsed.hash) return false
  let decoded = parsed.pathname
  for (let pass = 0; pass < 2; pass++) {
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      return false
    }
    if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) return false
  }
  return true
}

export function isAllowedDshHttpRoute(method: string, path: string): boolean {
  if (!isSafeRelativePath(path)) return false
  const pathname = new URL(path, 'https://dsh.invalid').pathname
  if (method === 'POST') return pathname.startsWith('/api/')
  if (method !== 'GET' && method !== 'HEAD') return false
  if (pathname === '/') return method === 'GET'
  if (pathname === '/plugins/events') return method === 'GET'
  return (
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/plugins/') ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/favicon.svg'
  )
}

export function isAllowedDshWebSocketRoute(path: string): boolean {
  if (!isSafeRelativePath(path)) return false
  const pathname = new URL(path, 'https://dsh.invalid').pathname
  return pathname === '/api/events.mux' || pathname === '/api/events.host'
}

function requestHeaders(
  publicOrigin: string,
  headers: DshTunnelHeaders,
  includeOrigin: boolean
): Record<string, string> | null {
  const output: Record<string, string> = { host: new URL(publicOrigin).host }
  for (const [name, value] of headers) {
    if (name === 'origin') {
      if (value !== publicOrigin) return null
      continue
    }
    if (REQUEST_HEADER_ALLOWLIST.has(name)) output[name] = value
  }
  if (includeOrigin || headers.some(([name]) => name === 'origin')) {
    output.origin = publicOrigin
  }
  return output
}

function responseHeaders(
  publicOrigin: string,
  response: IncomingMessage
): DshTunnelHeaders | null {
  const output: DshTunnelHeaders = []
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index]?.toLowerCase()
    const value = response.rawHeaders[index + 1]
    if (!name || value === undefined || !RESPONSE_HEADER_ALLOWLIST.has(name)) continue
    if (name === 'location') {
      let target: URL
      try {
        target = new URL(value, publicOrigin)
      } catch {
        return null
      }
      if (target.origin !== publicOrigin) return null
    }
    output.push([name, value])
  }
  return output
}

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  throw new Error('unsupported WebSocket payload')
}

/**
 * One independent tunnel socket. Every local connection is derived from the
 * current ready DshHostManager state; no remote frame can choose a host/port.
 */
export class DshTunnelClient {
  private socket: WebSocket | null = null
  private lease: DshTunnelLease | null = null
  private stopped = true
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0
  private readonly streams = new Map<number, Stream>()
  private readonly usedStreamIds = new Set<number>()
  private drainTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly host: Pick<DshHostManager, 'getStatus'>,
    private readonly onState?: (state: DshTunnelClientState) => void
  ) {}

  start(lease: DshTunnelLease): void {
    this.stop()
    this.lease = { ...lease }
    this.stopped = false
    this.retryAttempt = 0
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.lease = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.drainTimer) clearTimeout(this.drainTimer)
    this.drainTimer = null
    this.closeStreams()
    const socket = this.socket
    this.socket = null
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      socket.close(1000, 'stopped')
    }
    this.onState?.('stopped')
  }

  private connect(): void {
    const lease = this.lease
    if (this.stopped || !lease) return
    this.usedStreamIds.clear()
    this.onState?.('connecting')
    const socket = new WebSocket(lease.tunnelUrl, {
      handshakeTimeout: 10_000,
      maxPayload: DSH_TUNNEL_LIMITS.controlBytes + DSH_TUNNEL_LIMITS.framePayloadBytes + 10,
      perMessageDeflate: false
    })
    this.socket = socket
    socket.binaryType = 'nodebuffer'
    socket.once('open', () => {
      if (this.socket !== socket || !this.lease) return
      socket.send(encodeDshTunnelControl({
        type: 'dsh-tunnel-hello',
        roomId: this.lease.roomId,
        dshSeatToken: this.lease.seatToken,
        protocol: 1
      }))
      this.retryAttempt = 0
      this.onState?.('open')
    })
    socket.on('message', (data, isBinary) => {
      if (this.socket !== socket) return
      if (isBinary) this.onBinary(asBuffer(data))
      else this.onControl(asBuffer(data).toString('utf8'))
    })
    socket.once('error', (error) => {
      // Never log the lease or request details; close drives bounded retry.
      console.warn('[dsh-tunnel] socket error:', error.message)
    })
    socket.once('close', (code) => {
      if (this.socket !== socket) return
      console.warn('[dsh-tunnel] socket closed:', code)
      this.socket = null
      this.closeStreams()
      this.onState?.('closed')
      if (this.stopped || !this.lease) return
      const delay = Math.min(10_000, 250 * 2 ** Math.min(this.retryAttempt++, 6))
      console.log('[dsh-tunnel] reconnect scheduled in', delay, 'ms')
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        this.connect()
      }, delay)
    })
  }

  private onControl(text: string): void {
    const parsed = parseDshTunnelControl(text)
    if (!parsed.ok || parsed.value.type === 'dsh-tunnel-hello') {
      this.protocolError()
      return
    }
    const message = parsed.value
    switch (message.type) {
      case 'ping':
        this.sendControl({ type: 'pong' })
        return
      case 'pong':
        return
      case 'http-open':
        this.openHttp(message)
        return
      case 'http-end':
        this.endHttpRequest(message.streamId)
        return
      case 'http-abort':
        this.abortStream(message.streamId)
        return
      case 'ws-open':
        this.openWebSocket(message)
        return
      case 'ws-close':
        this.closeWebSocket(message.streamId, message.code, message.reason)
        return
      case 'credit':
        this.addCredit(message.streamId, message.bytes)
        return
      default:
        // Gateway must not send response-side controls to Desktop.
        this.protocolError()
    }
  }

  private onBinary(data: Buffer): void {
    const parsed = parseDshTunnelBinary(data)
    if (!parsed.ok || parsed.value.kind !== 1) {
      this.protocolError()
      return
    }
    const frame = parsed.value
    const stream = this.streams.get(frame.streamId)
    // Stream ids are never reused within one tunnel generation. A peer may
    // already have queued data when the public HTTP client closes and the
    // gateway tears the stream down, so a frame for a known tombstone is a
    // harmless late delivery rather than a tunnel-wide protocol failure.
    if (!stream && this.usedStreamIds.has(frame.streamId)) return
    if (!stream || stream.kind !== 'http' || stream.requestEnded) {
      this.protocolError()
      return
    }
    if (
      frame.sequence !== stream.requestSequence ||
      frame.payload.byteLength > stream.requestCredit ||
      (
        stream.requestExpectedBytes !== null &&
        stream.requestBytes + frame.payload.byteLength >
          stream.requestExpectedBytes
      )
    ) {
      this.protocolError()
      return
    }
    stream.requestSequence += 1
    stream.requestCredit -= frame.payload.byteLength
    stream.requestBytes += frame.payload.byteLength
    if (stream.requestBytes > DSH_TUNNEL_LIMITS.requestBodyBytes) {
      this.sendControl({ type: 'http-abort', streamId: stream.id, reason: 'request-too-large' })
      this.abortStream(stream.id)
      return
    }
    const accepted = stream.request.write(frame.payload)
    stream.requestCreditPending += frame.payload.byteLength
    if (accepted) this.replenishRequestCredit(stream)
    else stream.request.once('drain', () => this.replenishRequestCredit(stream))
  }

  private openHttp(message: Extract<DshTunnelControl, { type: 'http-open' }>): void {
    const lease = this.lease
    const status = this.host.getStatus()
    const httpCount = [...this.streams.values()].filter((stream) => stream.kind === 'http').length
    const sseCount = [...this.streams.values()].filter((stream) => stream.kind === 'http' && stream.sse).length
    const sse = new URL(message.path, lease?.publicOrigin ?? 'https://dsh.invalid').pathname === '/plugins/events'
    if (this.usedStreamIds.has(message.streamId)) {
      this.protocolError()
      return
    }
    this.usedStreamIds.add(message.streamId)
    if (
      !lease || status.state !== 'ready' || !status.baseUrl ||
      httpCount >= DSH_TUNNEL_LIMITS.concurrentHttp ||
      (sse && sseCount >= DSH_TUNNEL_LIMITS.concurrentSse) ||
      !isAllowedDshHttpRoute(message.method, message.path)
    ) {
      this.sendControl({ type: 'http-abort', streamId: message.streamId, reason: 'rejected' })
      return
    }
    const headers = requestHeaders(lease.publicOrigin, message.headers, message.method === 'POST')
    if (!headers) {
      this.sendControl({ type: 'http-abort', streamId: message.streamId, reason: 'invalid-origin' })
      return
    }
    const local = new URL(status.baseUrl)
    const req = request({
      hostname: local.hostname,
      port: local.port,
      method: message.method,
      path: message.path,
      headers
    })
    const stream: HttpStream = {
      kind: 'http', id: message.streamId, request: req, response: null,
      requestSequence: 0, requestCredit: DSH_TUNNEL_LIMITS.initialCreditBytes,
      requestBytes: 0, requestCreditPending: 0, responseBytes: 0,
      requestExpectedBytes: message.bodyLength ?? null, sse,
      flow: { credit: DSH_TUNNEL_LIMITS.initialCreditBytes, sequence: 0, queue: [], queuedBytes: 0, endPending: false },
      requestEnded: false
    }
    this.streams.set(stream.id, stream)
    this.sendControl({ type: 'credit', streamId: stream.id, bytes: DSH_TUNNEL_LIMITS.initialCreditBytes })
    req.once('response', (response) => this.onHttpResponse(stream, response))
    req.once('error', () => {
      if (this.streams.get(stream.id) !== stream) return
      this.sendControl({ type: 'http-abort', streamId: stream.id, reason: 'local-request-failed' })
      this.dropStream(stream.id)
    })
    req.setTimeout(10_000, () => req.destroy(new Error('local request timeout')))
  }

  private endHttpRequest(streamId: number): void {
    const stream = this.streams.get(streamId)
    if (!stream && this.usedStreamIds.has(streamId)) return
    if (!stream || stream.kind !== 'http' || stream.requestEnded) {
      this.protocolError()
      return
    }
    if (
      stream.requestExpectedBytes !== null &&
      stream.requestBytes !== stream.requestExpectedBytes
    ) {
      this.protocolError()
      return
    }
    stream.requestEnded = true
    stream.request.end()
  }

  private onHttpResponse(stream: HttpStream, response: IncomingMessage): void {
    if (this.streams.get(stream.id) !== stream || !this.lease) {
      response.destroy()
      return
    }
    stream.response = response
    response.setTimeout(stream.sse ? 90_000 : 60_000, () => {
      response.destroy(new Error('local response timeout'))
    })
    const headers = responseHeaders(this.lease.publicOrigin, response)
    if (!headers) {
      this.sendControl({ type: 'http-abort', streamId: stream.id, reason: 'invalid-response' })
      this.dropStream(stream.id)
      return
    }
    this.sendControl({ type: 'http-head', streamId: stream.id, status: response.statusCode ?? 502, headers })
    response.on('data', (chunk: Buffer) => {
      if (this.streams.get(stream.id) !== stream) return
      stream.responseBytes += chunk.byteLength
      if (!stream.sse && stream.responseBytes > DSH_TUNNEL_LIMITS.responseBodyBytes) {
        this.sendControl({ type: 'http-abort', streamId: stream.id, reason: 'response-too-large' })
        this.dropStream(stream.id)
        return
      }
      response.pause()
      this.enqueue(stream, Buffer.from(chunk))
      this.drain(stream)
    })
    response.once('end', () => {
      if (this.streams.get(stream.id) !== stream) return
      stream.flow.endPending = true
      this.drain(stream)
    })
    response.once('error', () => {
      if (this.streams.get(stream.id) !== stream) return
      this.sendControl({ type: 'http-abort', streamId: stream.id, reason: 'local-response-failed' })
      this.dropStream(stream.id)
    })
  }

  private openWebSocket(message: Extract<DshTunnelControl, { type: 'ws-open' }>): void {
    const lease = this.lease
    const status = this.host.getStatus()
    const wsCount = [...this.streams.values()].filter((stream) => stream.kind === 'ws').length
    if (this.usedStreamIds.has(message.streamId)) {
      this.protocolError()
      return
    }
    this.usedStreamIds.add(message.streamId)
    if (!lease || status.state !== 'ready' || !status.baseUrl || wsCount >= DSH_TUNNEL_LIMITS.concurrentWebSocket || !isAllowedDshWebSocketRoute(message.path)) {
      this.sendControl({ type: 'ws-open-reject', streamId: message.streamId, status: 403 })
      return
    }
    const headers = requestHeaders(lease.publicOrigin, message.headers, true)
    if (!headers) {
      this.sendControl({ type: 'ws-open-reject', streamId: message.streamId, status: 403 })
      return
    }
    const local = new URL(status.baseUrl)
    const socket = new WebSocket(`ws://${local.host}${message.path}`, {
      origin: lease.publicOrigin,
      headers,
      handshakeTimeout: 10_000,
      perMessageDeflate: false
    })
    const stream: WsStream = {
      kind: 'ws', id: message.streamId, socket,
      flow: { credit: DSH_TUNNEL_LIMITS.initialCreditBytes, sequence: 0, queue: [], queuedBytes: 0, endPending: false }
    }
    this.streams.set(stream.id, stream)
    socket.once('open', () => {
      if (this.streams.get(stream.id) !== stream) return
      this.sendControl({ type: 'ws-open-ok', streamId: stream.id, ...(socket.protocol ? { protocol: socket.protocol } : {}) })
    })
    socket.on('message', (data, isBinary) => {
      if (this.streams.get(stream.id) !== stream) return
      if (isBinary) {
        socket.close(1003, 'binary event frames are unsupported')
        return
      }
      this.enqueue(stream, asBuffer(data))
      this.drain(stream)
    })
    socket.once('unexpected-response', (_request, response) => {
      this.sendControl({ type: 'ws-open-reject', streamId: stream.id, status: response.statusCode ?? 502 })
      this.dropStream(stream.id)
    })
    socket.once('error', () => {
      if (this.streams.get(stream.id) !== stream) return
      this.sendControl({ type: 'ws-open-reject', streamId: stream.id, status: 502 })
      this.dropStream(stream.id)
    })
    socket.once('close', (code, reason) => {
      if (this.streams.get(stream.id) !== stream) return
      this.sendControl({ type: 'ws-close', streamId: stream.id, code: normalizeDshWebSocketCloseCode(code), ...(reason.byteLength ? { reason: reason.toString('utf8').slice(0, 123) } : {}) })
      this.dropStream(stream.id)
    })
  }

  private enqueue(stream: Stream, payload: Buffer): void {
    const roomQueuedBytes = [...this.streams.values()].reduce(
      (total, value) => total + value.flow.queuedBytes,
      0
    )
    if (
      stream.flow.queuedBytes + payload.byteLength > DSH_TUNNEL_LIMITS.streamBufferBytes ||
      roomQueuedBytes + payload.byteLength > DSH_TUNNEL_LIMITS.roomBufferBytes
    ) {
      if (stream.kind === 'http') {
        this.sendControl({ type: 'http-abort', streamId: stream.id, reason: 'buffer-limit' })
      } else {
        this.sendControl({ type: 'ws-close', streamId: stream.id, code: 1013, reason: 'buffer-limit' })
      }
      this.dropStream(stream.id)
      return
    }
    stream.flow.queue.push(payload)
    stream.flow.queuedBytes += payload.byteLength
  }

  private drain(stream: Stream): void {
    if (this.streams.get(stream.id) !== stream) return
    while (stream.flow.credit > 0 && stream.flow.queue.length > 0) {
      const first = stream.flow.queue[0]!
      const length = Math.min(first.byteLength, stream.flow.credit, DSH_TUNNEL_LIMITS.framePayloadBytes)
      const tunnel = this.socket
      if (
        !tunnel ||
        tunnel.readyState !== WebSocket.OPEN ||
        tunnel.bufferedAmount + length > DSH_TUNNEL_LIMITS.roomBufferBytes
      ) {
        this.scheduleDrain()
        return
      }
      const payload = first.subarray(0, length)
      this.sendBinary(stream.kind === 'http' ? 1 : 2, stream.id, stream.flow.sequence++, payload)
      stream.flow.credit -= length
      stream.flow.queuedBytes -= length
      if (length === first.byteLength) stream.flow.queue.shift()
      else stream.flow.queue[0] = first.subarray(length)
    }
    if (stream.flow.queue.length === 0) {
      if (stream.kind === 'http') stream.response?.resume()
      if (stream.flow.endPending && stream.kind === 'http') {
        this.sendControl({ type: 'http-end', streamId: stream.id })
        this.dropStream(stream.id)
      }
    }
  }

  private scheduleDrain(): void {
    if (this.drainTimer || this.stopped) return
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      for (const stream of this.streams.values()) this.drain(stream)
    }, 10)
  }

  private addCredit(streamId: number, bytes: number): void {
    const stream = this.streams.get(streamId)
    // The final body frame and http-end share one ordered outbound queue, but
    // its credit travels in the reverse direction and can arrive in TIME_WAIT.
    if (!stream && this.usedStreamIds.has(streamId)) return
    if (!stream || stream.flow.credit + bytes > DSH_TUNNEL_LIMITS.streamBufferBytes) {
      this.protocolError()
      return
    }
    stream.flow.credit += bytes
    this.drain(stream)
  }

  private replenishRequestCredit(stream: HttpStream): void {
    if (this.streams.get(stream.id) !== stream || stream.requestCreditPending === 0) return
    const bytes = stream.requestCreditPending
    stream.requestCreditPending = 0
    stream.requestCredit += bytes
    this.sendControl({ type: 'credit', streamId: stream.id, bytes })
  }

  private closeWebSocket(streamId: number, code: number, reason?: string): void {
    const stream = this.streams.get(streamId)
    if (!stream && this.usedStreamIds.has(streamId)) return
    if (!stream || stream.kind !== 'ws') {
      this.protocolError()
      return
    }
    stream.socket.close(normalizeDshWebSocketCloseCode(code), reason)
  }

  private abortStream(streamId: number): void {
    const stream = this.streams.get(streamId)
    if (!stream && this.usedStreamIds.has(streamId)) return
    if (!stream) {
      this.protocolError()
      return
    }
    this.dropStream(streamId)
  }

  private dropStream(streamId: number): void {
    const stream = this.streams.get(streamId)
    if (!stream) return
    this.streams.delete(streamId)
    if (stream.kind === 'http') {
      stream.request.destroy()
      stream.response?.destroy()
    } else if (stream.socket.readyState === WebSocket.CONNECTING || stream.socket.readyState === WebSocket.OPEN) {
      stream.socket.close(1001, 'stream-closed')
    }
  }

  private closeStreams(): void {
    for (const id of [...this.streams.keys()]) this.dropStream(id)
  }

  private sendControl(message: DshTunnelControl): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encodeDshTunnelControl(message))
  }

  private sendBinary(kind: 1 | 2, streamId: number, sequence: number, payload: Buffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encodeDshTunnelBinary({ kind, streamId, sequence, payload }))
    }
  }

  private protocolError(): void {
    const socket = this.socket
    if (!socket || socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
      return
    }
    // Keep the socket identity until its close event so the normal bounded
    // reconnect path runs. Clearing it here made protocol failures permanent.
    socket?.close(1002, 'protocol-error')
  }
}

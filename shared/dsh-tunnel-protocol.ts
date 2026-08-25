export const DSH_TUNNEL_PROTOCOL = 1 as const

export const DSH_TUNNEL_LIMITS = {
  controlBytes: 32 * 1024,
  framePayloadBytes: 64 * 1024,
  initialCreditBytes: 256 * 1024,
  streamBufferBytes: 512 * 1024,
  roomBufferBytes: 2 * 1024 * 1024,
  requestBodyBytes: 16 * 1024 * 1024,
  responseBodyBytes: 32 * 1024 * 1024,
  headersBytes: 32 * 1024,
  headerValueBytes: 8 * 1024,
  headerCount: 64,
  // The official DSH boot graph currently fans out across 40+ plugin bundles.
  // Keep the byte budgets unchanged, but allow one complete browser boot wave.
  concurrentHttp: 64,
  concurrentSse: 1,
  concurrentWebSocket: 2
} as const

export type DshTunnelHeaders = Array<[name: string, value: string]>

export type DshTunnelControl =
  | {
      type: 'dsh-tunnel-hello'
      roomId: string
      dshSeatToken: string
      protocol: 1
    }
  | {
      type: 'http-open'
      streamId: number
      method: string
      path: string
      headers: DshTunnelHeaders
      bodyLength?: number
    }
  | { type: 'http-head'; streamId: number; status: number; headers: DshTunnelHeaders }
  | { type: 'http-end'; streamId: number }
  | { type: 'http-abort'; streamId: number; reason: string }
  | { type: 'ws-open'; streamId: number; path: string; headers: DshTunnelHeaders }
  | { type: 'ws-open-ok'; streamId: number; protocol?: string }
  | { type: 'ws-open-reject'; streamId: number; status: number }
  | { type: 'ws-close'; streamId: number; code: number; reason?: string }
  | { type: 'credit'; streamId: number; bytes: number }
  | { type: 'ping' }
  | { type: 'pong' }

export type DshTunnelBinaryKind = 1 | 2 | 3

export interface DshTunnelBinaryFrame {
  kind: DshTunnelBinaryKind
  streamId: number
  sequence: number
  payload: Uint8Array
}

/** RFC 6455 codes accepted by WebSocket#close; 1005/1006/1015 are wire-only. */
export function isDshWebSocketCloseCode(code: unknown): code is number {
  return (
    typeof code === 'number' &&
    Number.isInteger(code) &&
    ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
      (code >= 3000 && code <= 4999))
  )
}

export function normalizeDshWebSocketCloseCode(code: number): number {
  return isDshWebSocketCloseCode(code) ? code : 1001
}

export type DshTunnelParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string }

function fail(reason: string): DshTunnelParseResult<never> {
  return { ok: false, reason }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = new Set(allowed)
  return Object.keys(raw).every((key) => expected.has(key))
}

function streamId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 0xffff_ffff
}

function uint32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && utf8Bytes(value) <= max && !value.includes('\0')
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function parseHeaders(value: unknown): DshTunnelHeaders | null {
  if (!Array.isArray(value) || value.length > DSH_TUNNEL_LIMITS.headerCount) return null
  const headers: DshTunnelHeaders = []
  let bytes = 0
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) return null
    const [name, headerValue] = pair
    if (
      typeof name !== 'string' ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      !boundedString(headerValue, DSH_TUNNEL_LIMITS.headerValueBytes) ||
      /[\r\n]/.test(headerValue)
    ) {
      return null
    }
    bytes += utf8Bytes(name) + utf8Bytes(headerValue) + 4
    if (bytes > DSH_TUNNEL_LIMITS.headersBytes) return null
    headers.push([name.toLowerCase(), headerValue])
  }
  return headers
}

export function encodeDshTunnelControl(message: DshTunnelControl): string {
  const text = JSON.stringify(message)
  if (utf8Bytes(text) > DSH_TUNNEL_LIMITS.controlBytes) {
    throw new Error('DSH tunnel control frame exceeds its limit')
  }
  return text
}

export function parseDshTunnelControl(text: string): DshTunnelParseResult<DshTunnelControl> {
  if (utf8Bytes(text) > DSH_TUNNEL_LIMITS.controlBytes) return fail('frame-too-large')
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    return fail('invalid-json')
  }
  if (!isRecord(raw) || typeof raw.type !== 'string') return fail('invalid-control')
  switch (raw.type) {
    case 'dsh-tunnel-hello':
      if (
        !exactKeys(raw, ['type', 'roomId', 'dshSeatToken', 'protocol']) ||
        raw.protocol !== 1 ||
        !boundedString(raw.roomId, 128) || !raw.roomId ||
        !boundedString(raw.dshSeatToken, 128) || !raw.dshSeatToken
      ) return fail('invalid-hello')
      return { ok: true, value: { type: raw.type, roomId: raw.roomId, dshSeatToken: raw.dshSeatToken, protocol: 1 } }
    case 'http-open': {
      if (!exactKeys(raw, ['type', 'streamId', 'method', 'path', 'headers', 'bodyLength'])) return fail('invalid-http-open')
      const headers = parseHeaders(raw.headers)
      if (
        !streamId(raw.streamId) || !boundedString(raw.method, 16) || !raw.method ||
        !boundedString(raw.path, 8_192) || !raw.path.startsWith('/') || !headers ||
        (raw.bodyLength !== undefined && (!uint32(raw.bodyLength) || raw.bodyLength > DSH_TUNNEL_LIMITS.requestBodyBytes))
      ) return fail('invalid-http-open')
      return { ok: true, value: { type: raw.type, streamId: raw.streamId, method: raw.method, path: raw.path, headers, ...(typeof raw.bodyLength === 'number' ? { bodyLength: raw.bodyLength } : {}) } }
    }
    case 'http-head': {
      if (!exactKeys(raw, ['type', 'streamId', 'status', 'headers'])) return fail('invalid-http-head')
      const headers = parseHeaders(raw.headers)
      if (!streamId(raw.streamId) || typeof raw.status !== 'number' || !Number.isInteger(raw.status) || raw.status < 100 || raw.status > 599 || !headers) return fail('invalid-http-head')
      return { ok: true, value: { type: raw.type, streamId: raw.streamId, status: raw.status, headers } }
    }
    case 'http-end':
      if (!exactKeys(raw, ['type', 'streamId']) || !streamId(raw.streamId)) return fail('invalid-http-end')
      return { ok: true, value: { type: raw.type, streamId: raw.streamId } }
    case 'http-abort':
      if (!exactKeys(raw, ['type', 'streamId', 'reason']) || !streamId(raw.streamId) || !boundedString(raw.reason, 128)) return fail('invalid-http-abort')
      return { ok: true, value: { type: raw.type, streamId: raw.streamId, reason: raw.reason } }
    case 'ws-open': {
      if (!exactKeys(raw, ['type', 'streamId', 'path', 'headers'])) return fail('invalid-ws-open')
      const headers = parseHeaders(raw.headers)
      if (!streamId(raw.streamId) || !boundedString(raw.path, 8_192) || !raw.path.startsWith('/') || !headers) return fail('invalid-ws-open')
      return { ok: true, value: { type: raw.type, streamId: raw.streamId, path: raw.path, headers } }
    }
    case 'ws-open-ok':
      if (!exactKeys(raw, ['type', 'streamId', 'protocol']) || !streamId(raw.streamId) || (raw.protocol !== undefined && !boundedString(raw.protocol, 256))) return fail('invalid-ws-open-ok')
      return { ok: true, value: { type: raw.type, streamId: raw.streamId, ...(typeof raw.protocol === 'string' ? { protocol: raw.protocol } : {}) } }
    case 'ws-open-reject':
      if (!exactKeys(raw, ['type', 'streamId', 'status']) || !streamId(raw.streamId) || typeof raw.status !== 'number' || !Number.isInteger(raw.status) || raw.status < 100 || raw.status > 599) return fail('invalid-ws-open-reject')
      return { ok: true, value: { type: raw.type, streamId: raw.streamId, status: raw.status } }
    case 'ws-close':
      if (!exactKeys(raw, ['type', 'streamId', 'code', 'reason']) || !streamId(raw.streamId) || !isDshWebSocketCloseCode(raw.code) || (raw.reason !== undefined && !boundedString(raw.reason, 123))) return fail('invalid-ws-close')
      return { ok: true, value: { type: raw.type, streamId: raw.streamId, code: raw.code, ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}) } }
    case 'credit':
      if (!exactKeys(raw, ['type', 'streamId', 'bytes']) || !streamId(raw.streamId) || typeof raw.bytes !== 'number' || !Number.isInteger(raw.bytes) || raw.bytes < 1 || raw.bytes > DSH_TUNNEL_LIMITS.streamBufferBytes) return fail('invalid-credit')
      return { ok: true, value: { type: raw.type, streamId: raw.streamId, bytes: raw.bytes } }
    case 'ping':
    case 'pong':
      if (!exactKeys(raw, ['type'])) return fail(`invalid-${raw.type}`)
      return { ok: true, value: { type: raw.type } }
    default:
      return fail('unknown-type')
  }
}

export function encodeDshTunnelBinary(frame: DshTunnelBinaryFrame): Uint8Array {
  if (!streamId(frame.streamId) || !uint32(frame.sequence)) throw new Error('invalid DSH tunnel binary coordinates')
  if (![1, 2, 3].includes(frame.kind) || frame.payload.byteLength > DSH_TUNNEL_LIMITS.framePayloadBytes) {
    throw new Error('invalid DSH tunnel binary payload')
  }
  const encoded = new Uint8Array(10 + frame.payload.byteLength)
  const view = new DataView(encoded.buffer)
  encoded[0] = 1
  encoded[1] = frame.kind
  view.setUint32(2, frame.streamId)
  view.setUint32(6, frame.sequence)
  encoded.set(frame.payload, 10)
  return encoded
}

export function parseDshTunnelBinary(data: Uint8Array): DshTunnelParseResult<DshTunnelBinaryFrame> {
  if (data.byteLength < 10 || data.byteLength > 10 + DSH_TUNNEL_LIMITS.framePayloadBytes) return fail('invalid-binary-size')
  const kind = data[1]
  if (data[0] !== 1 || (kind !== 1 && kind !== 2 && kind !== 3)) return fail('invalid-binary-header')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const id = view.getUint32(2)
  if (id === 0) return fail('invalid-binary-stream')
  return {
    ok: true,
    value: {
      kind,
      streamId: id,
      sequence: view.getUint32(6),
      payload: data.subarray(10)
    }
  }
}

import { createServer as createHttpServer } from 'node:http'
import { expect, test } from '@playwright/test'
import WebSocket, { WebSocketServer } from 'ws'
import {
  DSH_TUNNEL_LIMITS,
  encodeDshTunnelBinary,
  encodeDshTunnelControl,
  normalizeDshWebSocketCloseCode,
  parseDshTunnelBinary,
  parseDshTunnelControl
} from '../shared/dsh-tunnel-protocol'
import {
  DshTunnelClient,
  isAllowedDshHttpRoute,
  isAllowedDshWebSocketRoute
} from '../electron/dsh-host/DshTunnelClient'
import { parseRemoteMessage } from '../shared/remote-protocol'

test('DSH capability and surface frames are strict and backwards-optional', () => {
  expect(parseRemoteMessage({
    v: 1,
    type: 'hello-ok',
    peer: { desktop: true, phone: false }
  }).ok).toBe(true)
  expect(parseRemoteMessage({
    v: 1,
    type: 'hello-ok',
    peer: { desktop: true, phone: false },
    relayCapabilities: {
      dshWebTunnel: { origin: 'https://dsh.example.test', protocol: 1 }
    },
    dshSeatToken: 'one-seat-token'
  })).toMatchObject({ ok: true })
  for (const origin of [
    'http://dsh.example.test',
    'https://dsh.example.test/path',
    'https://user@dsh.example.test',
    'https://dsh.example.test?room=secret'
  ]) {
    expect(parseRemoteMessage({
      v: 1,
      type: 'hello-ok',
      peer: { desktop: true, phone: false },
      relayCapabilities: { dshWebTunnel: { origin, protocol: 1 } }
    }).ok, origin).toBe(false)
  }
  expect(parseRemoteMessage({
    v: 1,
    type: 'dsh-surface-state',
    surface: {
      id: 'dsh', kind: 'dsh-web', displayName: 'DeepSeek Harness',
      iconId: 'dsh', state: 'ready', generation: 1
    }
  })).toMatchObject({ ok: true })
  expect(parseRemoteMessage({
    v: 1,
    type: 'dsh-ticket-request',
    requestId: 'ticket-1'
  })).toMatchObject({ ok: true })
  expect(parseRemoteMessage({
    v: 1,
    type: 'dsh-ticket-ok',
    requestId: 'ticket-1',
    url: 'https://dsh.example.test/_connect/opaque',
    expiresAt: 1_800_000_000_000
  })).toMatchObject({ ok: true })
  expect(parseRemoteMessage({
    v: 1,
    type: 'dsh-ticket-reject',
    requestId: 'ticket-1',
    reason: 'tunnel-offline'
  })).toMatchObject({ ok: true })
  for (const url of [
    'http://dsh.example.test/_connect/opaque',
    'https://dsh.example.test/not-connect/opaque',
    'https://dsh.example.test/_connect/opaque?room=secret'
  ]) {
    expect(parseRemoteMessage({
      v: 1,
      type: 'dsh-ticket-ok',
      requestId: 'ticket-1',
      url,
      expiresAt: 1_800_000_000_000
    }).ok, url).toBe(false)
  }
})

test('DSH tunnel framing enforces exact controls, sequence coordinates and bounds', () => {
  expect(parseDshTunnelControl(JSON.stringify({
    type: 'http-open',
    streamId: 7,
    method: 'POST',
    path: '/api/session.list',
    headers: [['content-type', 'application/json']],
    bodyLength: 2
  }))).toMatchObject({ ok: true })
  expect(parseDshTunnelControl(JSON.stringify({
    type: 'http-open',
    streamId: 7,
    method: 'POST',
    path: '/api/session.list',
    headers: [],
    injected: 'not-allowed'
  }))).toMatchObject({ ok: false })
  expect(parseDshTunnelControl('x'.repeat(DSH_TUNNEL_LIMITS.controlBytes + 1))).toMatchObject({
    ok: false,
    reason: 'frame-too-large'
  })
  for (const code of [1004, 1005, 1006, 1015, 2999]) {
    expect(parseDshTunnelControl(JSON.stringify({
      type: 'ws-close', streamId: 7, code
    })), String(code)).toMatchObject({ ok: false, reason: 'invalid-ws-close' })
    expect(normalizeDshWebSocketCloseCode(code)).toBe(1001)
  }
  for (const code of [1000, 1001, 1008, 1013, 3000, 4999]) {
    expect(parseDshTunnelControl(JSON.stringify({
      type: 'ws-close', streamId: 7, code
    })), String(code)).toMatchObject({ ok: true })
    expect(normalizeDshWebSocketCloseCode(code)).toBe(code)
  }
  const payload = new Uint8Array([1, 2, 3, 4])
  const encoded = encodeDshTunnelBinary({ kind: 1, streamId: 7, sequence: 9, payload })
  expect(parseDshTunnelBinary(encoded)).toMatchObject({
    ok: true,
    value: { kind: 1, streamId: 7, sequence: 9, payload }
  })
  expect(() => encodeDshTunnelBinary({
    kind: 1,
    streamId: 7,
    sequence: 0,
    payload: new Uint8Array(DSH_TUNNEL_LIMITS.framePayloadBytes + 1)
  })).toThrow(/payload/)
})

test('Desktop route guard is a DSH allowlist, not a loopback/open proxy', () => {
  for (const [method, path] of [
    ['GET', '/'],
    ['GET', '/assets/app.js?rev=abc'],
    ['GET', '/plugins/events'],
    ['POST', '/api/session.list']
  ] as const) {
    expect(isAllowedDshHttpRoute(method, path), `${method} ${path}`).toBe(true)
  }
  for (const [method, path] of [
    ['GET', 'http://127.0.0.1:9222/json'],
    ['GET', '/../../secret'],
    ['GET', '/%252e%252e/secret'],
    ['CONNECT', '/api/session.list'],
    ['GET', '/unknown']
  ] as const) {
    expect(isAllowedDshHttpRoute(method, path), `${method} ${path}`).toBe(false)
  }
  expect(isAllowedDshWebSocketRoute('/api/events.host')).toBe(true)
  expect(isAllowedDshWebSocketRoute('/api/events.mux')).toBe(true)
  expect(isAllowedDshWebSocketRoute('/api/arbitrary')).toBe(false)
})

test('Desktop tunnel ignores late frames for retired ids and reconnects after a real protocol error', async () => {
  const local = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('ok')
  })
  await new Promise<void>((resolve, reject) => {
    local.once('error', reject)
    local.listen(0, '127.0.0.1', resolve)
  })
  const localAddress = local.address()
  if (!localAddress || typeof localAddress === 'string') throw new Error('missing local port')

  const gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => {
    gateway.once('listening', resolve)
    gateway.once('error', reject)
  })
  const gatewayAddress = gateway.address()
  if (typeof gatewayAddress === 'string') throw new Error('missing gateway port')

  let connections = 0
  const reconnected = new Promise<void>((resolveReconnect, rejectReconnect) => {
    const timer = setTimeout(() => rejectReconnect(new Error('tunnel did not reconnect')), 5_000)
    gateway.on('connection', (socket) => {
      connections += 1
      socket.once('message', (raw, binary) => {
        if (binary) return rejectReconnect(new Error('binary hello'))
        const hello = parseDshTunnelControl(raw.toString())
        if (!hello.ok || hello.value.type !== 'dsh-tunnel-hello') {
          return rejectReconnect(new Error('invalid tunnel hello'))
        }
        if (connections === 2) {
          clearTimeout(timer)
          resolveReconnect()
          return
        }
        socket.send(encodeDshTunnelControl({
          type: 'http-open', streamId: 7, method: 'GET', path: '/', headers: []
        }))
        socket.send(encodeDshTunnelControl({ type: 'http-end', streamId: 7 }))
      })
      socket.on('message', (raw, binary) => {
        if (connections !== 1 || binary) return
        const parsed = parseDshTunnelControl(raw.toString())
        if (!parsed.ok || parsed.value.type !== 'http-end' || parsed.value.streamId !== 7) return
        socket.send(encodeDshTunnelControl({
          type: 'http-abort', streamId: 7, reason: 'late-session-close'
        }))
        socket.send(encodeDshTunnelControl({ type: 'ping' }))
      })
      socket.on('message', (raw, binary) => {
        if (connections !== 1 || binary) return
        const parsed = parseDshTunnelControl(raw.toString())
        if (!parsed.ok || parsed.value.type !== 'pong') return
        expect(socket.readyState).toBe(WebSocket.OPEN)
        socket.send(encodeDshTunnelControl({
          type: 'http-abort', streamId: 99, reason: 'never-issued'
        }))
      })
    })
  })

  const client = new DshTunnelClient({
    getStatus: () => ({
      state: 'ready' as const,
      baseUrl: `http://127.0.0.1:${localAddress.port}`
    })
  })
  try {
    client.start({
      tunnelUrl: `ws://127.0.0.1:${gatewayAddress.port}`,
      roomId: 'd4-race-room',
      seatToken: 'test-seat-token',
      publicOrigin: 'https://dsh.example.test'
    })
    await reconnected
    expect(connections).toBe(2)
  } finally {
    client.stop()
    for (const socket of gateway.clients) socket.terminate()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    await new Promise<void>((resolve, reject) =>
      local.close((error) => error ? reject(error) : resolve())
    )
  }
})

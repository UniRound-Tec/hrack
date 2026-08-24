import { expect, test } from '@playwright/test'
import {
  DSH_TUNNEL_LIMITS,
  encodeDshTunnelBinary,
  parseDshTunnelBinary,
  parseDshTunnelControl
} from '../shared/dsh-tunnel-protocol'
import {
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

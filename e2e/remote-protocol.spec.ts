import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  disconnect,
  emptyRooms,
  hello,
  openRoom,
  parseJoinUrl,
  parseRemoteFrame,
  parseRemoteMessage,
  revoke,
  type JoinUrl,
  type RemoteMessage
} from '../shared/remote-protocol'

const fixtureDir = join(__dirname, 'fixtures', 'remote')

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'))
}

function expectJoin(input: string): JoinUrl {
  const parsed = parseJoinUrl(input)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.value
}

function expectMessage(raw: unknown): RemoteMessage {
  const parsed = parseRemoteMessage(raw)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.value
}

test.describe('join URL', () => {
  test('parses the SPEC https / subpath / http examples', () => {
    expect(expectJoin('https://hrack.dev/aK3')).toEqual({
      origin: 'https://hrack.dev',
      base: '',
      roomId: 'aK3',
      wsUrl: 'wss://hrack.dev/v1/ws',
      href: 'https://hrack.dev/aK3'
    })
    expect(expectJoin('https://my.box:8443/remote/aK3')).toEqual({
      origin: 'https://my.box:8443',
      base: '/remote',
      roomId: 'aK3',
      wsUrl: 'wss://my.box:8443/remote/v1/ws',
      href: 'https://my.box:8443/remote/aK3'
    })
    expect(expectJoin('http://127.0.0.1:9/aK3')).toEqual({
      origin: 'http://127.0.0.1:9',
      base: '',
      roomId: 'aK3',
      wsUrl: 'ws://127.0.0.1:9/v1/ws',
      href: 'http://127.0.0.1:9/aK3'
    })
  })

  test('maps https to wss and keeps ws join URLs for the P1 test relay', () => {
    expect(expectJoin('https://hrack.dev/aK3').wsUrl.startsWith('wss:')).toBe(
      true
    )
    expect(expectJoin('http://127.0.0.1:9/aK3').wsUrl.startsWith('ws:')).toBe(
      true
    )
    expect(expectJoin('ws://127.0.0.1:9/aK3')).toEqual({
      origin: 'ws://127.0.0.1:9',
      base: '',
      roomId: 'aK3',
      wsUrl: 'ws://127.0.0.1:9/v1/ws',
      href: 'ws://127.0.0.1:9/aK3'
    })
    expect(expectJoin('http://localhost:9/aK3').wsUrl).toBe(
      'ws://localhost:9/v1/ws'
    )
  })

  test('treats a trailing slash as the same join URL', () => {
    expect(expectJoin('https://hrack.dev/aK3/')).toEqual(
      expectJoin('https://hrack.dev/aK3')
    )
  })

  test('rejects a missing room segment and non-http(s)/ws(s) schemes', () => {
    expect(parseJoinUrl('https://hrack.dev').ok).toBe(false)
    expect(parseJoinUrl('https://hrack.dev/').ok).toBe(false)
    expect(parseJoinUrl('ftp://hrack.dev/aK3').ok).toBe(false)
    expect(parseJoinUrl('not a url').ok).toBe(false)
    expect(parseJoinUrl(`https://hrack.dev/${'a'.repeat(129)}`)).toEqual({
      ok: false,
      reason: 'invalid-room'
    })
    expect(parseJoinUrl('ws://relay.example.com/aK3')).toEqual({
      ok: false,
      reason: 'insecure-remote'
    })
    expect(parseJoinUrl('http://192.168.1.8/aK3')).toEqual({
      ok: false,
      reason: 'insecure-remote'
    })
  })

  test('ignores query and hash and keeps deeper bases', () => {
    expect(expectJoin('https://hrack.dev/aK3?x=1#y')).toMatchObject({
      roomId: 'aK3',
      href: 'https://hrack.dev/aK3'
    })
    expect(expectJoin('https://my.box/remote/foo/aK3')).toMatchObject({
      base: '/remote/foo',
      roomId: 'aK3',
      wsUrl: 'wss://my.box/remote/foo/v1/ws'
    })
  })
})

test.describe('message guards', () => {
  test('accepts the golden hello, snapshot, and drive-ok fixtures', () => {
    expect(expectMessage(loadFixture('hello.json')).type).toBe('hello')
    expect(expectMessage(loadFixture('sessions-snapshot.json'))).toMatchObject({
      type: 'sessions-snapshot',
      sessions: [{ sessionId: 'sess-1', status: 'needs-you' }]
    })
    expect(expectMessage(loadFixture('drive-ok.json'))).toMatchObject({
      type: 'drive-ok',
      sessionId: 'sess-1',
      cols: 40,
      rows: 18,
      history: { complete: true, events: [{ kind: 'output', data: 'hello' }] }
    })
  })

  test('rejects an illegal protocol version', () => {
    const base = { type: 'hello', role: 'desktop', roomId: 'aK3' }
    expect(parseRemoteMessage({ ...base, v: 0 }).ok).toBe(false)
    expect(parseRemoteMessage({ ...base, v: 2 }).ok).toBe(false)
    expect(parseRemoteMessage({ ...base }).ok).toBe(false)
    expect(parseRemoteMessage({ ...base, v: '1' }).ok).toBe(false)
  })

  test('rejects a snapshot session that carries correlation or an executable path', () => {
    const fixture = loadFixture('sessions-snapshot.json') as {
      sessions: Array<Record<string, unknown>>
    }
    const withCorrelation = structuredClone(fixture)
    withCorrelation.sessions[0].correlation = { exited: false }
    expect(parseRemoteMessage(withCorrelation).ok).toBe(false)

    const withExe = structuredClone(fixture)
    withExe.sessions[0].resolvedExecutable = 'C:\\\\Program Files\\\\claude.exe'
    expect(parseRemoteMessage(withExe).ok).toBe(false)

    for (const key of [
      'terminalId',
      'installationId',
      'adapterSessionId',
      'observerHealth',
      'usage',
      'capabilities',
      'lastSeq',
      'activeTurnId'
    ]) {
      const withSensitiveField = structuredClone(fixture)
      withSensitiveField.sessions[0][key] = 'local-only'
      expect(parseRemoteMessage(withSensitiveField).ok, key).toBe(false)
    }
  })

  test('preserves create size and leaves an empty workspace for correlated rejection', () => {
    expect(
      expectMessage({
        v: 1,
        type: 'create',
        requestId: 'create-1',
        installationId: 'inst-1',
        workspace: '',
        cols: 40,
        rows: 18
      })
    ).toEqual({
      v: 1,
      type: 'create',
      requestId: 'create-1',
      installationId: 'inst-1',
      workspace: '',
      cols: 40,
      rows: 18
    })
    for (const invalid of [
      { workspace: 'C:\\repo' },
      { workspace: 'C:\\repo', cols: 0, rows: 18 },
      { workspace: 'C:\\repo', cols: 40, rows: 10_001 },
      { workspace: 'C:\\repo\0', cols: 40, rows: 18 }
    ]) {
      expect(
        parseRemoteMessage({
          v: 1,
          type: 'create',
          requestId: 'create-invalid',
          installationId: 'inst-1',
          ...invalid
        }).ok
      ).toBe(false)
    }
  })

  test('accepts not-implemented', () => {
    expect(
      expectMessage({ v: 1, type: 'not-implemented', for: 'drive' })
    ).toEqual({ v: 1, type: 'not-implemented', for: 'drive' })
  })

  test('requires request correlation for drive/create and preserves it in replies', () => {
    expect(
      parseRemoteMessage({
        v: 1,
        type: 'drive',
        sessionId: 's1',
        cols: 40,
        rows: 18
      }).ok
    ).toBe(false)
    expect(
      expectMessage({
        v: 1,
        type: 'create-reject',
        requestId: 'create-1',
        reason: 'invalid-workspace'
      })
    ).toMatchObject({ requestId: 'create-1' })
  })

  test('validates pty base64, decoded byteLength, and frame size before JSON parsing', () => {
    expect(
      expectMessage({
        v: 1,
        type: 'pty-out',
        sessionId: 's1',
        data: 'aGVsbG8=',
        byteLength: 5
      }).type
    ).toBe('pty-out')
    expect(
      parseRemoteMessage({
        v: 1,
        type: 'pty-out',
        sessionId: 's1',
        data: 'not-base64!!!',
        byteLength: 5
      }).ok
    ).toBe(false)
    expect(
      parseRemoteMessage({
        v: 1,
        type: 'pty-out',
        sessionId: 's1',
        data: 'aGVsbG8=',
        byteLength: 999
      }).ok
    ).toBe(false)
    expect(parseRemoteFrame('{not json')).toEqual({
      ok: false,
      reason: 'invalid-json'
    })
    expect(parseRemoteFrame(' '.repeat(1_048_577))).toEqual({
      ok: false,
      reason: 'frame-too-large'
    })
    expect(parseRemoteFrame('你'.repeat(400_000))).toEqual({
      ok: false,
      reason: 'frame-too-large'
    })
  })
})

test.describe('room seats', () => {
  const roomId = 'aK3'

  test('hello without openRoom is bad-key', () => {
    const outcome = hello(emptyRooms(), {
      roomId,
      role: 'desktop',
      connectionId: 'd1'
    })
    expect(outcome.replies.map((reply) => reply.message.type)).toEqual([
      'bad-key'
    ])
    expect(outcome.rooms).toEqual({})
  })

  test('first desktop hello occupies the seat', () => {
    const rooms = openRoom(emptyRooms(), roomId)
    const outcome = hello(rooms, {
      roomId,
      role: 'desktop',
      connectionId: 'd1'
    })
    expect(outcome.replies[0]?.message).toEqual({
      v: 1,
      type: 'hello-ok',
      peer: { desktop: true, phone: false }
    })
    expect(outcome.rooms[roomId]).toEqual({
      status: 'open',
      desktop: 'd1',
      phone: null
    })
  })

  test('a second desktop is occupied and does not kick the first', () => {
    let rooms = openRoom(emptyRooms(), roomId)
    rooms = hello(rooms, {
      roomId,
      role: 'desktop',
      connectionId: 'd1'
    }).rooms
    const second = hello(rooms, {
      roomId,
      role: 'desktop',
      connectionId: 'd2'
    })
    expect(second.replies[0]?.message.type).toBe('occupied')
    expect(second.rooms[roomId]).toEqual({
      status: 'open',
      desktop: 'd1',
      phone: null
    })
    expect(second.rooms).toBe(rooms)
  })

  test('disconnect then a new desktop can sit', () => {
    let rooms = openRoom(emptyRooms(), roomId)
    rooms = hello(rooms, {
      roomId,
      role: 'desktop',
      connectionId: 'd1'
    }).rooms
    rooms = disconnect(rooms, 'd1').rooms
    const again = hello(rooms, {
      roomId,
      role: 'desktop',
      connectionId: 'd2'
    })
    expect(again.replies[0]?.message.type).toBe('hello-ok')
    expect(again.rooms[roomId]).toMatchObject({ desktop: 'd2' })
  })

  test('one connection cannot change role, and defensive disconnect clears every legacy seat', () => {
    let rooms = openRoom(emptyRooms(), roomId)
    rooms = hello(rooms, {
      roomId,
      role: 'desktop',
      connectionId: 'same-socket'
    }).rooms
    const secondRole = hello(rooms, {
      roomId,
      role: 'phone',
      connectionId: 'same-socket'
    })
    expect(secondRole.replies[0]?.message.type).toBe('occupied')
    expect(secondRole.rooms[roomId]).toMatchObject({
      desktop: 'same-socket',
      phone: null
    })

    const legacyRooms = {
      [roomId]: {
        status: 'open' as const,
        desktop: 'same-socket',
        phone: 'same-socket'
      }
    }
    expect(
      hello(legacyRooms, {
        roomId,
        role: 'desktop',
        connectionId: 'same-socket'
      }).replies[0]?.message.type
    ).toBe('occupied')
    expect(disconnect(legacyRooms, 'same-socket').rooms[roomId]).toEqual({
      status: 'open',
      desktop: null,
      phone: null
    })
  })

  test('phone join notifies the seated desktop', () => {
    let rooms = openRoom(emptyRooms(), roomId)
    rooms = hello(rooms, {
      roomId,
      role: 'desktop',
      connectionId: 'd1'
    }).rooms
    const phone = hello(rooms, {
      roomId,
      role: 'phone',
      connectionId: 'p1'
    })
    expect(phone.replies).toEqual([
      {
        connectionId: 'p1',
        message: {
          v: 1,
          type: 'hello-ok',
          peer: { desktop: true, phone: true }
        }
      },
      {
        connectionId: 'd1',
        message: { v: 1, type: 'peer-join', role: 'phone' }
      }
    ])
  })

  test('revoke notifies both seats and later hello is bad-key', () => {
    let rooms = openRoom(emptyRooms(), roomId)
    rooms = hello(rooms, {
      roomId,
      role: 'desktop',
      connectionId: 'd1'
    }).rooms
    rooms = hello(rooms, {
      roomId,
      role: 'phone',
      connectionId: 'p1'
    }).rooms
    const revoked = revoke(rooms, roomId)
    expect(revoked.replies.map((reply) => reply.message.type)).toEqual([
      'revoked',
      'revoked'
    ])
    expect(hello(revoked.rooms, {
      roomId,
      role: 'desktop',
      connectionId: 'd3'
    }).replies[0]?.message.type).toBe('bad-key')
    expect(openRoom(revoked.rooms, roomId)).toBe(revoked.rooms)
    expect(openRoom(revoked.rooms, roomId)[roomId]).toEqual({
      status: 'revoked'
    })
  })
})

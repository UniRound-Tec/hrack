import { expect, test } from '@playwright/test'
import { createInitialAgentProjection } from '../electron/agents/AgentEventReducer'
import {
  RemoteDesktopClient,
  type RemoteDriveObserver,
  type RemotePtyHost,
  type RemoteSessionChange
} from '../electron/remote/RemoteDesktopClient'
import { toRemoteSession } from '../electron/remote/toRemoteSession'
import type { AgentSessionRecord } from '../electron/agents/AgentSessionRuntime'
import {
  REMOTE_PROTOCOL_LIMITS,
  parseRemoteMessage,
  type RemoteMessage,
  type RemoteSession
} from '../shared/remote-protocol'
import { RemoteTestRelay } from './helpers/remoteTestRelay'
import { REMOTE_DRIVE_IDLE_STATE } from '../shared/ipc-contract'

class MemorySessions {
  private readonly sessions = new Map<string, RemoteSession>()
  private readonly listeners = new Set<(change: RemoteSessionChange) => void>()

  list(): RemoteSession[] {
    return [...this.sessions.values()]
  }

  subscribe(listener: (change: RemoteSessionChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  upsert(session: RemoteSession): void {
    this.sessions.set(session.sessionId, session)
    for (const listener of this.listeners) {
      listener({ kind: 'upsert', session })
    }
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId)
    for (const listener of this.listeners) {
      listener({ kind: 'removed', sessionId })
    }
  }
}

class MemoryRemotePtyHost implements RemotePtyHost {
  readonly opens: Array<{
    sessionId: string
    cols: number
    rows: number
  }> = []
  readonly writes: string[] = []
  readonly resizes: Array<{ cols: number; rows: number }> = []
  readonly acknowledgements: number[] = []
  releases = 0
  observer: RemoteDriveObserver | null = null
  historyData = 'ready>'

  open(
    input: { sessionId: string; cols: number; rows: number },
    observer: RemoteDriveObserver
  ) {
    this.opens.push(input)
    if (input.sessionId === 'missing') {
      return { ok: false as const, reason: 'not-found' as const }
    }
    if (input.sessionId === 'exited') {
      return { ok: false as const, reason: 'exited' as const }
    }
    this.observer = observer
    return {
      ok: true as const,
      target: {
        sessionId: input.sessionId,
        terminalId: 'terminal-1',
        history: {
          complete: true,
          retainedOutputBytes: Buffer.byteLength(this.historyData),
          droppedOutputBytes: 0,
          droppedEvents: 0,
          events: [
            {
              sequence: 1,
              kind: 'output' as const,
              data: this.historyData,
              byteLength: Buffer.byteLength(this.historyData)
            }
          ]
        },
        write: (data: string) => this.writes.push(data),
        resize: (cols: number, rows: number) =>
          this.resizes.push({ cols, rows }),
        acknowledge: (bytes: number) => this.acknowledgements.push(bytes),
        release: () => {
          this.releases += 1
        }
      }
    }
  }
}

function remoteSession(
  overrides: Partial<RemoteSession> & Pick<RemoteSession, 'sessionId'>
): RemoteSession {
  return {
    name: overrides.sessionId,
    adapterId: 'claude',
    status: 'idle',
    statusConfidence: 'high',
    pendingAttentionCount: 0,
    activeToolCount: 0,
    lastActivityAt: 1,
    workspace: 'C:/repo',
    ...overrides
  }
}

async function openPhone(
  relay: RemoteTestRelay,
  roomId: string
): Promise<{ ws: WebSocket; messages: RemoteMessage[] }> {
  const messages: RemoteMessage[] = []
  const ws = new WebSocket(`${relay.origin}/v1/ws`)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('phone socket failed')))
  })
  ws.addEventListener('message', (event) => {
    const parsed = parseRemoteMessage(JSON.parse(String(event.data)))
    if (parsed.ok) messages.push(parsed.value)
  })
  ws.send(
    JSON.stringify({ v: 1, type: 'hello', role: 'phone', roomId })
  )
  return { ws, messages }
}

test.describe('remote desktop client', () => {
  let relay: RemoteTestRelay

  test.beforeEach(async () => {
    relay = await RemoteTestRelay.listen()
    relay.openRoom('aK3')
  })

  test.afterEach(async () => {
    await relay.close()
  })

  test('starting the test relay does not spawn an HRack GUI', () => {
    expect(process.versions.electron).toBeUndefined()
  })

  test('connects with hello role=desktop', async () => {
    const client = new RemoteDesktopClient({
      sessions: new MemorySessions(),
      broadcast: () => {}
    })
    client.connect(relay.joinUrl('aK3'))
    await expect
      .poll(() => client.getState().phase)
      .toBe('waiting-phone')
    expect(relay.hellos).toEqual([{ role: 'desktop', roomId: 'aK3' }])
    client.dispose()
  })

  test('connects through a deployment base path', async () => {
    await relay.close()
    relay = await RemoteTestRelay.listen(0, '/remote')
    relay.openRoom('aK3')
    const client = new RemoteDesktopClient({
      sessions: new MemorySessions(),
      broadcast: () => {}
    })
    client.connect(relay.joinUrl('aK3'))
    await expect.poll(() => client.getState().phase).toBe('waiting-phone')
    expect(relay.hellos).toEqual([{ role: 'desktop', roomId: 'aK3' }])
    client.dispose()
  })

  test('sends a two-session snapshot after the phone joins', async () => {
    const sessions = new MemorySessions()
    sessions.upsert(remoteSession({ sessionId: 's1', status: 'idle' }))
    sessions.upsert(remoteSession({ sessionId: 's2', status: 'working' }))
    const client = new RemoteDesktopClient({
      sessions,
      broadcast: () => {}
    })
    client.connect(relay.joinUrl('aK3'))
    await expect.poll(() => client.getState().phase).toBe('waiting-phone')
    const phone = await openPhone(relay, 'aK3')
    await expect
      .poll(() => phone.messages.find((msg) => msg.type === 'sessions-snapshot'))
      .toMatchObject({
        type: 'sessions-snapshot',
        sessions: [
          { sessionId: 's1', status: 'idle' },
          { sessionId: 's2', status: 'working' }
        ]
      })
    phone.ws.close()
    client.dispose()
  })

  test('pushes session-upsert when a seated session becomes needs-you', async () => {
    const sessions = new MemorySessions()
    sessions.upsert(remoteSession({ sessionId: 's1', status: 'working' }))
    const client = new RemoteDesktopClient({
      sessions,
      broadcast: () => {}
    })
    client.connect(relay.joinUrl('aK3'))
    await expect.poll(() => client.getState().phase).toBe('waiting-phone')
    const phone = await openPhone(relay, 'aK3')
    await expect
      .poll(() =>
        phone.messages.some((msg) => msg.type === 'sessions-snapshot')
      )
      .toBe(true)
    sessions.upsert(remoteSession({ sessionId: 's1', status: 'needs-you' }))
    await expect
      .poll(() =>
        phone.messages.find((msg) => msg.type === 'session-upsert')
      )
      .toMatchObject({
        type: 'session-upsert',
        session: { sessionId: 's1', status: 'needs-you' }
      })
    phone.ws.close()
    client.dispose()
  })

  test('pushes session-removed when a session is closed', async () => {
    const sessions = new MemorySessions()
    sessions.upsert(remoteSession({ sessionId: 's1', status: 'idle' }))
    const client = new RemoteDesktopClient({
      sessions,
      broadcast: () => {}
    })
    client.connect(relay.joinUrl('aK3'))
    await expect.poll(() => client.getState().phase).toBe('waiting-phone')
    const phone = await openPhone(relay, 'aK3')
    await expect
      .poll(() =>
        phone.messages.some((msg) => msg.type === 'sessions-snapshot')
      )
      .toBe(true)
    sessions.remove('s1')
    await expect
      .poll(() =>
        phone.messages.find((msg) => msg.type === 'session-removed')
      )
      .toMatchObject({ type: 'session-removed', sessionId: 's1' })
    phone.ws.close()
    client.dispose()
  })

  test('a second desktop is occupied and the first stays connected', async () => {
    const first = new RemoteDesktopClient({
      sessions: new MemorySessions(),
      broadcast: () => {}
    })
    first.connect(relay.joinUrl('aK3'))
    await expect.poll(() => first.getState().phase).toBe('waiting-phone')
    const second = new RemoteDesktopClient({
      sessions: new MemorySessions(),
      broadcast: () => {}
    })
    second.connect(relay.joinUrl('aK3'))
    await expect.poll(() => second.getState().error).toBe('occupied')
    expect(first.getState().phase).toBe('waiting-phone')
    first.dispose()
    second.dispose()
  })

  test('opens a PTY drive and replies with correlated history', async () => {
    const pty = new MemoryRemotePtyHost()
    const client = new RemoteDesktopClient({
      sessions: new MemorySessions(),
      broadcast: () => {},
      pty,
      broadcastDrive: () => {}
    })
    client.connect(relay.joinUrl('aK3'))
    await expect.poll(() => client.getState().phase).toBe('waiting-phone')
    const phone = await openPhone(relay, 'aK3')
    await expect
      .poll(() =>
        phone.messages.some((msg) => msg.type === 'hello-ok')
      )
      .toBe(true)
    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'drive',
        requestId: 'drive-1',
        sessionId: 's1',
        cols: 40,
        rows: 18
      })
    )
    await expect
      .poll(() =>
        phone.messages.find((msg) => msg.type === 'drive-ok')
      )
      .toEqual({
        v: 1,
        type: 'drive-ok',
        requestId: 'drive-1',
        sessionId: 's1',
        cols: 40,
        rows: 18,
        history: {
          complete: true,
          retainedOutputBytes: 6,
          droppedOutputBytes: 0,
          droppedEvents: 0,
          events: [
            {
              sequence: 1,
              kind: 'output',
              data: 'ready>',
              byteLength: 6
            }
          ]
        }
      })
    expect(pty.opens).toEqual([{ sessionId: 's1', cols: 40, rows: 18 }])
    phone.ws.close()
    client.dispose()
  })

  test('bounds drive history to the protocol frame and marks truncation', async () => {
    const pty = new MemoryRemotePtyHost()
    pty.historyData = '\u001b'.repeat(256 * 1024)
    const client = new RemoteDesktopClient({
      sessions: new MemorySessions(),
      broadcast: () => {},
      pty
    })
    client.connect(relay.joinUrl('aK3'))
    await expect.poll(() => client.getState().phase).toBe('waiting-phone')
    const phone = await openPhone(relay, 'aK3')
    await expect.poll(() => client.getState().phase).toBe('peer-online')
    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'drive',
        requestId: 'drive-large-history',
        sessionId: 's1',
        cols: 40,
        rows: 18
      })
    )
    await expect
      .poll(
        () => phone.messages.find((message) => message.type === 'drive-ok'),
        { timeout: 1_000 }
      )
      .toBeTruthy()
    const reply = phone.messages.find((message) => message.type === 'drive-ok')
    if (!reply || reply.type !== 'drive-ok') throw new Error('missing drive-ok')
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(
      REMOTE_PROTOCOL_LIMITS.frameBytes
    )
    expect(reply.history).toMatchObject({
      complete: false,
      retainedOutputBytes: 0,
      droppedOutputBytes: 256 * 1024,
      droppedEvents: 1,
      events: []
    })
    phone.ws.close()
    client.dispose()
  })

  test('routes the driven PTY data plane and lets desktop reclaim it', async () => {
    const pty = new MemoryRemotePtyHost()
    const driveStates: string[] = []
    const client = new RemoteDesktopClient({
      sessions: new MemorySessions(),
      broadcast: () => {},
      pty,
      broadcastDrive: (state) => driveStates.push(state.phase)
    })
    client.connect(relay.joinUrl('aK3'))
    await expect.poll(() => client.getState().phase).toBe('waiting-phone')
    const phone = await openPhone(relay, 'aK3')
    await expect.poll(() => client.getState().phase).toBe('peer-online')
    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'drive',
        requestId: 'drive-data',
        sessionId: 's1',
        cols: 40,
        rows: 18
      })
    )
    await expect.poll(() => client.getDriveState().phase).toBe('driven')

    phone.ws.send(
      JSON.stringify({ v: 1, type: 'pty-in', sessionId: 'wrong', data: 'bad\r' })
    )
    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'pty-resize',
        sessionId: 'wrong',
        cols: 70,
        rows: 30
      })
    )
    phone.ws.send(
      JSON.stringify({ v: 1, type: 'pty-ack', sessionId: 'wrong', bytes: 99 })
    )
    phone.ws.send(
      JSON.stringify({ v: 1, type: 'undrive', sessionId: 'wrong' })
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(pty.writes).toEqual([])
    expect(pty.resizes).toEqual([])
    expect(pty.acknowledgements).toEqual([])
    expect(client.getDriveState().phase).toBe('driven')

    phone.ws.send(
      JSON.stringify({ v: 1, type: 'pty-in', sessionId: 's1', data: 'whoami\r' })
    )
    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'pty-resize',
        sessionId: 's1',
        cols: 52,
        rows: 20
      })
    )
    phone.ws.send(
      JSON.stringify({ v: 1, type: 'pty-ack', sessionId: 's1', bytes: 13 })
    )
    await expect.poll(() => pty.writes).toEqual(['whoami\r'])
    expect(pty.resizes).toEqual([{ cols: 52, rows: 20 }])
    expect(pty.acknowledgements).toEqual([13])

    pty.observer?.onOutput(new TextEncoder().encode('desktop-output'))
    await expect
      .poll(() => phone.messages.find((message) => message.type === 'pty-out'))
      .toMatchObject({
        type: 'pty-out',
        sessionId: 's1',
        data: Buffer.from('desktop-output').toString('base64'),
        byteLength: 14
      })

    expect(client.reclaim('s1')).toEqual(REMOTE_DRIVE_IDLE_STATE)
    await expect
      .poll(() => phone.messages.find((message) => message.type === 'undriven'))
      .toMatchObject({ type: 'undriven', sessionId: 's1', reason: 'reclaim' })
    expect(pty.releases).toBe(1)
    expect(driveStates).toEqual(['driven', 'driven', 'idle'])
    phone.ws.close()
    client.dispose()
  })

  test('rejects unknown, exited, and concurrent drive requests', async () => {
    const client = new RemoteDesktopClient({
      sessions: new MemorySessions(),
      broadcast: () => {},
      pty: new MemoryRemotePtyHost()
    })
    client.connect(relay.joinUrl('aK3'))
    await expect.poll(() => client.getState().phase).toBe('waiting-phone')
    const phone = await openPhone(relay, 'aK3')
    await expect.poll(() => client.getState().phase).toBe('peer-online')
    for (const [requestId, sessionId] of [
      ['missing-request', 'missing'],
      ['exited-request', 'exited'],
      ['active-request', 's1'],
      ['busy-request', 's2']
    ]) {
      phone.ws.send(
        JSON.stringify({
          v: 1,
          type: 'drive',
          requestId,
          sessionId,
          cols: 40,
          rows: 18
        })
      )
    }
    await expect
      .poll(() =>
        phone.messages
          .filter((message) => message.type === 'drive-reject')
          .map((message) =>
            message.type === 'drive-reject'
              ? [message.requestId, message.reason]
              : []
          )
      )
      .toEqual([
        ['missing-request', 'not-found'],
        ['exited-request', 'exited'],
        ['busy-request', 'busy']
      ])
    phone.ws.close()
    client.dispose()
  })

  test('releases when the phone returns from the driven terminal', async () => {
    const pty = new MemoryRemotePtyHost()
    const client = new RemoteDesktopClient({
      sessions: new MemorySessions(),
      broadcast: () => {},
      pty
    })
    client.connect(relay.joinUrl('aK3'))
    await expect.poll(() => client.getState().phase).toBe('waiting-phone')
    const phone = await openPhone(relay, 'aK3')
    await expect.poll(() => client.getState().phase).toBe('peer-online')
    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'drive',
        requestId: 'drive-left',
        sessionId: 's1',
        cols: 40,
        rows: 18
      })
    )
    await expect.poll(() => client.getDriveState().phase).toBe('driven')
    phone.ws.send(JSON.stringify({ v: 1, type: 'undrive', sessionId: 's1' }))
    await expect
      .poll(() => phone.messages.find((message) => message.type === 'undriven'))
      .toMatchObject({ type: 'undriven', sessionId: 's1', reason: 'left' })
    expect(client.getDriveState()).toEqual(REMOTE_DRIVE_IDLE_STATE)
    expect(pty.releases).toBe(1)
    phone.ws.close()
    client.dispose()
  })

  test('keeps a drive through a short phone reconnect and times out after grace', async () => {
    const pty = new MemoryRemotePtyHost()
    const client = new RemoteDesktopClient({
      sessions: new MemorySessions(),
      broadcast: () => {},
      pty,
      phoneGraceMs: 500
    })
    client.connect(relay.joinUrl('aK3'))
    await expect.poll(() => client.getState().phase).toBe('waiting-phone')
    let phone = await openPhone(relay, 'aK3')
    await expect.poll(() => client.getState().phase).toBe('peer-online')
    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'drive',
        requestId: 'drive-grace',
        sessionId: 's1',
        cols: 40,
        rows: 18
      })
    )
    await expect.poll(() => client.getDriveState().phase).toBe('driven')

    phone.ws.close()
    await expect.poll(() => client.getState().phase).toBe('waiting-phone')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(client.getDriveState().phase).toBe('driven')

    phone = await openPhone(relay, 'aK3')
    await expect.poll(() => client.getState().phase).toBe('peer-online')
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(client.getDriveState().phase).toBe('driven')

    phone.ws.close()
    await expect.poll(() => client.getDriveState().phase).toBe('idle')
    expect(pty.releases).toBe(1)
    client.dispose()
  })

  test('reports PTY exit before releasing the drive', async () => {
    const pty = new MemoryRemotePtyHost()
    const client = new RemoteDesktopClient({
      sessions: new MemorySessions(),
      broadcast: () => {},
      pty
    })
    client.connect(relay.joinUrl('aK3'))
    await expect.poll(() => client.getState().phase).toBe('waiting-phone')
    const phone = await openPhone(relay, 'aK3')
    await expect.poll(() => client.getState().phase).toBe('peer-online')
    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'drive',
        requestId: 'drive-exit',
        sessionId: 's1',
        cols: 40,
        rows: 18
      })
    )
    await expect.poll(() => client.getDriveState().phase).toBe('driven')
    pty.observer?.onExit({ code: 23, signal: 9 })
    await expect
      .poll(() =>
        phone.messages
          .filter(
            (message) => message.type === 'pty-exit' || message.type === 'undriven'
          )
          .map((message) => message.type)
      )
      .toEqual(['pty-exit', 'undriven'])
    expect(phone.messages.find((message) => message.type === 'pty-exit')).toMatchObject(
      { type: 'pty-exit', sessionId: 's1', code: 23, signal: 9 }
    )
    expect(phone.messages.find((message) => message.type === 'undriven')).toMatchObject(
      { type: 'undriven', sessionId: 's1', reason: 'session-exit' }
    )
    expect(client.getDriveState()).toEqual(REMOTE_DRIVE_IDLE_STATE)
    phone.ws.close()
    client.dispose()
  })

  test('releases the drive when the desktop WebSocket drops', async () => {
    const pty = new MemoryRemotePtyHost()
    const client = new RemoteDesktopClient({
      sessions: new MemorySessions(),
      broadcast: () => {},
      pty
    })
    client.connect(relay.joinUrl('aK3'))
    await expect.poll(() => client.getState().phase).toBe('waiting-phone')
    const phone = await openPhone(relay, 'aK3')
    await expect.poll(() => client.getState().phase).toBe('peer-online')
    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'drive',
        requestId: 'drive-drop',
        sessionId: 's1',
        cols: 40,
        rows: 18
      })
    )
    await expect.poll(() => client.getDriveState().phase).toBe('driven')

    await relay.close()
    await expect.poll(() => client.getState().phase).toBe('error')
    expect(client.getDriveState()).toEqual(REMOTE_DRIVE_IDLE_STATE)
    expect(pty.releases).toBe(1)
    phone.ws.close()
    client.dispose()
    relay = await RemoteTestRelay.listen()
  })

  test('relay drops phone frames that impersonate relay control messages', async () => {
    const client = new RemoteDesktopClient({
      sessions: new MemorySessions(),
      broadcast: () => {}
    })
    client.connect(relay.joinUrl('aK3'))
    await expect.poll(() => client.getState().phase).toBe('waiting-phone')
    const phone = await openPhone(relay, 'aK3')
    await expect.poll(() => client.getState().phase).toBe('peer-online')

    phone.ws.send(JSON.stringify({ v: 1, type: 'revoked' }))
    phone.ws.send(
      JSON.stringify({
        v: 1,
        type: 'drive',
        requestId: 'direction-barrier',
        sessionId: 's1',
        cols: 40,
        rows: 18
      })
    )
    await expect
      .poll(() =>
        phone.messages.find(
          (message) =>
            message.type === 'not-implemented' &&
            message.requestId === 'direction-barrier'
        )
      )
      .toBeTruthy()
    expect(client.getState().phase).toBe('peer-online')
    expect(relay.fromPhone.map((message) => message.type)).toEqual(['drive'])
    phone.ws.close()
    client.dispose()
  })

  test('waits for revoked confirmation before becoming idle', async () => {
    const client = new RemoteDesktopClient({
      sessions: new MemorySessions(),
      broadcast: () => {},
      revokeTimeoutMs: 500
    })
    client.connect(relay.joinUrl('aK3'))
    await expect.poll(() => client.getState().phase).toBe('waiting-phone')

    const result = await client.revoke()

    expect(result).toEqual({
      phase: 'idle',
      href: null,
      origin: null,
      error: null
    })
    expect(relay.revokes).toEqual(['aK3'])
    client.dispose()
  })

  test('reports an error when the relay does not confirm revocation', async () => {
    relay.confirmRevokes = false
    const client = new RemoteDesktopClient({
      sessions: new MemorySessions(),
      broadcast: () => {},
      revokeTimeoutMs: 10
    })
    client.connect(relay.joinUrl('aK3'))
    await expect.poll(() => client.getState().phase).toBe('waiting-phone')

    expect(await client.revoke()).toMatchObject({
      phase: 'error',
      error: 'revoke-unconfirmed'
    })
    expect(relay.revokes).toEqual(['aK3'])
    client.dispose()
  })
})

test('toRemoteSession drops correlation and keeps workspace', () => {
  const projection = createInitialAgentProjection({
    sessionId: 's1',
    terminalId: 't1',
    installationId: 'i1',
    adapterId: 'claude',
    name: 'Claude',
    capabilities: {
      thinking: 'none',
      tools: 'none',
      approvals: 'none',
      inputRequests: 'none',
      usage: 'none',
      messages: 'none'
    },
    lastActivityAt: 42
  })
  const record: AgentSessionRecord = {
    sessionId: 's1',
    terminalId: 't1',
    installationId: 'i1',
    adapterId: 'claude',
    name: 'Claude',
    workspace: 'C:/repo',
    runtime: { kind: 'host', platform: 'windows' },
    projection
  }
  const remote = toRemoteSession(record)
  expect(remote).toEqual({
    sessionId: 's1',
    name: 'Claude',
    adapterId: 'claude',
    status: 'idle',
    statusConfidence: 'high',
    pendingAttentionCount: 0,
    activeToolCount: 0,
    lastActivityAt: 42,
    workspace: 'C:/repo'
  })
  expect(remote).not.toHaveProperty('correlation')
  expect(JSON.stringify(remote)).not.toContain('resolvedExecutable')
})

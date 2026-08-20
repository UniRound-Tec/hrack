import { expect, test } from '@playwright/test'
import { createInitialAgentProjection } from '../electron/agents/AgentEventReducer'
import {
  RemoteDesktopClient,
  type RemoteSessionChange
} from '../electron/remote/RemoteDesktopClient'
import { toRemoteSession } from '../electron/remote/toRemoteSession'
import type { AgentSessionRecord } from '../electron/agents/AgentSessionRuntime'
import {
  parseRemoteMessage,
  type RemoteMessage,
  type RemoteSession
} from '../shared/remote-protocol'
import { RemoteTestRelay } from './helpers/remoteTestRelay'

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

  test('replies not-implemented for drive', async () => {
    const client = new RemoteDesktopClient({
      sessions: new MemorySessions(),
      broadcast: () => {}
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
        phone.messages.find((msg) => msg.type === 'not-implemented')
      )
      .toEqual({
        v: 1,
        type: 'not-implemented',
        for: 'drive',
        requestId: 'drive-1'
      })
    phone.ws.close()
    client.dispose()
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

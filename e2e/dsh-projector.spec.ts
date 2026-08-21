import { expect, test } from '@playwright/test'
import { DshProjectionBridge } from '../electron/dsh-host/DshProjectionBridge'
import { DshSessionProjector } from '../electron/dsh-host/DshSessionProjector'

function rpcResponse(value: unknown): Response {
  return new Response(
    JSON.stringify({
      result: {
        ok: true,
        value
      }
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }
  )
}

test('DSH projector recovers when the control plane briefly returns 404', async () => {
  const originalFetch = globalThis.fetch
  const OriginalWebSocket = globalThis.WebSocket
  let sessionListAttempts = 0

  class SilentWebSocket {
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null

    close(): void {}
  }

  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/api/session.list')) {
      sessionListAttempts++
      if (sessionListAttempts === 1) {
        return new Response('not ready', { status: 404 })
      }
      return rpcResponse({
        items: [
          {
            sessionId: 'session-a',
            running: false,
            cwd: 'C:\\workspace',
            updatedAt: 123
          },
          {
            sessionId: 'session-b',
            running: true,
            cwd: 'C:\\workspace',
            updatedAt: 124
          },
          {
            sessionId: 'session-c',
            running: false,
            cwd: 'C:\\workspace',
            updatedAt: 125
          },
          {
            sessionId: 'session-d',
            running: true,
            cwd: 'C:\\workspace',
            updatedAt: 126
          }
        ]
      })
    }
    if (url.endsWith('/api/workspace.list')) {
      return rpcResponse({ archivedSessionIds: [] })
    }
    throw new Error(`unexpected DSH request: ${url}`)
  }
  globalThis.WebSocket = SilentWebSocket as unknown as typeof WebSocket

  const bridge = new DshProjectionBridge({ broadcast: () => undefined })
  const host = {
    getStatus: () => ({
      state: 'ready' as const,
      baseUrl: 'http://dsh.test'
    })
  }
  const projector = new DshSessionProjector(
    host as never,
    bridge
  )

  try {
    projector.activateSlot('slot-1')
    projector.setActiveSession('session-a')
    projector.start()

    await expect
      .poll(
        () =>
          bridge.listActive().map((projection) => ({
            slotId: projection.sessionId,
            adapterSessionId: projection.adapterSessionId
          })),
        { timeout: 1_000, intervals: [25, 50, 100] }
      )
      .toEqual([{ slotId: 'slot-1', adapterSessionId: 'session-a' }])
    expect(sessionListAttempts).toBe(2)

    // Switching inside official DSH replaces this Home-created slot's binding.
    projector.setActiveSession('session-b')
    expect(bridge.listActive()).toMatchObject([
      { sessionId: 'slot-1', adapterSessionId: 'session-b' }
    ])

    // A second Home action creates an independent slot.
    projector.activateSlot('slot-2')
    projector.setActiveSession('session-c')
    expect(bridge.listActive()).toMatchObject([
      { sessionId: 'slot-1', adapterSessionId: 'session-b' },
      { sessionId: 'slot-2', adapterSessionId: 'session-c' }
    ])

    // Returning to slot 1 and switching again cannot affect slot 2.
    projector.activateSlot('slot-1', 'session-b')
    projector.setActiveSession('session-d')
    expect(bridge.listActive()).toMatchObject([
      { sessionId: 'slot-1', adapterSessionId: 'session-d' },
      { sessionId: 'slot-2', adapterSessionId: 'session-c' }
    ])

    projector.unfollow('slot-1')
    expect(bridge.listActive()).toMatchObject([
      { sessionId: 'slot-2', adapterSessionId: 'session-c' }
    ])

    // A stale surface call cannot recreate a locally closed slot.
    projector.activateSlot('slot-1', 'session-d')
    projector.setActiveSession('session-a')
    expect(bridge.listActive()).toMatchObject([
      { sessionId: 'slot-2', adapterSessionId: 'session-c' }
    ])
  } finally {
    projector.stop()
    globalThis.fetch = originalFetch
    globalThis.WebSocket = OriginalWebSocket
  }
})

class ControllableWebSocket {
  static instances: ControllableWebSocket[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null

  constructor(readonly url: string) {
    ControllableWebSocket.instances.push(this)
  }

  close(): void {}

  emit(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ payload }) })
  }
}

function latestSocket(path: string): ControllableWebSocket {
  const found = ControllableWebSocket.instances.filter((socket) =>
    socket.url.endsWith(path)
  )
  const socket = found.at(-1)
  if (!socket) throw new Error(`missing DSH socket ${path}`)
  return socket
}

async function startLiveProjector(items: unknown[]): Promise<{
  bridge: DshProjectionBridge
  projector: DshSessionProjector
  restore: () => void
}> {
  const originalFetch = globalThis.fetch
  const OriginalWebSocket = globalThis.WebSocket
  ControllableWebSocket.instances = []

  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/api/session.list')) {
      return rpcResponse({ items })
    }
    if (url.endsWith('/api/workspace.list')) {
      return rpcResponse({ archivedSessionIds: [] })
    }
    throw new Error(`unexpected DSH request: ${url}`)
  }
  globalThis.WebSocket = ControllableWebSocket as unknown as typeof WebSocket

  const bridge = new DshProjectionBridge({ broadcast: () => undefined })
  const projector = new DshSessionProjector(
    {
      getStatus: () => ({
        state: 'ready' as const,
        baseUrl: 'http://dsh.test'
      })
    } as never,
    bridge
  )
  projector.activateSlot('slot-1')
  projector.setActiveSession('session-a')
  projector.start()
  await expect
    .poll(() => bridge.find('slot-1')?.adapterSessionId, {
      timeout: 1_000,
      intervals: [25, 50, 100]
    })
    .toBe('session-a')
  await expect
    .poll(() => ControllableWebSocket.instances.length, {
      timeout: 1_000,
      intervals: [25, 50, 100]
    })
    .toBeGreaterThanOrEqual(2)

  return {
    bridge,
    projector,
    restore: () => {
      projector.stop()
      globalThis.fetch = originalFetch
      globalThis.WebSocket = OriginalWebSocket
      ControllableWebSocket.instances = []
    }
  }
}

function sessionEvent(
  type: string,
  data: Record<string, unknown>,
  extras: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: 'session/event',
    sessionId: 'session-a',
    event: {
      type,
      seq: 1,
      time: 1,
      data
    },
    ...extras
  }
}

test('DSH projector listens to mux tool calls and marks a finished turn as done', async () => {
  const { bridge, restore } = await startLiveProjector([
    {
      sessionId: 'session-a',
      running: false,
      cwd: 'C:\\workspace',
      updatedAt: 123
    }
  ])

  try {
    expect(bridge.find('slot-1')).toMatchObject({
      status: 'idle',
      activeToolCount: 0,
      detail: undefined
    })

    latestSocket('/api/events.host').emit({
      type: 'host/session-status',
      sessionId: 'session-a',
      running: true
    })
    expect(bridge.find('slot-1')?.status).toBe('working')

    latestSocket('/api/events.mux').emit(
      sessionEvent(
        'tool/call',
        {
          turn: 1,
          step: 1,
          callId: 'call-bash',
          name: 'bash',
          arguments: '{"command":"ls"}'
        },
        {
          view: {
            for: 'call',
            view: { card: 'terminal', title: 'ls' }
          }
        }
      )
    )
    expect(bridge.find('slot-1')).toMatchObject({
      status: 'working',
      detail: '@agent:running-tool:ls',
      activeToolCount: 1,
      capabilities: expect.objectContaining({ tools: 'lifecycle' })
    })

    latestSocket('/api/events.mux').emit(
      sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'call-bash' },
          content: [{ type: 'tool-result', toolCallId: 'call-bash' }]
        }
      })
    )
    expect(bridge.find('slot-1')).toMatchObject({
      status: 'working',
      activeToolCount: 0
    })

    latestSocket('/api/events.mux').emit(
      sessionEvent('turn/end', {
        turn: 1,
        reason: { kind: 'completed' }
      })
    )
    expect(bridge.find('slot-1')).toMatchObject({
      status: 'done',
      detail: '@agent:completed',
      activeToolCount: 0
    })
  } finally {
    restore()
  }
})

test('DSH projector treats a watched running→idle flip as turn completion', async () => {
  const { bridge, restore } = await startLiveProjector([
    {
      sessionId: 'session-a',
      running: false,
      cwd: 'C:\\workspace',
      updatedAt: 123
    }
  ])

  try {
    latestSocket('/api/events.host').emit({
      type: 'host/session-status',
      sessionId: 'session-a',
      running: true
    })
    latestSocket('/api/events.host').emit({
      type: 'host/session-status',
      sessionId: 'session-a',
      running: false
    })
    expect(bridge.find('slot-1')).toMatchObject({
      status: 'done',
      detail: '@agent:completed'
    })
  } finally {
    restore()
  }
})

test('pausing the projector keeps HRack slots across a host restart', async () => {
  const { bridge, projector, restore } = await startLiveProjector([
    {
      sessionId: 'session-a',
      running: false,
      cwd: 'C:\\workspace',
      updatedAt: 123
    }
  ])
  try {
    expect(bridge.find('slot-1')?.adapterSessionId).toBe('session-a')
    projector.pause()
    expect(bridge.find('slot-1')?.adapterSessionId).toBe('session-a')
    projector.start()
    await expect
      .poll(() => bridge.find('slot-1')?.adapterSessionId, {
        timeout: 1_000,
        intervals: [25, 50, 100]
      })
      .toBe('session-a')
  } finally {
    restore()
  }
})

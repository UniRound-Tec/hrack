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

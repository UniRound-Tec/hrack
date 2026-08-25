import { expect, test } from '@playwright/test'
import { DshProjectionBridge } from '../electron/dsh-host/DshProjectionBridge'
import {
  combineRemoteSessionSources,
  dshRemoteSessionSource
} from '../electron/remote/dshRemoteSessionSource'
import type {
  RemoteSessionChange,
  RemoteSessionSource
} from '../electron/remote/RemoteDesktopClient'

function createBridge(): DshProjectionBridge {
  return new DshProjectionBridge({ broadcast: () => undefined })
}

function applyFollowed(
  bridge: DshProjectionBridge,
  input: {
    slotId: string
    officialSessionId: string
    name?: string
    status?: 'idle' | 'working' | 'done'
    detail?: string
    seq?: number
  }
): void {
  bridge.apply({
    slotId: input.slotId,
    adapterSessionId: input.officialSessionId,
    name: input.name ?? 'DSH session',
    status: input.status ?? 'idle',
    detail: input.detail,
    activeToolCount: input.status === 'working' ? 1 : 0,
    lastActivityAt: 123,
    lastSeq: input.seq ?? 1
  })
}

test('DSH remote snapshot contains only sessions followed by HRack', () => {
  const bridge = createBridge()
  const source = dshRemoteSessionSource(bridge)

  // DSH may have arbitrary history, but without an HRack projection the phone
  // receives no DSH row.
  expect(source.list()).toEqual([])

  applyFollowed(bridge, {
    slotId: 'home-slot',
    officialSessionId: 'official-session',
    status: 'working',
    name: 'Phone task'
  })

  expect(source.list()).toEqual([
    expect.objectContaining({
      sessionId: 'official-session',
      adapterId: 'dsh',
      name: 'Phone task',
      status: 'working'
    })
  ])
})

test('DSH remote source streams followed status and removal', () => {
  const bridge = createBridge()
  applyFollowed(bridge, {
    slotId: 'home-slot',
    officialSessionId: 'session-a'
  })
  const changes: RemoteSessionChange[] = []
  const dispose = dshRemoteSessionSource(bridge).subscribe((change) => {
    changes.push(change)
  })

  applyFollowed(bridge, {
    slotId: 'home-slot',
    officialSessionId: 'session-a',
    status: 'done',
    detail: '@agent:completed',
    seq: 2
  })
  bridge.remove('home-slot')
  dispose()

  expect(changes).toMatchObject([
    {
      kind: 'upsert',
      session: { sessionId: 'session-a', adapterId: 'dsh', status: 'done' }
    },
    { kind: 'removed', sessionId: 'session-a' }
  ])
})

test('rebinding an HRack slot replaces the official session on the phone', () => {
  const bridge = createBridge()
  applyFollowed(bridge, {
    slotId: 'home-slot',
    officialSessionId: 'session-a'
  })
  const changes: RemoteSessionChange[] = []
  const dispose = dshRemoteSessionSource(bridge).subscribe((change) => {
    changes.push(change)
  })

  applyFollowed(bridge, {
    slotId: 'home-slot',
    officialSessionId: 'session-b',
    seq: 2
  })
  dispose()

  expect(changes).toMatchObject([
    { kind: 'removed', sessionId: 'session-a' },
    {
      kind: 'upsert',
      session: { sessionId: 'session-b', adapterId: 'dsh' }
    }
  ])
})

test('combined remote source exposes CLI and followed DSH sessions', () => {
  const listeners = new Set<(change: RemoteSessionChange) => void>()
  const cli: RemoteSessionSource = {
    list: () => [
      {
        sessionId: 'cli-session',
        name: 'Codex',
        adapterId: 'codex',
        status: 'idle',
        statusConfidence: 'high',
        pendingAttentionCount: 0,
        activeToolCount: 0,
        lastActivityAt: 1
      }
    ],
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const bridge = createBridge()
  applyFollowed(bridge, {
    slotId: 'home-slot',
    officialSessionId: 'dsh-session'
  })
  const combined = combineRemoteSessionSources(
    cli,
    dshRemoteSessionSource(bridge)
  )

  expect(combined.list().map((session) => session.sessionId)).toEqual([
    'cli-session',
    'dsh-session'
  ])
})

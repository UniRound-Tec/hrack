import type { RemoteSession } from '../../shared/remote-protocol'
import type { AgentSessionProjection } from '../../shared/agent-events'
import type { DshProjectionBridge } from '../dsh-host/DshProjectionBridge'
import type {
  RemoteSessionChange,
  RemoteSessionSource
} from './RemoteDesktopClient'

/**
 * The phone mirrors HRack's followed DSH projections. DSH session.list is only
 * bootstrap state for those projections and must never become a phone-side
 * history directory.
 */
function toRemoteDshSession(
  projection: AgentSessionProjection
): RemoteSession {
  const sessionId = projection.adapterSessionId
  if (!sessionId) throw new Error('DSH projection has no official session id')
  const session: RemoteSession = {
    sessionId,
    name: projection.name ?? sessionId,
    adapterId: 'dsh',
    status: projection.status,
    statusConfidence: projection.statusConfidence,
    pendingAttentionCount: projection.pendingAttentionCount,
    activeToolCount: projection.activeToolCount,
    lastActivityAt: projection.lastActivityAt
  }
  if (projection.detail) session.detail = projection.detail
  return session
}

export function dshRemoteSessionSource(
  bridge: DshProjectionBridge
): RemoteSessionSource {
  return {
    list: () => {
      const followed = new Map<string, RemoteSession>()
      for (const projection of bridge.listActive()) {
        if (!projection.adapterSessionId) continue
        const session = toRemoteDshSession(projection)
        followed.set(session.sessionId, session)
      }
      return [...followed.values()]
    },
    subscribe: (listener) => {
      const slotBindings = new Map<string, string>()
      for (const projection of bridge.listActive()) {
        if (projection.adapterSessionId) {
          slotBindings.set(projection.sessionId, projection.adapterSessionId)
        }
      }
      return bridge.subscribe((projection) => {
        const slotId = projection.sessionId
        const previous = slotBindings.get(slotId)
        const next =
          projection.status === 'exited'
            ? undefined
            : projection.adapterSessionId

        if (next) slotBindings.set(slotId, next)
        else slotBindings.delete(slotId)

        if (
          previous &&
          previous !== next &&
          ![...slotBindings.values()].includes(previous)
        ) {
          listener({ kind: 'removed', sessionId: previous })
        }
        if (next) {
          listener({ kind: 'upsert', session: toRemoteDshSession(projection) })
        }
      })
    }
  }
}

export function combineRemoteSessionSources(
  ...sources: readonly RemoteSessionSource[]
): RemoteSessionSource {
  return {
    list: () => {
      const sessions = new Map<string, RemoteSession>()
      for (const source of sources) {
        for (const session of source.list()) {
          sessions.set(session.sessionId, session)
        }
      }
      return [...sessions.values()]
    },
    subscribe: (listener: (change: RemoteSessionChange) => void) => {
      const disposers = sources.map((source) => source.subscribe(listener))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }
  }
}

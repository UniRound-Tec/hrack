import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { AgentSessionProjection } from '../../shared/agent-events'
import {
  type SessionStatus
} from '../app/sessionStatus'
import { getStrings } from '../app/i18n'
import { renderAgentDetail } from '../app/agentDetail'
import { useSettingsStore } from './settingsStore'

export type SessionKind = 'pty' | 'dsh'

export interface SessionEntry {
  /** Vibing-owned stable identity used by navigation and presentation. */
  sessionId: string
  /** Adapter-owned session identity, e.g. the official DSH session id. */
  adapterSessionId?: string
  terminalId: string
  adapterId: string
  installationId?: string
  kind?: SessionKind
  name: string
  status: SessionStatus
  detail?: string
  lastActivityAt: number
  /** renderer 恢复竞态保护；仅比较主进程投影，不参与 UI。 */
  projectionSeq?: number
}

export function sessionKindOf(
  session: Pick<SessionEntry, 'kind' | 'adapterId' | 'terminalId'>
): SessionKind {
  if (session.kind === 'dsh' || session.adapterId === 'dsh') return 'dsh'
  return session.terminalId.startsWith('dsh:') ? 'dsh' : 'pty'
}

type SessionPatch = Partial<
  Omit<SessionEntry, 'sessionId' | 'terminalId'>
>

export interface SessionsState {
  sessions: SessionEntry[]
  /** 已关闭会话的展示墓碑：主进程投影到达时不再复活。 */
  closedSessionIds: string[]
  addSession(session: SessionEntry): void
  upsertSessions(sessions: readonly SessionEntry[]): void
  applyProjection(projection: AgentSessionProjection): void
  updateSession(sessionId: string, patch: SessionPatch): void
  markExited(sessionId: string, exitCode: number | undefined, at?: number): void
  /** DSH-only local unfollow: remove presentation without a permanent tombstone. */
  unfollowSession(sessionId: string): void
  removeSession(sessionId: string): void
  removeSessions(sessionIds: readonly string[]): void
}

function mergeSessions(
  current: readonly SessionEntry[],
  incoming: readonly SessionEntry[]
): SessionEntry[] {
  const merged = new Map(
    current.map((session) => [session.sessionId, session])
  )
  for (const session of incoming) {
    merged.set(session.sessionId, {
      ...session,
      kind: sessionKindOf(session)
    })
  }
  return [...merged.values()]
}

export function createSessionsStore(): UseBoundStore<
  StoreApi<SessionsState>
> {
  return create<SessionsState>((set) => ({
    sessions: [],
    closedSessionIds: [],
    addSession: (session) =>
      set((state) => ({
        sessions: mergeSessions(state.sessions, [session])
      })),
    upsertSessions: (sessions) =>
      set((state) => ({
        sessions: mergeSessions(state.sessions, sessions)
      })),
    // 主进程投影是唯一权威；renderer 只 upsert 展示副本。
    // 已关闭（墓碑）的会话不复活；已存在的条目保留用户重命名。
    applyProjection: (projection) =>
      set((state) => {
        if (projection.adapterId === 'dsh' && projection.status === 'exited') {
          return {
            sessions: state.sessions.filter(
              (session) => session.sessionId !== projection.sessionId
            )
          }
        }
        if (state.closedSessionIds.includes(projection.sessionId)) return state
        const existing = state.sessions.find(
          (session) => session.sessionId === projection.sessionId
        )
        if (
          existing?.projectionSeq !== undefined &&
          projection.lastSeq <= existing.projectionSeq
        ) {
          return state
        }
        const kind = sessionKindOf({
          kind: existing?.kind ?? 'pty',
          adapterId: projection.adapterId,
          terminalId: projection.terminalId
        })
        const entry: SessionEntry = {
          sessionId: projection.sessionId,
          adapterSessionId:
            projection.adapterSessionId ?? existing?.adapterSessionId,
          terminalId: projection.terminalId,
          adapterId: projection.adapterId,
          installationId: projection.installationId,
          kind,
          name: projection.name ?? existing?.name ?? 'Session',
          status: projection.status,
          detail: renderAgentDetail(
            projection.detail,
            getStrings(useSettingsStore.getState().language)
          ),
          lastActivityAt: projection.lastActivityAt,
          projectionSeq: projection.lastSeq
        }
        return {
          sessions: mergeSessions(state.sessions, [entry])
        }
      }),
    updateSession: (sessionId, patch) =>
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.sessionId === sessionId
            ? { ...session, ...patch }
            : session
        )
      })),
    markExited: (sessionId, exitCode, at = Date.now()) =>
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.sessionId === sessionId
            ? {
                ...session,
                status: 'exited',
                detail: getStrings(
                  useSettingsStore.getState().language
                ).sessionStatus.exitedDetail(exitCode),
                lastActivityAt: at
              }
            : session
          )
      })),
    unfollowSession: (sessionId) =>
      set((state) => ({
        sessions: state.sessions.filter(
          (session) => session.sessionId !== sessionId
        ),
        closedSessionIds: state.closedSessionIds.filter((id) => id !== sessionId)
      })),
    removeSession: (sessionId) =>
      set((state) => ({
        sessions: state.sessions.filter(
          (session) => session.sessionId !== sessionId
        ),
        closedSessionIds: [...state.closedSessionIds, sessionId]
      })),
    removeSessions: (sessionIds) => {
      const ids = new Set(sessionIds)
      set((state) => ({
        sessions: state.sessions.filter(
          (session) => !ids.has(session.sessionId)
        ),
        closedSessionIds: [
          ...state.closedSessionIds,
          ...sessionIds.filter(
            (sessionId) => !state.closedSessionIds.includes(sessionId)
          )
        ]
      }))
    }
  }))
}

export const useSessionsStore = createSessionsStore()

import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { AgentSessionProjection } from '../../shared/agent-events'
import {
  type SessionStatus
} from '../app/sessionStatus'
import { getStrings } from '../app/i18n'
import { renderAgentDetail } from '../app/agentDetail'
import { useSettingsStore } from './settingsStore'

export interface SessionEntry {
  sessionId: string
  terminalId: string
  adapterId: string
  installationId?: string
  name: string
  status: SessionStatus
  detail?: string
  lastActivityAt: number
  /** renderer 恢复竞态保护；仅比较主进程投影，不参与 UI。 */
  projectionSeq?: number
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
  removeSession(sessionId: string): void
  removeSessions(sessionIds: readonly string[]): void
}

function sortByRecentActivity(
  sessions: readonly SessionEntry[]
): SessionEntry[] {
  return [...sessions].sort(
    (left, right) =>
      right.lastActivityAt - left.lastActivityAt ||
      left.sessionId.localeCompare(right.sessionId)
  )
}

function mergeSessions(
  current: readonly SessionEntry[],
  incoming: readonly SessionEntry[]
): SessionEntry[] {
  const merged = new Map(
    current.map((session) => [session.sessionId, session])
  )
  for (const session of incoming) {
    merged.set(session.sessionId, { ...session })
  }
  return sortByRecentActivity([...merged.values()])
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
        const entry: SessionEntry = {
          sessionId: projection.sessionId,
          terminalId: projection.terminalId,
          adapterId: projection.adapterId,
          installationId: projection.installationId,
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
        sessions: sortByRecentActivity(
          state.sessions.map((session) =>
            session.sessionId === sessionId
              ? { ...session, ...patch }
              : session
          )
        )
      })),
    markExited: (sessionId, exitCode, at = Date.now()) =>
      set((state) => ({
        sessions: sortByRecentActivity(
          state.sessions.map((session) =>
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
        )
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

import { create, type StoreApi, type UseBoundStore } from 'zustand'
import {
  type SessionStatus
} from '../app/sessionStatus'
import { strings } from '../app/strings'

export interface SessionEntry {
  sessionId: string
  terminalId: string
  adapterId: string
  name: string
  status: SessionStatus
  detail?: string
  lastActivityAt: number
}

type SessionPatch = Partial<
  Omit<SessionEntry, 'sessionId' | 'terminalId'>
>

export interface SessionsState {
  sessions: SessionEntry[]
  addSession(session: SessionEntry): void
  upsertSessions(sessions: readonly SessionEntry[]): void
  updateSession(sessionId: string, patch: SessionPatch): void
  markExited(sessionId: string, exitCode: number, at?: number): void
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
    addSession: (session) =>
      set((state) => ({
        sessions: mergeSessions(state.sessions, [session])
      })),
    upsertSessions: (sessions) =>
      set((state) => ({
        sessions: mergeSessions(state.sessions, sessions)
      })),
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
                  detail: strings.sessionStatus.exitedDetail(exitCode),
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
        )
      })),
    removeSessions: (sessionIds) => {
      const ids = new Set(sessionIds)
      set((state) => ({
        sessions: state.sessions.filter(
          (session) => !ids.has(session.sessionId)
        )
      }))
    }
  }))
}

export const useSessionsStore = createSessionsStore()

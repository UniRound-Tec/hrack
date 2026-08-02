import type {
  AllTimeStats,
  HistoryEvent,
  HistoryEventKind
} from '../../shared/ipc-contract'
import {
  type SessionStatus
} from './sessionStatus'
import { strings } from './strings'
import {
  useSessionsStore,
  type SessionEntry,
  type SessionsState
} from '../state/sessionsStore'
import type { StoreApi } from 'zustand'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MOCK_SESSION_PREFIX = 'mock:session:'

const sessionFixtures: readonly {
  adapterId: string
  status: SessionStatus
  age: number
}[] = [
  { adapterId: 'codex', status: 'working', age: 0 },
  { adapterId: 'claude-code', status: 'working', age: MINUTE },
  { adapterId: 'codex', status: 'needs-you', age: MINUTE + 1 },
  { adapterId: 'aider', status: 'needs-you', age: 3 * MINUTE },
  { adapterId: 'gemini', status: 'done', age: 10 * MINUTE },
  { adapterId: 'codex', status: 'error', age: 18 * MINUTE },
  { adapterId: 'opencode', status: 'error', age: 42 * MINUTE },
  { adapterId: 'claude-code', status: 'needs-you', age: HOUR },
  { adapterId: 'cursor-agent', status: 'needs-you', age: HOUR + 1 },
  { adapterId: 'claude-code', status: 'done', age: HOUR + 2 },
  { adapterId: 'gemini', status: 'error', age: 2 * HOUR },
  { adapterId: 'codex', status: 'needs-you', age: 3 * HOUR },
  { adapterId: 'aider', status: 'idle', age: DAY },
  { adapterId: 'opencode', status: 'needs-you', age: DAY + 1 },
  { adapterId: 'claude-code', status: 'error', age: 2 * DAY },
  { adapterId: 'warp-agent', status: 'exited', age: 2 * DAY + 1 },
  { adapterId: 'continue', status: 'error', age: 7 * DAY }
]

const historyFixtures: readonly {
  kind: HistoryEventKind
  adapterId: string
  age: number
}[] = [
  { kind: 'tool_call', adapterId: 'codex', age: 2 * MINUTE },
  { kind: 'tool_call', adapterId: 'claude-code', age: 8 * MINUTE },
  { kind: 'approved', adapterId: 'aider', age: 15 * MINUTE },
  { kind: 'tool_call', adapterId: 'cursor-agent', age: 32 * MINUTE },
  { kind: 'completed', adapterId: 'gemini', age: HOUR },
  { kind: 'tool_call', adapterId: 'opencode', age: HOUR + 1 },
  { kind: 'message', adapterId: 'codex', age: 2 * HOUR },
  { kind: 'tool_call', adapterId: 'claude-code', age: DAY }
]

export const mockAllTimeStats: AllTimeStats = {
  sessions: 1_284,
  toolCalls: 9_632,
  blocked: 156,
  approvals: 412
}

export function createMockSessions(now = Date.now()): SessionEntry[] {
  return sessionFixtures.map((fixture, index) => {
    const copy = strings.mock.sessions[index]
    const suffix = String(index + 1).padStart(2, '0')
    return {
      sessionId: `${MOCK_SESSION_PREFIX}${suffix}`,
      terminalId: `mock:terminal:${suffix}`,
      adapterId: fixture.adapterId,
      name: copy.name,
      status: fixture.status,
      detail: copy.detail,
      lastActivityAt: now - fixture.age
    }
  })
}

export function createMockHistoryEvents(now = Date.now()): HistoryEvent[] {
  return historyFixtures.map((fixture, index) => ({
    id: `mock:history:${index + 1}`,
    kind: fixture.kind,
    adapterId: fixture.adapterId,
    occurredAt: now - fixture.age,
    title: strings.mock.history[index].title,
    detail: strings.mock.history[index].detail
  }))
}

export interface MockEnvironment {
  dev: boolean
  e2e: boolean
}

export function isMockSessionsEnabled(environment: MockEnvironment): boolean {
  return environment.dev || environment.e2e
}

export interface MockSessionsProviderOptions {
  enabled?: boolean
  intervalMs?: number
  now?: () => number
  store?: StoreApi<SessionsState>
}

/**
 * Inject prototype data only in development/E2E. The timer touches one live
 * fixture at a time so consumers exercise both re-sorting and status updates.
 */
export function startMockSessionsProvider(
  options: MockSessionsProviderOptions = {}
): () => void {
  const enabled = options.enabled ?? false
  if (!enabled) return () => {}

  const store = options.store ?? useSessionsStore
  const now = options.now ?? Date.now
  const sessions = createMockSessions(now())
  const mockIds = sessions.map((session) => session.sessionId)
  store.getState().upsertSessions(sessions)

  let tick = 0
  const timer = setInterval(() => {
    const sessionId = mockIds[tick % 2]
    const working = tick % 4 !== 3
    store.getState().updateSession(sessionId, {
      status: working ? 'working' : 'idle',
      lastActivityAt: now()
    })
    tick++
  }, Math.max(1_000, options.intervalMs ?? 30_000))

  return () => {
    clearInterval(timer)
    store.getState().removeSessions(mockIds)
  }
}

let stopRuntimeProvider: (() => void) | null = null

/** Runtime switch used by bootstrap and the dev/E2E shell bridge. */
export function setRuntimeMockSessions(enabled: boolean): void {
  stopRuntimeProvider?.()
  stopRuntimeProvider = enabled
    ? startMockSessionsProvider({ enabled: true })
    : null
}

export function stopRuntimeMockSessions(): void {
  stopRuntimeProvider?.()
  stopRuntimeProvider = null
}

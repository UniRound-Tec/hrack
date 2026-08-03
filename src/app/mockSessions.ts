import type {
  AllTimeStats,
  HistoryEvent,
  HistoryEventKind
} from '../../shared/ipc-contract'
import {
  type SessionStatus
} from './sessionStatus'
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

/**
 * 演示文案固定 zh-CN（dev/E2E 专用，不翻译、不参与字体子集扫描），
 * M5.c 起与 i18n 模块解耦。
 */
const mockSessionCopy: readonly { name: string; detail: string }[] = [
  { name: 'Codex', detail: '运行 pnpm test --filter demo' },
  { name: 'Claude Code', detail: '思考中：检索 ipc-contract 引用' },
  { name: 'Codex', detail: '等待批准：写入 src/main.ts' },
  { name: 'Aider', detail: '等待确认：提交 4 个文件的改动' },
  { name: 'Gemini CLI', detail: '完成：生成 release notes' },
  { name: 'Codex', detail: '出错：tests/ipc.test.ts 3 个用例失败' },
  { name: 'OpenCode', detail: '出错：electron-vite build 退出码 1' },
  { name: 'Claude Code', detail: '等待批准：删除旧的迁移脚本' },
  { name: 'Cursor Agent', detail: '等待确认：重构 sidebar 布局' },
  { name: 'Claude Code', detail: '完成：补齐 tabs e2e 断言' },
  { name: 'Gemini CLI', detail: '出错：API rate limit exceeded' },
  { name: 'Codex', detail: '等待批准：更新 package.json 依赖' },
  { name: 'Aider', detail: '空闲：等待下一个 prompt' },
  { name: 'OpenCode', detail: '等待确认：迁移到 Tailwind v4' },
  { name: 'Claude Code', detail: '出错：eslint 12 个问题未修复' },
  { name: 'Warp Agent', detail: '已退出：exit code 0' },
  { name: 'Continue', detail: '出错：无法连接本地模型服务' }
]

const mockHistoryCopy: readonly { title: string; detail: string }[] = [
  { title: 'tool_call · Write', detail: 'src/App.tsx · 写入 48 行' },
  { title: 'tool_call · Bash', detail: 'pnpm test --filter demo' },
  { title: '已批准', detail: '提交 4 个文件的改动' },
  { title: 'tool_call · Read', detail: 'src/components/TrueFocus.jsx' },
  { title: '会话完成', detail: '生成 release notes · 成功' },
  { title: 'tool_call · Edit', detail: 'vite.config.ts · patch' },
  { title: 'assistant', detail: '已完成 sidebar 布局重构，请 review' },
  { title: 'tool_call · Glob', detail: '**/*.{ts,tsx} · 126 files' }
]

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
    const copy = mockSessionCopy[index]
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
    title: mockHistoryCopy[index].title,
    detail: mockHistoryCopy[index].detail
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

/**
 * Agent Observer 契约（PLAN-S1 §4–§6, §9.1）——
 * 主进程 / preload / renderer 三方共享的 AgentEvent、能力、投影与 IPC 类型。
 *
 * 核心约束：Agent Event 是事实，SessionStatus 是事实的投影，
 * HistoryEvent 是事实的低敏摘要。三者不能合并成一个可选字段大对象。
 */

import type { CliLaunchSelection } from './ipc-contract'

// ───── AgentEvent 统一事件模型（PLAN-S1 §4）─────────────

export type AgentEventSource =
  | 'native-stream'
  | 'jsonl'
  | 'rpc'
  | 'acp'
  | 'hook'
  | 'transcript'
  | 'lifecycle'
  | 'fixture'

export interface AgentEventBase {
  /** Runtime 生成的全局去重 id。 */
  id: string
  sessionId: string
  adapterId: string
  installationId: string
  /** Runtime 分配的每 Session 单调序号；排序只认 seq，不认时间戳。 */
  seq: number
  /** 主进程接收/确认时间。 */
  occurredAt: number
  source: AgentEventSource
  /** 原生协议稳定 id；重复 delivery（hook 重放 / RPC reconnect）用它去重。 */
  nativeId?: string
  /** 有界诊断字段，不参与状态逻辑。 */
  nativeType?: string
}

export type EventOf<K extends string, P> = AgentEventBase & {
  kind: K
  payload: P
}

export interface SessionIdlePayload {
  since: number
  reason: 'protocol-idle' | 'observer-silence' | 'scheduled-wakeup'
  confidence: 'high' | 'low'
}

export interface ToolStartedPayload {
  callId: string
  turnId?: string
  name: string
  category?: 'read' | 'edit' | 'shell' | 'search' | 'network' | 'mcp' | 'other'
}

export interface ToolProgressPayload {
  callId: string
  summary?: string
}

export interface ToolCompletedPayload {
  callId: string
  durationMs?: number
}

export interface ToolFailedPayload {
  callId: string
  durationMs?: number
  message: string
}

export interface ApprovalRequestedPayload {
  requestId: string
  callId?: string
  category?: 'tool' | 'command' | 'file-change' | 'network' | 'other'
  summary?: string
}

export interface ApprovalResolvedPayload {
  requestId: string
  decision: 'approved' | 'denied' | 'cancelled'
}

export interface InputRequestedPayload {
  requestId: string
  prompt?: string
}

export interface InputResolvedPayload {
  requestId: string
}

export interface UsagePayload {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  contextTokens?: number
  contextWindow?: number
  costUsd?: number
  scope: 'turn' | 'session'
}

export type AgentEvent =
  | EventOf<'session.started', { cwd?: string }>
  | EventOf<'session.idle', SessionIdlePayload>
  | EventOf<'session.exited', { exitCode?: number; signal?: number }>
  | EventOf<'turn.started', { turnId: string }>
  | EventOf<
      'turn.completed',
      { turnId: string; outcome?: 'completed' | 'cancelled' }
    >
  | EventOf<'turn.failed', { turnId: string; message: string }>
  | EventOf<'thinking.started', { turnId: string }>
  | EventOf<'thinking.completed', { turnId: string; summary?: string }>
  | EventOf<
      'message.completed',
      { turnId?: string; role: 'assistant' | 'system'; summary?: string }
    >
  | EventOf<'tool.started', ToolStartedPayload>
  | EventOf<'tool.progress', ToolProgressPayload>
  | EventOf<'tool.completed', ToolCompletedPayload>
  | EventOf<'tool.failed', ToolFailedPayload>
  | EventOf<'approval.requested', ApprovalRequestedPayload>
  | EventOf<'approval.resolved', ApprovalResolvedPayload>
  | EventOf<'input.requested', InputRequestedPayload>
  | EventOf<'input.resolved', InputResolvedPayload>
  | EventOf<'usage.updated', UsagePayload>
  | EventOf<
      'activity.caption',
      { text: string; confidence: 'low'; outputTokens?: number }
    >
  | EventOf<'observer.degraded', {
      reason: string
      remaining: ObserverCapabilities
    }>

export type AgentEventKind = AgentEvent['kind']
export type AgentEventPayload = AgentEvent['payload']

// ───── 能力声明（PLAN-S1 §5）─────────────

/**
 * 能力是本次会话真实启用的能力，不是品牌宣传能力；
 * 随安装版本与运行方式变化。
 */
export interface ObserverCapabilities {
  thinking: 'none' | 'phase' | 'summary'
  tools: 'none' | 'lifecycle' | 'progress'
  approvals: 'none' | 'structured'
  inputRequests: 'none' | 'structured'
  usage: 'none' | 'tokens' | 'context' | 'tokens-and-context'
  messages: 'none' | 'summary'
}

export const NO_OBSERVER_CAPABILITIES: ObserverCapabilities = {
  thinking: 'none',
  tools: 'none',
  approvals: 'none',
  inputRequests: 'none',
  usage: 'none',
  messages: 'none'
}

export function capabilitiesHaveSemantics(
  capabilities: ObserverCapabilities
): boolean {
  return (
    capabilities.thinking !== 'none' ||
    capabilities.tools !== 'none' ||
    capabilities.approvals !== 'none' ||
    capabilities.inputRequests !== 'none' ||
    capabilities.usage !== 'none' ||
    capabilities.messages !== 'none'
  )
}

// ───── 六态投影（PLAN-S1 §6.1）─────────────

export type AgentSessionStatus =
  | 'working'
  | 'needs-you'
  | 'done'
  | 'error'
  | 'idle'
  | 'exited'

export type AgentStatusConfidence = 'high' | 'low'

export type AgentObserverHealth =
  | 'unconfirmed'
  | 'healthy'
  | 'stale'
  | 'lifecycle-only'

/**
 * 归约器内部关联状态（PLAN-S1 §6.2）：并行 tool、多 pending request、
 * idle override、退出终态的事实集合。UI 不得依赖此字段展示。
 */
export interface AgentCorrelationState {
  exited: boolean
  exitCode?: number
  /** callId → 关联事实（只用于状态归约与去重）。 */
  activeTools: Record<string, { name: string; turnId?: string }>
  lastToolCallId?: string
  pendingApprovals: Record<
    string,
    { category?: string; summary?: string }
  >
  pendingInputs: Record<string, { prompt?: string }>
  lowConfidenceIdle: boolean
  highConfidenceIdle: boolean
  lastTurnId?: string
  lastTurnOutcome?: 'completed' | 'cancelled' | 'failed'
  turnFailedMessage?: string
  thinkingActive: boolean
  /** 低置信度实时字幕与最后一次可展示内容；不参与六态推导。 */
  liveCaption?: string
  latestDetail?: string
  latestOutputTokens?: number
  usageTurn?: UsagePayload
  usageSession?: UsagePayload
}

export interface AgentSessionProjection {
  sessionId: string
  terminalId: string
  installationId: string
  adapterId: string
  /** 启动时用户命名的显示名称（renderer 可保留自己的重命名）。 */
  name?: string
  status: AgentSessionStatus
  statusConfidence: AgentStatusConfidence
  observerHealth: AgentObserverHealth
  detail?: string
  activeTurnId?: string
  activeToolCount: number
  pendingAttentionCount: number
  usage?: UsagePayload
  lastActivityAt: number
  capabilities: ObserverCapabilities
  lastSeq: number
  correlation: AgentCorrelationState
}

// ───── Runtime 外部接口（PLAN-S1 §3.2, §9.1）─────────────

export interface StartAgentSession {
  terminalId: string
  selection: CliLaunchSelection
  /** 显示名称；用于历史标题与投影恢复。 */
  name?: string
  cols: number
  rows: number
}

export interface StartedAgentSession {
  sessionId: string
  terminalId: string
  ptyId: string
  installationId: string
  adapterId: string
  capabilities: ObserverCapabilities
  projection: AgentSessionProjection
}

export interface PublishAgentCaption {
  terminalId: string
  text: string
  outputTokens?: number
}

export interface AgentApi {
  start(input: StartAgentSession): Promise<StartedAgentSession>
  stop(sessionId: string): Promise<void>
  rename(
    sessionId: string,
    name: string
  ): Promise<AgentSessionProjection | null>
  publishCaption(input: PublishAgentCaption): Promise<void>
  listActive(): Promise<AgentSessionProjection[]>
  onEvents(cb: (events: AgentEvent[]) => void): () => void
  onProjection(cb: (projection: AgentSessionProjection) => void): () => void
}

export const AgentInvokeChannel = {
  Start: 'agent:start',
  Stop: 'agent:stop',
  Rename: 'agent:rename',
  PublishCaption: 'agent:publish-caption',
  ListActive: 'agent:list-active'
} as const

export const AgentEventChannel = {
  Events: 'agent:events',
  Projection: 'agent:projection'
} as const

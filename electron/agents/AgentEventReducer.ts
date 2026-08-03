/**
 * 主进程权威投影的纯函数归约器（PLAN-S1 §6）。
 *
 * `reduceAgentSession(previous, event)` 把事件事实投影成六态 Session。
 * 归约器无副作用：不读时钟（时间来自事件 occurredAt）、不写文件、
 * 不依赖 Adapter 私有状态。乱序、重复、并行 tool、多 approval 与退出
 * 终态都在这里被确定性地处理。
 */

import type {
  AgentCorrelationState,
  AgentEvent,
  AgentObserverHealth,
  AgentSessionProjection,
  AgentSessionStatus,
  AgentStatusConfidence,
  ObserverCapabilities,
  UsagePayload
} from '../../shared/agent-events'
import { capabilitiesHaveSemantics } from '../../shared/agent-events'

// ───── detail 的 i18n 标记（renderer 负责最终语言显示）─────────────

export const AGENT_DETAIL_THINKING = '@agent:thinking'
export const AGENT_DETAIL_WAITING_APPROVAL = '@agent:waiting-approval'
export const AGENT_DETAIL_WAITING_INPUT = '@agent:waiting-input'
export const AGENT_DETAIL_EXITED = '@agent:exited'

export function agentDetailExited(exitCode?: number): string {
  return exitCode === undefined
    ? AGENT_DETAIL_EXITED
    : `${AGENT_DETAIL_EXITED}:${exitCode}`
}

export function emptyCorrelation(): AgentCorrelationState {
  return {
    exited: false,
    activeTools: {},
    pendingApprovals: {},
    pendingInputs: {},
    lowConfidenceIdle: false,
    highConfidenceIdle: false,
    thinkingActive: false
  }
}

export interface InitialAgentProjectionInput {
  sessionId: string
  terminalId: string
  installationId: string
  adapterId: string
  name?: string
  capabilities: ObserverCapabilities
  lastActivityAt: number
}

export function createInitialAgentProjection(
  input: InitialAgentProjectionInput
): AgentSessionProjection {
  return {
    sessionId: input.sessionId,
    terminalId: input.terminalId,
    installationId: input.installationId,
    adapterId: input.adapterId,
    name: input.name,
    status: 'working',
    statusConfidence: 'high',
    observerHealth: 'unconfirmed',
    activeTurnId: undefined,
    activeToolCount: 0,
    pendingAttentionCount: 0,
    usage: undefined,
    lastActivityAt: input.lastActivityAt,
    capabilities: input.capabilities,
    lastSeq: 0,
    correlation: emptyCorrelation()
  }
}

/**
 * 状态优先级（PLAN-S1 §6.2）：首个匹配者胜出。
 *
 * - 显式（高置信度）idle 是「无活动」的新事实，覆盖 done/error；
 *   但不能覆盖 needs-you / exited，也不会抢在活动 turn 之前（协议
 *   不会在 turn 进行中发 idle）。
 * - 会话开放但没有其它事实（CLI 启动中）→ working。
 */
function deriveStatus(
  correlation: AgentCorrelationState
): { status: AgentSessionStatus; confidence: AgentStatusConfidence } {
  if (correlation.exited) return { status: 'exited', confidence: 'high' }

  const pendingAttention =
    Object.keys(correlation.pendingApprovals).length +
    Object.keys(correlation.pendingInputs).length
  if (pendingAttention > 0) return { status: 'needs-you', confidence: 'high' }

  if (correlation.lowConfidenceIdle) {
    return { status: 'idle', confidence: 'low' }
  }

  const activeToolCount = Object.keys(correlation.activeTools).length
  const hasActiveTurn =
    correlation.lastTurnId !== undefined &&
    correlation.lastTurnOutcome === undefined
  if (correlation.thinkingActive || activeToolCount > 0 || hasActiveTurn) {
    return { status: 'working', confidence: 'high' }
  }

  if (correlation.highConfidenceIdle) {
    return { status: 'idle', confidence: 'high' }
  }

  if (correlation.lastTurnOutcome === 'failed') {
    return { status: 'error', confidence: 'high' }
  }
  if (correlation.lastTurnOutcome === 'completed') {
    return { status: 'done', confidence: 'high' }
  }
  return { status: 'working', confidence: 'high' }
}

/** Detail 生成（PLAN-S1 §6.3）：由公共投影器生成，Adapter 不写任意 UI 文案。 */
function deriveDetail(
  correlation: AgentCorrelationState
): string | undefined {
  if (correlation.thinkingActive) return AGENT_DETAIL_THINKING

  const lastToolCallId = correlation.lastToolCallId
  if (lastToolCallId && correlation.activeTools[lastToolCallId]) {
    return correlation.activeTools[lastToolCallId].name
  }

  const approvalIds = Object.keys(correlation.pendingApprovals)
  if (approvalIds.length > 0) {
    const latest = correlation.pendingApprovals[approvalIds[approvalIds.length - 1]]
    return latest.summary ?? AGENT_DETAIL_WAITING_APPROVAL
  }

  const inputIds = Object.keys(correlation.pendingInputs)
  if (inputIds.length > 0) {
    const latest = correlation.pendingInputs[inputIds[inputIds.length - 1]]
    return latest.prompt ?? AGENT_DETAIL_WAITING_INPUT
  }

  if (correlation.lastTurnOutcome === 'failed') {
    return correlation.turnFailedMessage
  }

  if (correlation.exited) return agentDetailExited(correlation.exitCode)
  return undefined
}

function observerHealthFor(
  previous: AgentObserverHealth,
  capabilities: ObserverCapabilities,
  degraded: boolean
): AgentObserverHealth {
  if (degraded) {
    return capabilitiesHaveSemantics(capabilities) ? 'stale' : 'lifecycle-only'
  }
  if (previous === 'lifecycle-only') return previous
  return capabilitiesHaveSemantics(capabilities) ? 'healthy' : 'lifecycle-only'
}

function mergeUsage(
  target: UsagePayload | undefined,
  update: UsagePayload
): UsagePayload {
  return { ...target, ...update }
}

export function reduceAgentSession(
  previous: AgentSessionProjection,
  event: AgentEvent
): AgentSessionProjection {
  // 每 Session 只接受严格递增的 Runtime seq；旧 delivery/replay 在进入
  // 任何 correlation 或历史投影前即被拒绝。
  if (event.seq <= previous.lastSeq) return previous
  // 退出终态：迟到事件一律忽略（PLAN-S1 §6.2）。
  if (previous.correlation.exited) return previous

  const correlation: AgentCorrelationState = {
    ...previous.correlation,
    activeTools: { ...previous.correlation.activeTools },
    pendingApprovals: { ...previous.correlation.pendingApprovals },
    pendingInputs: { ...previous.correlation.pendingInputs }
  }

  let capabilities = previous.capabilities
  let observerHealth: AgentObserverHealth = previous.observerHealth
  let degraded = false

  switch (event.kind) {
    case 'session.started':
      correlation.exited = false
      break
    case 'session.idle': {
      const { reason, confidence } = event.payload
      if (reason === 'observer-silence' && confidence === 'low') {
        correlation.lowConfidenceIdle = true
        correlation.highConfidenceIdle = false
        observerHealth = 'stale'
      } else {
        correlation.highConfidenceIdle = true
        correlation.lowConfidenceIdle = false
        observerHealth = 'healthy'
      }
      break
    }
    case 'session.exited':
      correlation.exited = true
      correlation.exitCode = event.payload.exitCode
      break
    case 'turn.started': {
      // 高置信度语义事件清除低置信度 idle override（PLAN-S1 §6.2）。
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      correlation.lastTurnId = event.payload.turnId
      correlation.lastTurnOutcome = undefined
      correlation.turnFailedMessage = undefined
      correlation.thinkingActive = false
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'turn.completed': {
      if (event.payload.turnId !== correlation.lastTurnId) break
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      correlation.lastTurnOutcome = event.payload.outcome ?? 'completed'
      correlation.thinkingActive = false
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'turn.failed': {
      if (event.payload.turnId !== correlation.lastTurnId) break
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      correlation.lastTurnOutcome = 'failed'
      correlation.turnFailedMessage = event.payload.message
      correlation.thinkingActive = false
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'thinking.started': {
      if (event.payload.turnId !== correlation.lastTurnId) break
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      correlation.thinkingActive = true
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'thinking.completed': {
      if (event.payload.turnId !== correlation.lastTurnId) break
      correlation.thinkingActive = false
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'message.completed':
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    case 'tool.started': {
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      correlation.activeTools[event.payload.callId] = {
        name: event.payload.name,
        turnId: event.payload.turnId
      }
      correlation.lastToolCallId = event.payload.callId
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'tool.progress': {
      if (!correlation.activeTools[event.payload.callId]) break
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'tool.completed': {
      delete correlation.activeTools[event.payload.callId]
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'tool.failed': {
      // tool failed 不自动令整个 Session 为 error；只终结该 tool。
      delete correlation.activeTools[event.payload.callId]
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'approval.requested': {
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      correlation.pendingApprovals[event.payload.requestId] = {
        category: event.payload.category,
        summary: event.payload.summary
      }
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'approval.resolved': {
      // 只移除自己对应的 request；其余待处理项不受影响。
      delete correlation.pendingApprovals[event.payload.requestId]
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'input.requested': {
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      correlation.pendingInputs[event.payload.requestId] = {
        prompt: event.payload.prompt
      }
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'input.resolved': {
      delete correlation.pendingInputs[event.payload.requestId]
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'usage.updated': {
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      if (event.payload.scope === 'session') {
        correlation.usageSession = mergeUsage(
          correlation.usageSession,
          event.payload
        )
      } else {
        correlation.usageTurn = mergeUsage(correlation.usageTurn, event.payload)
      }
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'observer.degraded': {
      degraded = true
      capabilities = event.payload.remaining
      observerHealth = observerHealthFor(observerHealth, capabilities, true)
      break
    }
  }

  const { status, confidence } = deriveStatus(correlation)
  const activeToolCount = Object.keys(correlation.activeTools).length
  const pendingAttentionCount =
    Object.keys(correlation.pendingApprovals).length +
    Object.keys(correlation.pendingInputs).length

  return {
    ...previous,
    correlation,
    status,
    statusConfidence: confidence,
    observerHealth,
    detail: deriveDetail(correlation),
    activeTurnId: correlation.lastTurnId,
    activeToolCount,
    pendingAttentionCount,
    usage: correlation.usageSession ?? correlation.usageTurn,
    lastActivityAt: Math.max(previous.lastActivityAt, event.occurredAt),
    capabilities,
    lastSeq: event.seq
  }
}

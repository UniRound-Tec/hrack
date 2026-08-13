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
export const AGENT_DETAIL_RUNNING_TOOL = '@agent:running-tool'
export const AGENT_DETAIL_COMPLETED = '@agent:completed'
export const AGENT_DETAIL_ERROR = '@agent:error'
export const AGENT_DETAIL_EXITED = '@agent:exited'
export const AGENT_DETAIL_OBSERVER_DEGRADED = '@agent:observer-degraded'

function detailWithValue(marker: string, value?: string | number): string {
  return value === undefined || value === '' ? marker : `${marker}:${value}`
}

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
    closedToolIds: {},
    closedApprovalIds: {},
    closedInputIds: {},
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
  const correlation = emptyCorrelation()
  // CLI 已经成功启动但尚未收到 prompt，语义上是在等待用户输入。
  correlation.highConfidenceIdle = true
  return {
    sessionId: input.sessionId,
    terminalId: input.terminalId,
    installationId: input.installationId,
    adapterId: input.adapterId,
    name: input.name,
    status: 'idle',
    statusConfidence: 'high',
    observerHealth: 'unconfirmed',
    activeTurnId: undefined,
    activeToolCount: 0,
    pendingAttentionCount: 0,
    usage: undefined,
    lastActivityAt: input.lastActivityAt,
    capabilities: input.capabilities,
    lastSeq: 0,
    correlation
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
  if (
    correlation.lastTurnOutcome === 'completed' ||
    correlation.lastTurnOutcome === 'cancelled'
  ) {
    return { status: 'done', confidence: 'high' }
  }
  return { status: 'working', confidence: 'high' }
}

/** Detail 生成（PLAN-S1 §6.3）：由公共投影器生成，Adapter 不写任意 UI 文案。 */
function deriveDetail(
  correlation: AgentCorrelationState
): string | undefined {
  const approvalIds = Object.keys(correlation.pendingApprovals)
  if (approvalIds.length > 0) {
    const latest = correlation.pendingApprovals[approvalIds[approvalIds.length - 1]]
    return detailWithValue(AGENT_DETAIL_WAITING_APPROVAL, latest.summary)
  }

  const inputIds = Object.keys(correlation.pendingInputs)
  if (inputIds.length > 0) {
    const latest = correlation.pendingInputs[inputIds[inputIds.length - 1]]
    return detailWithValue(AGENT_DETAIL_WAITING_INPUT, latest.prompt)
  }

  const lastToolCallId = correlation.lastToolCallId
  if (lastToolCallId && correlation.activeTools[lastToolCallId]) {
    return detailWithValue(
      AGENT_DETAIL_RUNNING_TOOL,
      correlation.activeTools[lastToolCallId].name
    )
  }

  if (correlation.thinkingActive) {
    return correlation.liveCaption ?? AGENT_DETAIL_THINKING
  }

  if (correlation.lastTurnOutcome === 'failed') {
    return detailWithValue(AGENT_DETAIL_ERROR, correlation.turnFailedMessage)
  }

  if (correlation.exited) return agentDetailExited(correlation.exitCode)
  if (
    correlation.lastTurnOutcome === 'completed' ||
    correlation.lastTurnOutcome === 'cancelled'
  ) {
    return detailWithValue(
      AGENT_DETAIL_COMPLETED,
      correlation.latestOutputTokens
    )
  }
  return (
    correlation.liveCaption ??
    (correlation.observerDegradedReason
      ? detailWithValue(
          AGENT_DETAIL_OBSERVER_DEGRADED,
          correlation.observerDegradedReason
        )
      : undefined) ??
    correlation.latestDetail
  )
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

/**
 * A terminal turn is authoritative: no tool or user-attention request owned by
 * that turn may keep the session working/needs-you if its narrower terminal
 * hook was lost or delivered out of order.
 */
function closeTurnCorrelations(
  correlation: AgentCorrelationState,
  turnId: string
): void {
  for (const [callId, tool] of Object.entries(correlation.activeTools)) {
    if (tool.turnId === turnId) delete correlation.activeTools[callId]
  }
  for (const [requestId, approval] of Object.entries(
    correlation.pendingApprovals
  )) {
    if (approval.turnId === turnId) delete correlation.pendingApprovals[requestId]
  }
  for (const [requestId, input] of Object.entries(correlation.pendingInputs)) {
    if (input.turnId === turnId) delete correlation.pendingInputs[requestId]
  }
  correlation.closedApprovalIds = {}
  correlation.closedInputIds = {}
  correlation.closedToolIds = {}
  if (
    correlation.lastToolCallId &&
    !correlation.activeTools[correlation.lastToolCallId]
  ) {
    correlation.lastToolCallId = Object.keys(correlation.activeTools).at(-1)
  }
}

function closeRequestsForCall(
  correlation: AgentCorrelationState,
  callId: string,
  turnId: string
): void {
  for (const [requestId, approval] of Object.entries(
    correlation.pendingApprovals
  )) {
    if (approval.callId !== callId || approval.turnId !== turnId) continue
    delete correlation.pendingApprovals[requestId]
    correlation.closedApprovalIds[requestId] = true
  }
  for (const [requestId, input] of Object.entries(correlation.pendingInputs)) {
    if (input.callId !== callId || input.turnId !== turnId) continue
    delete correlation.pendingInputs[requestId]
    correlation.closedInputIds[requestId] = true
  }
}

function clearScopedActivity(correlation: AgentCorrelationState): void {
  correlation.activeTools = {}
  correlation.pendingApprovals = {}
  correlation.pendingInputs = {}
  correlation.closedToolIds = {}
  correlation.closedApprovalIds = {}
  correlation.closedInputIds = {}
  correlation.lastToolCallId = undefined
  correlation.lastTurnId = undefined
  correlation.lastTurnOutcome = undefined
  correlation.turnFailedMessage = undefined
  correlation.thinkingActive = false
  correlation.liveCaption = undefined
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
    pendingInputs: { ...previous.correlation.pendingInputs },
    closedToolIds: { ...previous.correlation.closedToolIds },
    closedApprovalIds: { ...previous.correlation.closedApprovalIds },
    closedInputIds: { ...previous.correlation.closedInputIds }
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
        clearScopedActivity(correlation)
        correlation.highConfidenceIdle = true
        correlation.lowConfidenceIdle = false
        observerHealth = 'healthy'
      }
      break
    }
    case 'session.exited':
      clearScopedActivity(correlation)
      correlation.exited = true
      correlation.exitCode = event.payload.exitCode
      break
    case 'turn.started': {
      clearScopedActivity(correlation)
      // 高置信度语义事件清除低置信度 idle override（PLAN-S1 §6.2）。
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      correlation.lastTurnId = event.payload.turnId
      correlation.lastTurnOutcome = undefined
      correlation.turnFailedMessage = undefined
      correlation.thinkingActive = false
      correlation.liveCaption = undefined
      correlation.latestOutputTokens = undefined
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'turn.completed': {
      if (event.payload.turnId !== correlation.lastTurnId) break
      closeTurnCorrelations(correlation, event.payload.turnId)
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      correlation.lastTurnOutcome = event.payload.outcome ?? 'completed'
      correlation.thinkingActive = false
      correlation.liveCaption = undefined
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'turn.failed': {
      if (event.payload.turnId !== correlation.lastTurnId) break
      closeTurnCorrelations(correlation, event.payload.turnId)
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      correlation.lastTurnOutcome = 'failed'
      correlation.turnFailedMessage = event.payload.message
      correlation.thinkingActive = false
      correlation.liveCaption = undefined
      correlation.latestDetail = event.payload.message
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'thinking.started': {
      if (event.payload.turnId !== correlation.lastTurnId) break
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      correlation.thinkingActive = true
      correlation.liveCaption = undefined
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
      const turnId = event.payload.turnId
      if (
        turnId !== correlation.lastTurnId ||
        correlation.lastTurnOutcome !== undefined
      ) {
        break
      }
      if (correlation.closedToolIds[event.payload.callId]) break
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      correlation.activeTools[event.payload.callId] = {
        name: event.payload.name,
        turnId
      }
      correlation.lastToolCallId = event.payload.callId
      correlation.liveCaption = undefined
      correlation.latestDetail = event.payload.name
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'tool.progress': {
      const tool = correlation.activeTools[event.payload.callId]
      if (!tool || event.payload.turnId !== tool.turnId) {
        break
      }
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'tool.completed': {
      const turnId = event.payload.turnId
      if (
        turnId !== correlation.lastTurnId ||
        correlation.lastTurnOutcome !== undefined
      ) {
        break
      }
      delete correlation.activeTools[event.payload.callId]
      correlation.closedToolIds[event.payload.callId] = { turnId }
      closeRequestsForCall(correlation, event.payload.callId, turnId)
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'tool.failed': {
      // tool failed 不自动令整个 Session 为 error；只终结该 tool。
      const turnId = event.payload.turnId
      if (
        turnId !== correlation.lastTurnId ||
        correlation.lastTurnOutcome !== undefined
      ) {
        break
      }
      delete correlation.activeTools[event.payload.callId]
      correlation.closedToolIds[event.payload.callId] = { turnId }
      closeRequestsForCall(correlation, event.payload.callId, turnId)
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'approval.requested': {
      const turnId = event.payload.turnId
      if (
        turnId !== correlation.lastTurnId ||
        correlation.lastTurnOutcome !== undefined
      ) {
        break
      }
      if (correlation.closedApprovalIds[event.payload.requestId]) break
      const closedTool = event.payload.callId
        ? correlation.closedToolIds[event.payload.callId]
        : undefined
      if (closedTool && closedTool.turnId === turnId) {
        correlation.closedApprovalIds[event.payload.requestId] = true
        break
      }
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      correlation.pendingApprovals[event.payload.requestId] = {
        category: event.payload.category,
        summary: event.payload.summary,
        callId: event.payload.callId,
        turnId
      }
      correlation.liveCaption = undefined
      correlation.latestDetail =
        event.payload.summary ?? AGENT_DETAIL_WAITING_APPROVAL
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'approval.resolved': {
      // 只移除自己对应的 request；其余待处理项不受影响。
      delete correlation.pendingApprovals[event.payload.requestId]
      correlation.closedApprovalIds[event.payload.requestId] = true
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'input.requested': {
      const turnId = event.payload.turnId
      if (
        turnId !== correlation.lastTurnId ||
        correlation.lastTurnOutcome !== undefined
      ) {
        break
      }
      if (correlation.closedInputIds[event.payload.requestId]) break
      const closedTool = event.payload.callId
        ? correlation.closedToolIds[event.payload.callId]
        : undefined
      if (closedTool && closedTool.turnId === turnId) {
        correlation.closedInputIds[event.payload.requestId] = true
        break
      }
      correlation.lowConfidenceIdle = false
      correlation.highConfidenceIdle = false
      correlation.pendingInputs[event.payload.requestId] = {
        prompt: event.payload.prompt,
        callId: event.payload.callId,
        turnId
      }
      correlation.liveCaption = undefined
      correlation.latestDetail =
        event.payload.prompt ?? AGENT_DETAIL_WAITING_INPUT
      observerHealth = observerHealthFor(observerHealth, capabilities, false)
      break
    }
    case 'input.resolved': {
      delete correlation.pendingInputs[event.payload.requestId]
      correlation.closedInputIds[event.payload.requestId] = true
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
    case 'activity.caption': {
      correlation.liveCaption = event.payload.text
      correlation.latestDetail = event.payload.text
      if (event.payload.outputTokens !== undefined) {
        correlation.latestOutputTokens = event.payload.outputTokens
      }
      break
    }
    case 'observer.degraded': {
      degraded = true
      capabilities = event.payload.remaining
      correlation.observerDegradedReason = event.payload.reason
      observerHealth = observerHealthFor(observerHealth, capabilities, true)
      break
    }
  }

  // 一条新的、可信的 observer 语义事实即证明通道已恢复；旧降级原因
  // 不应继续覆盖空闲字幕。lifecycle-only 不会被普通 PTY 生命周期伪装成恢复。
  if (event.kind !== 'observer.degraded' && observerHealth === 'healthy') {
    correlation.observerDegradedReason = undefined
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

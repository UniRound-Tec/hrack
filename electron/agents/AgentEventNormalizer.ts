/**
 * Adapter 事件输入校验与规范化（PLAN-S1 §8.3, P0-2）。
 *
 * Adapter 输出一律视为不可信输入：
 * - 所有 id/name/summary/message 有长度上限并清理 NUL/控制字符；
 * - usage 数值必须有限、非负，并设合理上限；
 * - 未知 kind 或非法 payload 返回 null（允许计入诊断，不进入状态归约）；
 * - event payload 绝不能被拼接后执行成命令、路径或参数。
 */

import type {
  AgentEventKind,
  AgentEventPayload,
  ApprovalRequestedPayload,
  ObserverCapabilities,
  ToolStartedPayload
} from '../../shared/agent-events'
import type { AdapterEvent } from './adapters/types'

const MAX_ID_LENGTH = 128
const MAX_NAME_LENGTH = 128
const MAX_SUMMARY_LENGTH = 1_024
const MAX_PROMPT_LENGTH = 1_024
const MAX_MESSAGE_LENGTH = 1_024
const MAX_CWD_LENGTH = 4_096
const MAX_DEGRADE_REASON_LENGTH = 1_024
const MAX_NATIVE_TYPE_LENGTH = 128
const MAX_NATIVE_ID_LENGTH = 128

const MAX_DURATION_MS = 86_400_000
const MAX_TOKEN_COUNT = 10_000_000_000
const MAX_COST_USD = 1_000_000

const AGENT_EVENT_KINDS: ReadonlySet<string> = new Set([
  'session.started',
  'session.idle',
  'session.exited',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'thinking.started',
  'thinking.completed',
  'message.completed',
  'tool.started',
  'tool.progress',
  'tool.completed',
  'tool.failed',
  'approval.requested',
  'approval.resolved',
  'input.requested',
  'input.resolved',
  'usage.updated',
  'activity.caption',
  'observer.degraded'
])

const TOOL_CATEGORIES: ReadonlySet<string> = new Set([
  'read',
  'edit',
  'shell',
  'search',
  'network',
  'mcp',
  'other'
])

const APPROVAL_CATEGORIES: ReadonlySet<string> = new Set([
  'tool',
  'command',
  'file-change',
  'network',
  'other'
])

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

/** 清理 NUL/控制字符并截断；非字符串返回 fallback。 */
function boundedText(
  value: unknown,
  maxLength: number,
  fallback = ''
): string {
  if (typeof value !== 'string') return fallback
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned.slice(0, maxLength)
}

function requiredId(value: unknown): string | null {
  const text = boundedText(value, MAX_ID_LENGTH)
  return text ? text : null
}

function optionalId(value: unknown): string | undefined {
  return boundedText(value, MAX_ID_LENGTH) || undefined
}

function optionalEnum(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  return typeof value === 'string' && allowed.has(value) ? value : undefined
}

function finiteNumber(
  value: unknown,
  max: number,
  min = 0
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value < min || value > max) return undefined
  return value
}

export function sanitizeObserverCapabilities(
  value: unknown
): ObserverCapabilities | null {
  const raw = recordOf(value)
  if (!raw) return null
  const pick = (
    key: string,
    allowed: readonly string[]
  ): string => {
    const candidate = raw[key]
    return typeof candidate === 'string' &&
      (allowed as readonly string[]).includes(candidate)
      ? candidate
      : 'none'
  }
  return {
    thinking: pick('thinking', ['none', 'phase', 'summary']) as ObserverCapabilities['thinking'],
    tools: pick('tools', ['none', 'lifecycle', 'progress']) as ObserverCapabilities['tools'],
    approvals: pick('approvals', ['none', 'structured']) as ObserverCapabilities['approvals'],
    inputRequests: pick('inputRequests', ['none', 'structured']) as ObserverCapabilities['inputRequests'],
    usage: pick('usage', ['none', 'tokens', 'context', 'tokens-and-context']) as ObserverCapabilities['usage'],
    messages: pick('messages', ['none', 'summary']) as ObserverCapabilities['messages']
  }
}

function sanitizeUsage(
  payload: Record<string, unknown>
): AgentEventPayload | null {
  const scope =
    payload.scope === 'session' || payload.scope === 'turn'
      ? payload.scope
      : undefined
  if (!scope) return null
  const inputTokens = finiteNumber(payload.inputTokens, MAX_TOKEN_COUNT)
  const outputTokens = finiteNumber(payload.outputTokens, MAX_TOKEN_COUNT)
  const cachedInputTokens = finiteNumber(
    payload.cachedInputTokens,
    MAX_TOKEN_COUNT
  )
  const contextTokens = finiteNumber(payload.contextTokens, MAX_TOKEN_COUNT)
  const contextWindow = finiteNumber(payload.contextWindow, MAX_TOKEN_COUNT)
  const costUsd = finiteNumber(payload.costUsd, MAX_COST_USD)
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    contextTokens === undefined &&
    contextWindow === undefined &&
    costUsd === undefined
  ) {
    return null
  }
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    contextTokens,
    contextWindow,
    costUsd,
    scope
  }
}

/**
 * 校验并清洗一条 AdapterEvent。返回 null 表示事件应被拒绝
 * （未知 kind / 非法 payload），不计入状态归约。
 */
export function normalizeAdapterEvent(value: unknown): AdapterEvent | null {
  const raw = recordOf(value)
  if (!raw || typeof raw.kind !== 'string') return null
  const kind = raw.kind as AgentEventKind
  if (!AGENT_EVENT_KINDS.has(kind)) return null

  const payload = recordOf(raw.payload)
  if (!payload) return null

  let normalizedPayload: AgentEventPayload | null = null

  switch (kind) {
    case 'session.started': {
      const cwd = boundedText(payload.cwd, MAX_CWD_LENGTH) || undefined
      normalizedPayload = { cwd }
      break
    }
    case 'session.idle': {
      const reason =
        payload.reason === 'protocol-idle' ||
        payload.reason === 'observer-silence' ||
        payload.reason === 'scheduled-wakeup'
          ? payload.reason
          : undefined
      const confidence =
        payload.confidence === 'high' || payload.confidence === 'low'
          ? payload.confidence
          : undefined
      const since = finiteNumber(payload.since, Date.now() + 86_400_000, 0)
      if (!reason || !confidence || since === undefined) return null
      normalizedPayload = { since, reason, confidence }
      break
    }
    case 'session.exited': {
      const exitCode =
        payload.exitCode === undefined || payload.exitCode === null
          ? undefined
          : finiteNumber(payload.exitCode, 65_535, -1)
      const signal =
        payload.signal === undefined || payload.signal === null
          ? undefined
          : finiteNumber(payload.signal, 65_535, -1)
      normalizedPayload = { exitCode, signal }
      break
    }
    case 'turn.started': {
      const turnId = requiredId(payload.turnId)
      if (!turnId) return null
      normalizedPayload = { turnId }
      break
    }
    case 'turn.completed': {
      const turnId = requiredId(payload.turnId)
      if (!turnId) return null
      const outcome =
        payload.outcome === 'completed' || payload.outcome === 'cancelled'
          ? payload.outcome
          : undefined
      normalizedPayload = { turnId, outcome }
      break
    }
    case 'turn.failed': {
      const turnId = requiredId(payload.turnId)
      if (!turnId) return null
      const message = boundedText(payload.message, MAX_MESSAGE_LENGTH)
      if (!message) return null
      normalizedPayload = { turnId, message }
      break
    }
    case 'thinking.started':
    case 'thinking.completed': {
      const turnId = requiredId(payload.turnId)
      if (!turnId) return null
      const summary =
        kind === 'thinking.completed'
          ? boundedText(payload.summary, MAX_SUMMARY_LENGTH) || undefined
          : undefined
      normalizedPayload = summary === undefined ? { turnId } : { turnId, summary }
      break
    }
    case 'message.completed': {
      const role =
        payload.role === 'assistant' || payload.role === 'system'
          ? payload.role
          : undefined
      if (!role) return null
      const turnId = optionalId(payload.turnId)
      const summary = boundedText(payload.summary, MAX_SUMMARY_LENGTH) || undefined
      normalizedPayload = summary === undefined ? { turnId, role } : { turnId, role, summary }
      break
    }
    case 'tool.started': {
      const callId = requiredId(payload.callId)
      const name = boundedText(payload.name, MAX_NAME_LENGTH)
      if (!callId || !name) return null
      const turnId = optionalId(payload.turnId)
      const category = optionalEnum(
        payload.category,
        TOOL_CATEGORIES
      ) as ToolStartedPayload['category'] | undefined
      normalizedPayload = { callId, turnId, name, category } as AgentEventPayload
      break
    }
    case 'tool.progress': {
      const callId = requiredId(payload.callId)
      if (!callId) return null
      const turnId = optionalId(payload.turnId)
      const summary = boundedText(payload.summary, MAX_SUMMARY_LENGTH) || undefined
      normalizedPayload = {
        callId,
        turnId,
        ...(summary === undefined ? {} : { summary })
      }
      break
    }
    case 'tool.completed': {
      const callId = requiredId(payload.callId)
      if (!callId) return null
      const turnId = optionalId(payload.turnId)
      const durationMs = finiteNumber(payload.durationMs, MAX_DURATION_MS)
      normalizedPayload = {
        callId,
        turnId,
        ...(durationMs === undefined ? {} : { durationMs })
      }
      break
    }
    case 'tool.failed': {
      const callId = requiredId(payload.callId)
      const message = boundedText(payload.message, MAX_MESSAGE_LENGTH)
      if (!callId || !message) return null
      const turnId = optionalId(payload.turnId)
      const durationMs = finiteNumber(payload.durationMs, MAX_DURATION_MS)
      normalizedPayload = durationMs === undefined
        ? { callId, turnId, message }
        : { callId, turnId, durationMs, message }
      break
    }
    case 'approval.requested': {
      const requestId = requiredId(payload.requestId)
      if (!requestId) return null
      const turnId = optionalId(payload.turnId)
      const callId = optionalId(payload.callId)
      const category = optionalEnum(
        payload.category,
        APPROVAL_CATEGORIES
      ) as ApprovalRequestedPayload['category'] | undefined
      const summary = boundedText(payload.summary, MAX_SUMMARY_LENGTH) || undefined
      normalizedPayload = {
        requestId,
        turnId,
        callId,
        category,
        summary
      } as AgentEventPayload
      break
    }
    case 'approval.resolved': {
      const requestId = requiredId(payload.requestId)
      if (!requestId) return null
      const decision =
        payload.decision === 'approved' ||
        payload.decision === 'denied' ||
        payload.decision === 'cancelled'
          ? payload.decision
          : undefined
      if (!decision) return null
      normalizedPayload = { requestId, decision }
      break
    }
    case 'input.requested': {
      const requestId = requiredId(payload.requestId)
      if (!requestId) return null
      const turnId = optionalId(payload.turnId)
      const callId = optionalId(payload.callId)
      const prompt = boundedText(payload.prompt, MAX_PROMPT_LENGTH) || undefined
      normalizedPayload = {
        requestId,
        turnId,
        callId,
        ...(prompt === undefined ? {} : { prompt })
      }
      break
    }
    case 'input.resolved': {
      const requestId = requiredId(payload.requestId)
      if (!requestId) return null
      normalizedPayload = { requestId }
      break
    }
    case 'usage.updated': {
      const usage = sanitizeUsage(payload)
      if (!usage) return null
      normalizedPayload = usage as AgentEventPayload
      break
    }
    case 'activity.caption': {
      const text = boundedText(payload.text, 128)
      if (!text || payload.confidence !== 'low') return null
      const outputTokens = finiteNumber(payload.outputTokens, MAX_TOKEN_COUNT)
      normalizedPayload = outputTokens === undefined
        ? { text, confidence: 'low' }
        : { text, confidence: 'low', outputTokens }
      break
    }
    case 'observer.degraded': {
      const reason = boundedText(payload.reason, MAX_DEGRADE_REASON_LENGTH)
      const remaining = sanitizeObserverCapabilities(payload.remaining)
      if (!reason || !remaining) return null
      normalizedPayload = { reason, remaining } as AgentEventPayload
      break
    }
  }

  if (normalizedPayload === null) return null

  const nativeId =
    boundedText(raw.nativeId, MAX_NATIVE_ID_LENGTH) || undefined
  const nativeType =
    boundedText(raw.nativeType, MAX_NATIVE_TYPE_LENGTH) || undefined

  return {
    kind,
    payload: normalizedPayload,
    nativeId,
    nativeType
  } as AdapterEvent
}

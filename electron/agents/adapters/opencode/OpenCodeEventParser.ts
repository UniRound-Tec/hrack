import type {
  OpenCodeNativeFact,
  OpenCodeSessionInfo,
  OpenCodeSessionStatus,
  OpenCodeSnapshot
} from './types'

const MAX_ID = 256
const MAX_LABEL = 128
const MAX_ERROR = 512
const MAX_PATH = 4096
const MAX_TOKEN = 1_000_000_000
const MAX_COST = 1_000_000

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean ? clean.slice(0, max) : undefined
}

function id(value: unknown): string | undefined {
  return bounded(value, MAX_ID)
}

function finite(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, max)
    : undefined
}

function sessionInfo(value: unknown): OpenCodeSessionInfo | null {
  const raw = recordOf(value)
  const sessionId = id(raw?.id)
  if (!raw || !sessionId) return null
  const time = recordOf(raw.time)
  return {
    id: sessionId,
    directory: bounded(raw.directory, MAX_PATH),
    parentId: id(raw.parentID ?? raw.parentId),
    createdAt: finite(time?.created, Number.MAX_SAFE_INTEGER),
    updatedAt: finite(time?.updated, Number.MAX_SAFE_INTEGER)
  }
}

function statusOf(value: unknown): {
  status: OpenCodeSessionStatus
  attempt?: number
  message?: string
} | null {
  const raw = typeof value === 'string' ? { type: value } : recordOf(value)
  const type = bounded(raw?.type ?? raw?.status, 32)?.toLowerCase()
  if (type === 'idle' || type === 'busy') return { status: type }
  if (type === 'retry') {
    return {
      status: 'retry',
      attempt: finite(raw?.attempt, 10_000),
      message: bounded(raw?.message, MAX_ERROR)
    }
  }
  if (type === 'error') return { status: 'error' }
  return null
}

function tokensOf(value: unknown): {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
} {
  const raw = recordOf(value)
  const cache = recordOf(raw?.cache)
  return {
    inputTokens: finite(raw?.input, MAX_TOKEN),
    outputTokens: finite(raw?.output, MAX_TOKEN),
    cachedInputTokens: finite(cache?.read ?? raw?.cachedInput, MAX_TOKEN)
  }
}

function errorInfo(value: unknown): {
  message: string
  retryable: boolean
  cancelled: boolean
} {
  const raw = recordOf(value)
  const data = recordOf(raw?.data)
  const name = bounded(raw?.name, MAX_LABEL) ?? 'OpenCodeError'
  const message = bounded(data?.message ?? raw?.message, MAX_ERROR) ?? name
  return {
    message,
    retryable: data?.isRetryable === true || raw?.isRetryable === true,
    cancelled:
      /abort|cancel|interrupt/i.test(name) ||
      /abort|cancel|interrupt/i.test(message)
  }
}

function questionPrompt(value: unknown): string | undefined {
  const list = Array.isArray(value) ? value : []
  const first = recordOf(list[0])
  return bounded(first?.header ?? first?.question ?? first?.prompt, MAX_LABEL)
}

/** unknown OpenCode bus payload → 低敏 native fact。 */
export function parseOpenCodeEvent(value: unknown): OpenCodeNativeFact | null {
  const envelope = recordOf(value)
  const raw = recordOf(envelope?.payload) ?? envelope
  const nativeType = bounded(raw?.type, 96)
  const properties = recordOf(raw?.properties)
  if (!raw || !nativeType || !properties) return null

  if (nativeType === 'server.connected')
    return { type: 'server-connected', nativeType }

  if (nativeType === 'session.created' || nativeType === 'session.updated') {
    const info = sessionInfo(properties.info ?? properties)
    if (!info) return null
    return {
      type:
        nativeType === 'session.created'
          ? 'session-created'
          : 'session-updated',
      nativeType,
      sessionId: info.id,
      info
    }
  }

  const sessionId = id(properties.sessionID ?? properties.sessionId)
  if (nativeType === 'session.deleted') {
    const info = sessionInfo(properties.info)
    const deletedId = info?.id ?? sessionId
    return deletedId
      ? { type: 'session-deleted', nativeType, sessionId: deletedId }
      : null
  }
  if (nativeType === 'session.status') {
    const status = statusOf(properties.status)
    return sessionId && status
      ? { type: 'session-status', nativeType, sessionId, ...status }
      : null
  }
  if (nativeType === 'session.idle') {
    return sessionId ? { type: 'session-idle', nativeType, sessionId } : null
  }
  if (nativeType === 'session.error') {
    const parsed = errorInfo(properties.error)
    return { type: 'session-error', nativeType, sessionId, ...parsed }
  }

  if (nativeType === 'message.updated') {
    const info = recordOf(properties.info)
    const messageId = id(info?.id)
    const messageSessionId = id(info?.sessionID ?? info?.sessionId)
    const role = bounded(info?.role, 32)?.toLowerCase()
    if (!messageId || !messageSessionId) return null
    if (role === 'user') {
      return {
        type: 'message-user',
        nativeType,
        sessionId: messageSessionId,
        messageId
      }
    }
    if (
      role === 'assistant' &&
      finite(recordOf(info?.time)?.completed, Number.MAX_SAFE_INTEGER) !==
        undefined
    ) {
      const tokens = tokensOf(info?.tokens)
      return {
        type: 'message-assistant-completed',
        nativeType,
        sessionId: messageSessionId,
        messageId,
        ...tokens,
        costUsd: finite(info?.cost, MAX_COST)
      }
    }
    return null
  }

  if (nativeType === 'message.part.updated') {
    const part = recordOf(properties.part)
    const partType = bounded(part?.type, 48)?.toLowerCase()
    const partId = id(part?.id)
    const messageId = id(part?.messageID ?? part?.messageId)
    const partSessionId = id(part?.sessionID ?? part?.sessionId)
    if (!part || !partType || !partId || !messageId || !partSessionId)
      return null
    const common = { nativeType, sessionId: partSessionId, messageId, partId }
    if (partType === 'reasoning') {
      return {
        ...common,
        type: 'reasoning',
        completed:
          finite(recordOf(part.time)?.end, Number.MAX_SAFE_INTEGER) !==
          undefined
      }
    }
    if (partType === 'step-start') {
      return { ...common, type: 'step-started' }
    }
    if (partType === 'text') {
      if (
        finite(recordOf(part.time)?.end, Number.MAX_SAFE_INTEGER) === undefined
      )
        return null
      return { ...common, type: 'text-completed' }
    }
    if (partType === 'tool') {
      const state = recordOf(part.state)
      const stateType = bounded(state?.status, 32)?.toLowerCase()
      const callId = id(part.callID ?? part.callId)
      const name = bounded(part.tool, MAX_LABEL)
      if (
        !callId ||
        !name ||
        !['pending', 'running', 'completed', 'error'].includes(stateType ?? '')
      )
        return null
      const time = recordOf(state?.time)
      return {
        ...common,
        type: 'tool',
        callId,
        name,
        state: stateType as 'pending' | 'running' | 'completed' | 'error',
        title: bounded(state?.title, MAX_LABEL),
        startedAt: finite(time?.start, Number.MAX_SAFE_INTEGER),
        endedAt: finite(time?.end, Number.MAX_SAFE_INTEGER),
        error:
          stateType === 'error' ? bounded(state?.error, MAX_ERROR) : undefined
      }
    }
    if (partType === 'step-finish') {
      const tokens = tokensOf(part.tokens)
      return {
        ...common,
        type: 'step-finished',
        ...tokens,
        costUsd: finite(part.cost, MAX_COST)
      }
    }
    return null
  }

  if (
    nativeType === 'permission.asked' ||
    nativeType === 'permission.updated'
  ) {
    const permissionSessionId = sessionId ?? id(properties.sessionID)
    const requestId = id(
      properties.requestID ?? properties.permissionID ?? properties.id
    )
    if (!permissionSessionId || !requestId) return null
    return {
      type: 'permission-asked',
      nativeType,
      sessionId: permissionSessionId,
      requestId,
      callId: id(properties.callID ?? properties.callId),
      permission: bounded(properties.permission ?? properties.type, MAX_LABEL),
      title: bounded(properties.title, MAX_LABEL)
    }
  }
  if (nativeType === 'permission.replied') {
    const requestId = id(
      properties.requestID ?? properties.permissionID ?? properties.id
    )
    const response = bounded(properties.reply ?? properties.response, 48)
    return sessionId && requestId && response
      ? {
          type: 'permission-replied',
          nativeType,
          sessionId,
          requestId,
          response
        }
      : null
  }
  if (nativeType === 'question.asked') {
    const requestId = id(properties.requestID ?? properties.id)
    return sessionId && requestId
      ? {
          type: 'question-asked',
          nativeType,
          sessionId,
          requestId,
          prompt: questionPrompt(properties.questions)
        }
      : null
  }
  if (nativeType === 'question.replied' || nativeType === 'question.rejected') {
    const requestId = id(properties.requestID ?? properties.id)
    return sessionId && requestId
      ? { type: 'question-resolved', nativeType, sessionId, requestId }
      : null
  }
  return null
}

export function parseOpenCodeSnapshot(
  sessionsValue: unknown,
  statusesValue: unknown
): OpenCodeSnapshot | null {
  const sessionsRaw = Array.isArray(sessionsValue)
    ? sessionsValue
    : Array.isArray(recordOf(sessionsValue)?.data)
      ? (recordOf(sessionsValue)?.data as unknown[])
      : null
  const statusesRaw = recordOf(recordOf(statusesValue)?.data ?? statusesValue)
  if (!sessionsRaw || !statusesRaw) return null
  const sessions = sessionsRaw
    .map(sessionInfo)
    .filter((value): value is OpenCodeSessionInfo => Boolean(value))
  const statuses = new Map<string, OpenCodeSessionStatus>()
  for (const [sessionId, value] of Object.entries(statusesRaw)) {
    const parsed = statusOf(value)
    const cleanId = id(sessionId)
    if (cleanId && parsed) statuses.set(cleanId, parsed.status)
  }
  return { sessions, statuses }
}

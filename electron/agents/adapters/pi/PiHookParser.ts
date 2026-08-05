import type {
  PiNativeFact,
  PiSessionShutdownReason,
  PiSessionStartReason
} from './types'

const MAX_ID_LENGTH = 128
const MAX_GENERATION_LENGTH = 64
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER
const MAX_CLOCK_SKEW_MS = 86_400_000
const MAX_TOKEN_COUNT = 10_000_000_000
const MAX_COST_USD = 1_000_000
const MAX_DURATION_MS = 86_400_000

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function bounded(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= maxLength
    ? trimmed
    : undefined
}

function integer(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined
}

function finiteNumber(
  value: unknown,
  minimum: number,
  maximum: number
): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined
}

function sessionStartReason(value: unknown): PiSessionStartReason | undefined {
  return value === 'startup' ||
    value === 'reload' ||
    value === 'new' ||
    value === 'resume' ||
    value === 'fork'
    ? value
    : undefined
}

function sessionShutdownReason(
  value: unknown
): PiSessionShutdownReason | undefined {
  return value === 'quit' ||
    value === 'reload' ||
    value === 'new' ||
    value === 'resume' ||
    value === 'fork'
    ? value
    : undefined
}

export function parsePiHook(
  value: unknown,
  expectedSessionId: string,
  now = Date.now()
): PiNativeFact | null {
  const raw = recordOf(value)
  if (!raw || raw.schema !== 1) return null
  const sessionId = bounded(raw.sessionId, MAX_ID_LENGTH)
  const generation = bounded(raw.generation, MAX_GENERATION_LENGTH)
  const seq = integer(raw.seq, 1, MAX_SEQUENCE)
  const emittedAt = integer(raw.emittedAt, 0, now + MAX_CLOCK_SKEW_MS)
  const nativeType = bounded(raw.type, 64)
  if (
    !sessionId ||
    sessionId !== expectedSessionId ||
    !generation ||
    seq === undefined ||
    emittedAt === undefined ||
    !nativeType
  ) {
    return null
  }

  const payload = recordOf(raw.payload) ?? {}
  if (nativeType === 'session-start') {
    const reason = sessionStartReason(payload.reason)
    if (!reason) return null
    return {
      type: 'session-start',
      sessionId,
      generation,
      seq,
      emittedAt,
      nativeType,
      reason
    }
  }
  const base = {
    sessionId,
    generation,
    seq,
    emittedAt,
    nativeType
  }
  if (nativeType === 'tool-start') {
    const callId = bounded(payload.callId, MAX_ID_LENGTH)
    const toolName = bounded(payload.toolName, 64)
    if (!callId || !toolName) return null
    return { ...base, type: 'tool-start', callId, toolName }
  }
  if (nativeType === 'thinking-start') {
    return { ...base, type: 'thinking-start' }
  }
  if (nativeType === 'thinking-end' || nativeType === 'responding') {
    return { ...base, type: nativeType }
  }
  if (nativeType === 'run-start' || nativeType === 'run-settled') {
    return { ...base, type: nativeType }
  }
  if (
    nativeType === 'observer-degraded' &&
    payload.reason === 'settle-ambiguous'
  ) {
    return { ...base, type: nativeType, reason: payload.reason }
  }
  if (nativeType === 'run-end') {
    const outcome =
      payload.outcome === 'completed' ||
      payload.outcome === 'cancelled' ||
      payload.outcome === 'failed'
        ? payload.outcome
        : undefined
    if (!outcome) return null
    return { ...base, type: 'run-end', outcome }
  }
  if (nativeType === 'session-shutdown') {
    const reason = sessionShutdownReason(payload.reason)
    if (!reason) return null
    return { ...base, type: 'session-shutdown', reason }
  }
  if (nativeType === 'tool-progress') {
    const callId = bounded(payload.callId, MAX_ID_LENGTH)
    const toolName = bounded(payload.toolName, 64)
    if (!callId || !toolName) return null
    return { ...base, type: 'tool-progress', callId, toolName }
  }
  if (nativeType === 'tool-end') {
    const callId = bounded(payload.callId, MAX_ID_LENGTH)
    const toolName = bounded(payload.toolName, 64)
    if (!callId || !toolName || typeof payload.isError !== 'boolean') return null
    const durationMs = finiteNumber(payload.durationMs, 0, MAX_DURATION_MS)
    return {
      ...base,
      type: 'tool-end',
      callId,
      toolName,
      isError: payload.isError,
      durationMs
    }
  }
  if (nativeType === 'compact-start' || nativeType === 'compact-end') {
    const reason =
      payload.reason === 'manual' ||
      payload.reason === 'threshold' ||
      payload.reason === 'overflow'
        ? payload.reason
        : undefined
    if (!reason || typeof payload.willRetry !== 'boolean') return null
    return {
      ...base,
      type: nativeType,
      reason,
      willRetry: payload.willRetry
    }
  }
  if (nativeType === 'usage') {
    const inputTokens = finiteNumber(payload.inputTokens, 0, MAX_TOKEN_COUNT)
    const outputTokens = finiteNumber(payload.outputTokens, 0, MAX_TOKEN_COUNT)
    const cachedInputTokens = finiteNumber(
      payload.cachedInputTokens,
      0,
      MAX_TOKEN_COUNT
    )
    const contextTokens = finiteNumber(payload.contextTokens, 0, MAX_TOKEN_COUNT)
    const contextWindow = finiteNumber(payload.contextWindow, 0, MAX_TOKEN_COUNT)
    const costUsd = finiteNumber(payload.costUsd, 0, MAX_COST_USD)
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
      ...base,
      type: 'usage',
      inputTokens,
      outputTokens,
      cachedInputTokens,
      contextTokens,
      contextWindow,
      costUsd,
      scope: payload.scope === 'session' ? 'session' : 'turn'
    }
  }
  return null
}

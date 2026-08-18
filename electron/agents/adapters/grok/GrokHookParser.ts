import type { GrokHookEventName, GrokNativeFact } from './types'

const MAX_ID_LENGTH = 256

const EVENT_ALIASES: Record<string, GrokHookEventName> = {
  session_start: 'SessionStart',
  sessionstart: 'SessionStart',
  session_end: 'SessionEnd',
  sessionend: 'SessionEnd',
  user_prompt_submit: 'UserPromptSubmit',
  userpromptsubmit: 'UserPromptSubmit',
  beforesubmitprompt: 'UserPromptSubmit',
  pre_tool_use: 'PreToolUse',
  pretooluse: 'PreToolUse',
  post_tool_use: 'PostToolUse',
  posttooluse: 'PostToolUse',
  post_tool_use_failure: 'PostToolUseFailure',
  posttoolusefailure: 'PostToolUseFailure',
  permission_denied: 'PermissionDenied',
  permissiondenied: 'PermissionDenied',
  stop: 'Stop',
  stop_failure: 'StopFailure',
  stopfailure: 'StopFailure',
  stop_cancelled: 'StopCancelled',
  stopcancelled: 'StopCancelled',
  notification: 'Notification',
  subagent_start: 'SubagentStart',
  subagentstart: 'SubagentStart',
  subagent_stop: 'SubagentStop',
  subagentstop: 'SubagentStop',
  subagent_end: 'SubagentStop',
  subagentend: 'SubagentStop'
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 &&
    trimmed.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(trimmed)
    ? trimmed
    : undefined
}

function firstBounded(
  raw: Record<string, unknown>,
  keys: readonly string[],
  max: number
): string | undefined {
  for (const key of keys) {
    const value = bounded(raw[key], max)
    if (value) return value
  }
  return undefined
}

function boundedId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value)
  }
  return bounded(value, MAX_ID_LENGTH)
}

function firstId(
  raw: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = boundedId(raw[key])
    if (value) return value
  }
  return undefined
}

function normalizeEventName(value: string): GrokHookEventName | undefined {
  if (
    value === 'SessionStart' ||
    value === 'SessionEnd' ||
    value === 'UserPromptSubmit' ||
    value === 'PreToolUse' ||
    value === 'PostToolUse' ||
    value === 'PostToolUseFailure' ||
    value === 'PermissionDenied' ||
    value === 'Stop' ||
    value === 'StopFailure' ||
    value === 'StopCancelled' ||
    value === 'Notification' ||
    value === 'SubagentStart' ||
    value === 'SubagentStop'
  ) {
    return value
  }
  return EVENT_ALIASES[value.toLowerCase().replaceAll('-', '_')]
}

export function parseGrokHook(value: unknown): GrokNativeFact | null {
  const raw = recordOf(value)
  if (!raw) return null
  const nativeSessionId = firstBounded(raw, ['sessionId', 'session_id'], MAX_ID_LENGTH)
  const eventRaw = firstBounded(
    raw,
    ['hookEventName', 'hook_event_name', 'event'],
    64
  )
  if (!nativeSessionId || !eventRaw) return null
  const nativeType = normalizeEventName(eventRaw)
  if (!nativeType) return null
  const promptId = firstId(raw, ['promptId', 'prompt_id'])
  const subagentType = firstBounded(raw, ['subagentType', 'subagent_type'], 128)
  const base = {
    nativeSessionId,
    nativeType,
    ...(promptId ? { promptId } : {}),
    ...(subagentType ? { subagentType } : {})
  }

  if (nativeType === 'SessionStart') {
    const source = firstBounded(raw, ['source', 'startSource', 'start_source'], 32)
    return {
      ...base,
      type: 'session-started',
      source: source === 'startup' || source === 'resume' ? source : 'unknown'
    }
  }
  if (nativeType === 'SessionEnd') {
    return {
      ...base,
      type: 'session-ended',
      reason: firstBounded(raw, ['reason', 'endReason', 'end_reason'], 64)
    }
  }
  if (nativeType === 'UserPromptSubmit') {
    return { ...base, type: 'user-prompt-submit' }
  }
  if (
    nativeType === 'PreToolUse' ||
    nativeType === 'PostToolUse' ||
    nativeType === 'PostToolUseFailure'
  ) {
    const toolCallId = firstId(raw, ['toolUseId', 'tool_use_id', 'tool_call_id'])
    const toolName = firstBounded(raw, ['toolName', 'tool_name'], 128)
    if (!toolCallId || !toolName) return null
    return {
      ...base,
      type:
        nativeType === 'PreToolUse'
          ? 'tool-started'
          : nativeType === 'PostToolUse'
            ? 'tool-completed'
            : 'tool-failed',
      toolCallId,
      toolName
    }
  }
  if (nativeType === 'Notification') {
    const notificationType = firstBounded(
      raw,
      ['notificationType', 'notification_type'],
      64
    )
    if (notificationType !== 'permission_prompt') return null
    const toolName =
      firstBounded(raw, ['toolName', 'tool_name'], 128) ?? 'tool'
    return {
      ...base,
      type: 'permission-requested',
      toolCallId: firstId(raw, ['toolUseId', 'tool_use_id', 'tool_call_id']),
      toolName
    }
  }
  if (nativeType === 'PermissionDenied') {
    return {
      ...base,
      type: 'permission-denied',
      toolCallId: firstId(raw, ['toolUseId', 'tool_use_id', 'tool_call_id']),
      toolName: firstBounded(raw, ['toolName', 'tool_name'], 128)
    }
  }
  if (nativeType === 'Stop') {
    return {
      ...base,
      type: 'stopped',
      reason: firstBounded(raw, ['reason'], 64),
      stopHookActive:
        raw.stopHookActive === true || raw.stop_hook_active === true
    }
  }
  if (nativeType === 'StopFailure') {
    const errorType =
      firstBounded(raw, ['error', 'errorType', 'error_type'], 64) ?? 'unknown'
    return {
      ...base,
      type: 'turn-failed',
      errorType: /^[a-zA-Z0-9_.:-]+$/.test(errorType) ? errorType : 'unknown'
    }
  }
  if (nativeType === 'StopCancelled') {
    const reason = firstBounded(raw, ['reason'], 64) ?? 'unknown'
    return {
      ...base,
      type: 'cancelled',
      reason,
      cancelledBy: firstBounded(raw, ['cancelledBy', 'cancelled_by'], 32)
    }
  }
  if (nativeType === 'SubagentStart' || nativeType === 'SubagentStop') {
    return {
      ...base,
      type: 'subagent-activity',
      phase: nativeType === 'SubagentStart' ? 'started' : 'stopped'
    }
  }
  return null
}

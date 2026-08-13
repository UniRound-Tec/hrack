import type { KimiNativeFact } from './types'

const MAX_ID_LENGTH = 256

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

function boundedId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value)
  }
  return bounded(value, MAX_ID_LENGTH)
}

function permissionDecision(
  value: unknown
): 'approved' | 'denied' | 'cancelled' {
  if (value === 'approved') return 'approved'
  if (value === 'denied' || value === 'rejected') return 'denied'
  return 'cancelled'
}

export function parseKimiHook(value: unknown): KimiNativeFact | null {
  const raw = recordOf(value)
  if (!raw) return null
  const nativeSessionId = bounded(raw.session_id, MAX_ID_LENGTH)
  const nativeType = bounded(raw.hook_event_name, 64)
  if (!nativeSessionId) return null

  if (nativeType === 'SessionStart') {
    const source = bounded(raw.source, 32)
    return {
      type: 'session-started',
      nativeSessionId,
      nativeType,
      source: source === 'startup' || source === 'resume' ? source : 'unknown'
    }
  }
  if (nativeType === 'SessionEnd') {
    return { type: 'session-ended', nativeSessionId, nativeType }
  }
  if (nativeType === 'UserPromptSubmit') {
    return {
      type: 'user-prompt-submit',
      nativeSessionId,
      nativeType,
      isSteer: raw.is_steer === true
    }
  }
  if (
    nativeType === 'PreToolUse' ||
    nativeType === 'PostToolUse' ||
    nativeType === 'PostToolUseFailure'
  ) {
    const toolCallId = boundedId(raw.tool_call_id)
    const toolName = bounded(raw.tool_name, 128)
    if (!toolCallId || !toolName) return null
    return {
      type:
        nativeType === 'PreToolUse'
          ? 'tool-started'
          : nativeType === 'PostToolUse'
            ? 'tool-completed'
            : 'tool-failed',
      nativeSessionId,
      nativeType,
      toolCallId,
      toolName
    }
  }
  if (nativeType === 'PermissionRequest') {
    const toolCallId = boundedId(raw.tool_call_id)
    const toolName = bounded(raw.tool_name, 128)
    if (!toolCallId || !toolName) return null
    return {
      type: 'permission-requested',
      nativeSessionId,
      nativeType,
      nativeTurnId: boundedId(raw.turn_id),
      toolCallId,
      toolName
    }
  }
  if (nativeType === 'PermissionResult') {
    const toolCallId = boundedId(raw.tool_call_id)
    if (!toolCallId) return null
    return {
      type: 'permission-resolved',
      nativeSessionId,
      nativeType,
      nativeTurnId: boundedId(raw.turn_id),
      toolCallId,
      decision: permissionDecision(raw.decision)
    }
  }
  if (nativeType === 'Interrupt') {
    return {
      type: 'interrupted',
      nativeSessionId,
      nativeType,
      nativeTurnId: boundedId(raw.turn_id)
    }
  }
  if (nativeType === 'StopFailure') {
    const errorType = bounded(raw.error_type, 64)
    return {
      type: 'turn-failed',
      nativeSessionId,
      nativeType,
      errorType:
        errorType && /^[a-zA-Z0-9_.:-]+$/.test(errorType)
          ? errorType
          : 'unknown'
    }
  }
  if (nativeType === 'Stop') {
    return {
      type: 'stopped',
      nativeSessionId,
      nativeType,
      stopHookActive: raw.stop_hook_active === true
    }
  }
  if (nativeType === 'SubagentStart' || nativeType === 'SubagentStop') {
    // Kimi 0.30 exposes only agent_name (plus sensitive prompt/response), not
    // a stable subagent id. Validate the documented shape, then deliberately
    // discard every value and keep only a root-turn activity signal.
    if (!bounded(raw.agent_name, 128)) return null
    return {
      type: 'subagent-activity',
      nativeSessionId,
      nativeType,
      phase: nativeType === 'SubagentStart' ? 'started' : 'stopped'
    }
  }
  return null
}

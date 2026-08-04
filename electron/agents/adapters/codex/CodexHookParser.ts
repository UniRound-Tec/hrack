import type { CodexNativeFact } from './types'
import { summarizeCodexTool } from './codexSummaries'

const MAX_ID_LENGTH = 256

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : undefined
}

export function parseCodexHook(value: unknown): CodexNativeFact | null {
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
      source:
        source === 'startup' ||
        source === 'resume' ||
        source === 'clear' ||
        source === 'compact'
          ? source
          : 'unknown'
    }
  }
  if (nativeType === 'SessionEnd') {
    return { type: 'session-ended', nativeSessionId, nativeType }
  }

  const turnId = bounded(raw.turn_id, MAX_ID_LENGTH)
  if (!turnId) return null

  if (nativeType === 'UserPromptSubmit') {
    return {
      type: 'user-prompt-submit',
      nativeSessionId,
      turnId,
      nativeType
    }
  }
  if (nativeType === 'PreCompact' || nativeType === 'PostCompact') {
    const trigger = bounded(raw.trigger, 32)
    return {
      type:
        nativeType === 'PreCompact' ? 'compact-started' : 'compact-completed',
      nativeSessionId,
      turnId,
      nativeType,
      trigger: trigger === 'manual' || trigger === 'auto' ? trigger : 'unknown'
    }
  }
  if (nativeType === 'SubagentStart' || nativeType === 'SubagentStop') {
    const agentId = bounded(raw.agent_id, MAX_ID_LENGTH)
    if (!agentId) return null
    return {
      type:
        nativeType === 'SubagentStart'
          ? 'subagent-started'
          : 'subagent-completed',
      nativeSessionId,
      turnId,
      nativeType,
      agentId
    }
  }
  if (
    nativeType === 'PreToolUse' ||
    nativeType === 'PostToolUse'
  ) {
    const toolUseId = bounded(raw.tool_use_id, MAX_ID_LENGTH)
    if (!toolUseId) return null
    const toolInput = recordOf(raw.tool_input) ?? {}
    const summary = summarizeCodexTool(raw.tool_name, toolInput)
    return {
      type: nativeType === 'PreToolUse' ? 'tool-started' : 'tool-completed',
      nativeSessionId,
      turnId,
      nativeType,
      toolUseId,
      toolName: summary.toolName,
      summary: summary.summary
    }
  }
  if (nativeType === 'PermissionRequest') {
    const summary = summarizeCodexTool(
      raw.tool_name,
      recordOf(raw.tool_input) ?? {}
    )
    return {
      type: 'permission-requested',
      nativeSessionId,
      turnId,
      nativeType,
      toolName: summary.toolName,
      summary: summary.summary
    }
  }
  if (nativeType === 'Stop') {
    return {
      type: 'stopped',
      nativeSessionId,
      turnId,
      nativeType,
      stopHookActive: raw.stop_hook_active === true
    }
  }
  return null
}

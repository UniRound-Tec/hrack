import { createHash } from 'node:crypto'
import {
  CLAUDE_HOOK_EVENTS,
  type ClaudeHookEventName,
  type ClaudeNativeFact
} from './types'
import { sanitizeClaudeLabel, summarizeClaudeTool } from './claudeSummaries'

const MAX_ID_LENGTH = 256
const MAX_REASON_LENGTH = 128
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1_000
const EVENT_NAMES = new Set<string>(CLAUDE_HOOK_EVENTS)

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return clean ? clean.slice(0, max) : undefined
}

function duration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, MAX_DURATION_MS)
    : undefined
}

function fingerprint(value: unknown): string {
  let encoded = ''
  try {
    encoded = JSON.stringify(value) ?? ''
  } catch {
    encoded = '[unserializable]'
  }
  return createHash('sha256').update(encoded.slice(0, 65_536)).digest('hex').slice(0, 24)
}

function hasRunning(items: unknown): boolean {
  if (!Array.isArray(items)) return false
  return items.some((item) => {
    if (typeof item === 'string') return /running|pending|active/i.test(item)
    const record = recordOf(item)
    const status = bounded(record?.status, 32)
    return !status || /running|pending|active/i.test(status)
  })
}

export function parseClaudeHook(value: unknown): ClaudeNativeFact | null {
  const raw = recordOf(value)
  if (!raw) return null
  const nativeSessionId = bounded(raw.session_id, MAX_ID_LENGTH)
  const eventName = bounded(raw.hook_event_name, 64)
  if (!nativeSessionId || !eventName || !EVENT_NAMES.has(eventName)) return null
  const nativeType = eventName as ClaudeHookEventName
  const base = { nativeSessionId, nativeType }

  switch (nativeType) {
    case 'UserPromptSubmit':
      return { ...base, type: 'user-prompt-submit' }
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const toolUseId = bounded(raw.tool_use_id, MAX_ID_LENGTH)
      if (!toolUseId) return null
      const toolInput = recordOf(raw.tool_input) ?? {}
      const summary = summarizeClaudeTool(raw.tool_name, toolInput, bounded(raw.cwd, 4_096))
      const common = {
        ...base,
        toolUseId,
        toolName: summary.toolName,
        summary: summary.summary,
        fingerprint: fingerprint(toolInput)
      }
      if (nativeType === 'PreToolUse') return { ...common, type: 'tool-started' }
      if (nativeType === 'PostToolUse') {
        return { ...common, type: 'tool-completed', durationMs: duration(raw.duration_ms) }
      }
      return { ...common, type: 'tool-failed', durationMs: duration(raw.duration_ms) }
    }
    case 'PermissionRequest': {
      const toolInput = recordOf(raw.tool_input)
      const summary = summarizeClaudeTool(raw.tool_name, toolInput, bounded(raw.cwd, 4_096))
      return {
        ...base,
        type: 'permission-requested',
        toolName: sanitizeClaudeLabel(raw.tool_name),
        summary: summary.summary,
        fingerprint: toolInput ? fingerprint(toolInput) : undefined
      }
    }
    case 'PostToolBatch':
      return { ...base, type: 'tool-batch-completed' }
    case 'Stop':
      return {
        ...base,
        type: 'stopped',
        hasRunningBackgroundTasks: hasRunning(raw.background_tasks),
        hasSessionCrons: Array.isArray(raw.session_crons) && raw.session_crons.length > 0
      }
    case 'StopFailure':
      return { ...base, type: 'stop-failed' }
    case 'Notification':
      return {
        ...base,
        type: 'notification',
        notificationType:
          bounded(raw.notification_type ?? raw.type, 64)?.toLowerCase() ?? 'unknown'
      }
    case 'SessionEnd':
      return {
        ...base,
        type: 'session-ended',
        reason: bounded(raw.reason, MAX_REASON_LENGTH)
      }
  }
}

import type { ObserverCapabilities } from '../../../../shared/agent-events'

export const CLAUDE_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Stop',
  'StopFailure',
  'Notification',
  'SessionEnd'
] as const

export type ClaudeHookEventName = (typeof CLAUDE_HOOK_EVENTS)[number]

interface ClaudeFactBase {
  nativeSessionId: string
  nativeType: ClaudeHookEventName
}

export type ClaudeNativeFact =
  | (ClaudeFactBase & { type: 'user-prompt-submit' })
  | (ClaudeFactBase & {
      type: 'tool-started'
      toolUseId: string
      toolName: string
      summary?: string
      fingerprint: string
    })
  | (ClaudeFactBase & {
      type: 'permission-requested'
      toolName?: string
      summary?: string
      fingerprint?: string
    })
  | (ClaudeFactBase & {
      type: 'tool-completed'
      toolUseId: string
      toolName: string
      summary?: string
      fingerprint: string
      durationMs?: number
    })
  | (ClaudeFactBase & {
      type: 'tool-failed'
      toolUseId: string
      toolName: string
      summary?: string
      fingerprint: string
      durationMs?: number
    })
  | (ClaudeFactBase & { type: 'tool-batch-completed' })
  | (ClaudeFactBase & {
      type: 'stopped'
      hasRunningBackgroundTasks: boolean
      hasSessionCrons: boolean
    })
  | (ClaudeFactBase & { type: 'stop-failed' })
  | (ClaudeFactBase & {
      type: 'notification'
      notificationType: string
    })
  | (ClaudeFactBase & { type: 'session-ended'; reason?: string })

export type ClaudeObserverDegradedReason =
  | 'unsupported-version'
  | 'user-settings-conflict'
  | 'managed-hooks-only'
  | 'http-hooks-not-allowed'
  | 'wsl-transport-unavailable'
  | 'settings-create-failed'
  | 'hook-ingress-unavailable'
  | 'hook-handshake-timeout'
  | 'hook-timeout'
  | 'silent-session'
  | 'stale-request'
  | 'hook-queue-overflow'
  | 'invalid-payload'
  | 'observer-disconnected'

export const CLAUDE_HOOK_CAPABILITIES: ObserverCapabilities = {
  thinking: 'phase',
  tools: 'lifecycle',
  approvals: 'structured',
  inputRequests: 'structured',
  usage: 'none',
  messages: 'none'
}

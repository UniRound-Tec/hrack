import type { ObserverCapabilities } from '../../../../shared/agent-events'

export const GROK_HOOK_FILE_NAME = 'hrack-observer.json'
export const GROK_HOOK_SCHEMA = '1'

export type GrokHookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionDenied'
  | 'Stop'
  | 'StopFailure'
  | 'StopCancelled'
  | 'Notification'
  | 'SubagentStart'
  | 'SubagentStop'

interface GrokFactBase {
  nativeSessionId: string
  nativeType: GrokHookEventName
  promptId?: string
  subagentType?: string
}

export type GrokNativeFact =
  | (GrokFactBase & {
      type: 'session-started'
      source: 'startup' | 'resume' | 'unknown'
    })
  | (GrokFactBase & { type: 'session-ended'; reason?: string })
  | (GrokFactBase & { type: 'user-prompt-submit' })
  | (GrokFactBase & {
      type: 'tool-started' | 'tool-completed' | 'tool-failed'
      toolCallId: string
      toolName: string
    })
  | (GrokFactBase & {
      type: 'permission-requested'
      toolCallId?: string
      toolName: string
    })
  | (GrokFactBase & {
      type: 'permission-denied'
      toolCallId?: string
      toolName?: string
    })
  | (GrokFactBase & {
      type: 'stopped'
      reason?: string
      stopHookActive: boolean
    })
  | (GrokFactBase & { type: 'turn-failed'; errorType: string })
  | (GrokFactBase & {
      type: 'cancelled'
      reason: string
      cancelledBy?: string
    })
  | (GrokFactBase & {
      type: 'subagent-activity'
      phase: 'started' | 'stopped'
    })

export const GROK_HOOK_CAPABILITIES: ObserverCapabilities = {
  thinking: 'phase',
  tools: 'lifecycle',
  approvals: 'structured',
  inputRequests: 'none',
  usage: 'none',
  messages: 'none'
}

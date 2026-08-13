import type { ObserverCapabilities } from '../../../../shared/agent-events'

export type KimiHookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'PermissionResult'
  | 'Interrupt'
  | 'Stop'
  | 'StopFailure'
  | 'SubagentStart'
  | 'SubagentStop'

interface KimiFactBase {
  nativeSessionId: string
  nativeType: KimiHookEventName
}

export type KimiNativeFact =
  | (KimiFactBase & {
      type: 'session-started'
      source: 'startup' | 'resume' | 'unknown'
    })
  | (KimiFactBase & {
      type: 'session-ended'
    })
  | (KimiFactBase & {
      type: 'user-prompt-submit'
      isSteer: boolean
    })
  | (KimiFactBase & {
      type: 'tool-started' | 'tool-completed' | 'tool-failed'
      toolCallId: string
      toolName: string
    })
  | (KimiFactBase & {
      type: 'permission-requested'
      nativeTurnId?: string
      toolCallId: string
      toolName: string
    })
  | (KimiFactBase & {
      type: 'permission-resolved'
      nativeTurnId?: string
      toolCallId: string
      decision: 'approved' | 'denied' | 'cancelled'
    })
  | (KimiFactBase & {
      type: 'interrupted'
      nativeTurnId?: string
    })
  | (KimiFactBase & {
      type: 'turn-failed'
      errorType: string
    })
  | (KimiFactBase & {
      type: 'stopped'
      stopHookActive: boolean
    })
  | (KimiFactBase & {
      type: 'subagent-activity'
      phase: 'started' | 'stopped'
    })

export const KIMI_HOOK_CAPABILITIES: ObserverCapabilities = {
  thinking: 'phase',
  tools: 'lifecycle',
  approvals: 'structured',
  inputRequests: 'none',
  usage: 'none',
  messages: 'none'
}

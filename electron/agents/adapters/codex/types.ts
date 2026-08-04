export type CodexHookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'SubagentStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'PreCompact'
  | 'PostCompact'
  | 'SubagentStop'
  | 'Stop'

interface CodexFactBase {
  nativeSessionId: string
  nativeType: CodexHookEventName
}

export type CodexNativeFact =
  | (CodexFactBase & {
      type: 'session-started'
      source: 'startup' | 'resume' | 'clear' | 'compact' | 'unknown'
    })
  | (CodexFactBase & { type: 'session-ended' })
  | (CodexFactBase & {
      type: 'subagent-started' | 'subagent-completed'
      turnId: string
      agentId: string
    })
  | (CodexFactBase & {
      type: 'compact-started' | 'compact-completed'
      turnId: string
      trigger: 'manual' | 'auto' | 'unknown'
    })
  | (CodexFactBase & { type: 'user-prompt-submit'; turnId: string })
  | (CodexFactBase & {
      type: 'tool-started' | 'tool-completed'
      turnId: string
      toolUseId: string
      toolName: string
      summary?: string
    })
  | (CodexFactBase & {
      type: 'permission-requested'
      turnId: string
      toolName: string
      summary?: string
    })
  | (CodexFactBase & {
      type: 'stopped'
      turnId: string
      stopHookActive: boolean
    })

export const CODEX_HOOK_CAPABILITIES = {
  thinking: 'phase',
  tools: 'lifecycle',
  approvals: 'structured',
  inputRequests: 'none',
  usage: 'none',
  messages: 'none'
} as const

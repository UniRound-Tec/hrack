import type { ObserverCapabilities } from '../../../../shared/agent-events'

export type OpenCodeSessionStatus = 'idle' | 'busy' | 'retry' | 'error'

export interface OpenCodeSessionInfo {
  id: string
  directory?: string
  parentId?: string
  createdAt?: number
  updatedAt?: number
}

interface OpenCodeFactBase {
  nativeType: string
  sessionId?: string
}

export type OpenCodeNativeFact =
  | (OpenCodeFactBase & { type: 'server-connected' })
  | (OpenCodeFactBase & { type: 'session-created'; info: OpenCodeSessionInfo })
  | (OpenCodeFactBase & { type: 'session-updated'; info: OpenCodeSessionInfo })
  | (OpenCodeFactBase & { type: 'session-deleted'; sessionId: string })
  | (OpenCodeFactBase & {
      type: 'session-status'
      sessionId: string
      status: OpenCodeSessionStatus
      attempt?: number
      message?: string
    })
  | (OpenCodeFactBase & { type: 'session-idle'; sessionId: string })
  | (OpenCodeFactBase & {
      type: 'session-error'
      sessionId?: string
      message: string
      retryable: boolean
      cancelled: boolean
    })
  | (OpenCodeFactBase & {
      type: 'message-user'
      sessionId: string
      messageId: string
    })
  | (OpenCodeFactBase & {
      type: 'message-assistant-completed'
      sessionId: string
      messageId: string
      inputTokens?: number
      outputTokens?: number
      cachedInputTokens?: number
      costUsd?: number
    })
  | (OpenCodeFactBase & {
      type: 'reasoning'
      sessionId: string
      messageId: string
      partId: string
      completed: boolean
    })
  | (OpenCodeFactBase & {
      type: 'text-completed'
      sessionId: string
      messageId: string
      partId: string
    })
  | (OpenCodeFactBase & {
      type: 'tool'
      sessionId: string
      messageId: string
      partId: string
      callId: string
      name: string
      state: 'pending' | 'running' | 'completed' | 'error'
      title?: string
      startedAt?: number
      endedAt?: number
      error?: string
    })
  | (OpenCodeFactBase & {
      type: 'step-finished'
      sessionId: string
      messageId: string
      partId: string
      inputTokens?: number
      outputTokens?: number
      cachedInputTokens?: number
      costUsd?: number
    })
  | (OpenCodeFactBase & {
      type: 'permission-asked'
      sessionId: string
      requestId: string
      callId?: string
      permission?: string
      title?: string
    })
  | (OpenCodeFactBase & {
      type: 'permission-replied'
      sessionId: string
      requestId: string
      response: string
    })
  | (OpenCodeFactBase & {
      type: 'question-asked'
      sessionId: string
      requestId: string
      prompt?: string
    })
  | (OpenCodeFactBase & {
      type: 'question-resolved'
      sessionId: string
      requestId: string
    })

export interface OpenCodeSnapshot {
  sessions: OpenCodeSessionInfo[]
  statuses: Map<string, OpenCodeSessionStatus>
}

export type OpenCodeObserverDegradedReason =
  | 'unsupported-version'
  | 'unsupported-command-shape'
  | 'server-argument-conflict'
  | 'unsafe-server-binding'
  | 'port-unavailable'
  | 'server-not-ready'
  | 'server-auth-required'
  | 'server-identity-mismatch'
  | 'sse-handshake-timeout'
  | 'sse-protocol-invalid'
  | 'sse-event-too-large'
  | 'schema-unsupported'
  | 'reconcile-unavailable'
  | 'session-not-found'
  | 'session-ambiguous'
  | 'wsl-sse-client-unavailable'
  | 'wsl-helper-exited'
  | 'reconnect-exhausted'
  | 'observer-disconnected'

export const OPENCODE_CAPABILITIES: ObserverCapabilities = {
  thinking: 'phase',
  tools: 'progress',
  approvals: 'structured',
  inputRequests: 'structured',
  usage: 'tokens',
  messages: 'summary'
}

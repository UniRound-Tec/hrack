import type { ObserverCapabilities } from '../../../../shared/agent-events'

export type PiSessionStartReason =
  | 'startup'
  | 'reload'
  | 'new'
  | 'resume'
  | 'fork'

export type PiSessionShutdownReason =
  | 'quit'
  | 'reload'
  | 'new'
  | 'resume'
  | 'fork'

interface PiFactBase {
  sessionId: string
  generation: string
  seq: number
  emittedAt: number
  nativeType: string
}

export type PiNativeFact =
  | (PiFactBase & {
      type: 'session-start'
      reason: PiSessionStartReason
    })
  | (PiFactBase & {
      type: 'tool-start'
      callId: string
      toolName: string
    })
  | (PiFactBase & {
      type: 'tool-progress'
      callId: string
      toolName: string
    })
  | (PiFactBase & {
      type: 'tool-end'
      callId: string
      toolName: string
      isError: boolean
      durationMs?: number
    })
  | (PiFactBase & {
      type: 'session-shutdown'
      reason: PiSessionShutdownReason
    })
  | (PiFactBase & { type: 'run-start' })
  | (PiFactBase & {
      type: 'run-end'
      outcome: 'completed' | 'cancelled' | 'failed'
    })
  | (PiFactBase & { type: 'run-settled' })
  | (PiFactBase & {
      type: 'observer-degraded'
      reason: 'settle-ambiguous'
    })
  | (PiFactBase & { type: 'thinking-start' | 'thinking-end' | 'responding' })
  | (PiFactBase & {
      type: 'compact-start' | 'compact-end'
      reason: 'manual' | 'threshold' | 'overflow'
      willRetry: boolean
    })
  | (PiFactBase & {
      type: 'usage'
      inputTokens?: number
      outputTokens?: number
      cachedInputTokens?: number
      contextTokens?: number
      contextWindow?: number
      costUsd?: number
      scope: 'turn' | 'session'
    })

export const PI_OBSERVER_CAPABILITIES: ObserverCapabilities = {
  thinking: 'phase',
  tools: 'progress',
  approvals: 'none',
  inputRequests: 'none',
  usage: 'tokens-and-context',
  messages: 'none'
}

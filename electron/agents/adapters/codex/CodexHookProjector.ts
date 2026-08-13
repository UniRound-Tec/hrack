import type { AdapterEvent } from '../types'
import type { CodexNativeFact } from './types'

function nativeEvent(
  event: AdapterEvent,
  nativeId: string,
  nativeType: string
): AdapterEvent {
  return { ...event, nativeId, nativeType }
}

export class CodexHookProjector {
  private activeTurnId: string | undefined
  private activeNativeTurnId: string | undefined
  private thinking = false
  private readonly completedTurns = new Set<string>()
  private readonly promptTurns = new Set<string>()
  private readonly tools = new Map<
    string,
    { name: string; nativeTurnId: string; turnId: string; terminal: boolean }
  >()
  private readonly approvals = new Map<
    string,
    { callId?: string; turnId: string }
  >()
  private approvalCounter = 0
  private continuationCounter = 0

  project(fact: CodexNativeFact, now = Date.now()): AdapterEvent[] {
    if (fact.type === 'session-started') {
      if (fact.source === 'compact' && this.activeTurnId) return []
      this.resetCorrelation()
      return [
        nativeEvent(
          {
            kind: 'session.idle',
            payload: {
              since: now,
              reason: 'protocol-idle',
              confidence: 'high'
            }
          },
          `${fact.nativeSessionId}:session-started:${fact.source}`,
          fact.nativeType
        )
      ]
    }

    if (fact.type === 'session-ended') {
      const events: AdapterEvent[] = []
      if (this.activeTurnId) {
        this.closeNativeOccurrence(this.activeTurnId)
        events.push(
          nativeEvent(
            {
              kind: 'turn.completed',
              payload: { turnId: this.activeTurnId, outcome: 'cancelled' }
            },
            `${fact.nativeSessionId}:${this.activeTurnId}:session-end`,
            fact.nativeType
          )
        )
      }
      this.resetCorrelation()
      events.push(
        nativeEvent(
          {
            kind: 'session.idle',
            payload: {
              since: now,
              reason: 'protocol-idle',
              confidence: 'high'
            }
          },
          `${fact.nativeSessionId}:session-ended:${now}`,
          fact.nativeType
        )
      )
      return events
    }

    if (fact.type === 'user-prompt-submit') {
      if (this.promptTurns.has(fact.turnId)) return []
      this.promptTurns.add(fact.turnId)
      if (this.publicTurnIdFor(fact.turnId)) return []
      this.completedTurns.delete(fact.turnId)
      this.activeTurnId = fact.turnId
      this.activeNativeTurnId = fact.turnId
      this.thinking = true
      return [
        nativeEvent(
          { kind: 'turn.started', payload: { turnId: fact.turnId } },
          `${fact.nativeSessionId}:${fact.turnId}:started`,
          fact.nativeType
        ),
        nativeEvent(
          { kind: 'thinking.started', payload: { turnId: fact.turnId } },
          `${fact.nativeSessionId}:${fact.turnId}:thinking:started`,
          fact.nativeType
        )
      ]
    }

    if (fact.type === 'compact-started' || fact.type === 'compact-completed') {
      // Compaction is private activity inside an already-active turn. Keeping
      // the turn open preserves working state without polluting tool metrics.
      return []
    }

    if (fact.type === 'subagent-started') {
      const callId = `codex:agent:${fact.agentId}`
      if (this.tools.has(callId)) return []
      const events: AdapterEvent[] = this.reopenCompletedTurn(
        fact.nativeSessionId,
        fact.turnId,
        fact.nativeType
      )
      const turnId = this.publicTurnIdFor(fact.turnId)
      if (!turnId) return events
      this.tools.set(callId, {
        name: 'Agent',
        nativeTurnId: fact.turnId,
        turnId,
        terminal: false
      })
      if (this.thinking && this.activeTurnId === turnId) {
        this.thinking = false
        events.push(
          nativeEvent(
            { kind: 'thinking.completed', payload: { turnId } },
            `${fact.nativeSessionId}:${turnId}:thinking:completed`,
            fact.nativeType
          )
        )
      }
      events.push(
        nativeEvent(
          {
            kind: 'tool.started',
            payload: {
              callId,
              turnId,
              name: 'Agent',
              category: 'other'
            }
          },
          `${fact.nativeSessionId}:${turnId}:${callId}:started`,
          fact.nativeType
        )
      )
      return events
    }

    if (fact.type === 'subagent-completed') {
      const callId = `codex:agent:${fact.agentId}`
      const tool = this.tools.get(callId)
      if (!tool || tool.terminal) return []
      tool.terminal = true
      return [
        nativeEvent(
          {
            kind: 'tool.completed',
            payload: { callId, turnId: tool.turnId }
          },
          `${fact.nativeSessionId}:${tool.turnId}:${callId}:completed`,
          fact.nativeType
        )
      ]
    }

    if (fact.type === 'tool-started') {
      if (this.tools.has(fact.toolUseId)) return []
      const events: AdapterEvent[] = this.reopenCompletedTurn(
        fact.nativeSessionId,
        fact.turnId,
        fact.nativeType
      )
      const turnId = this.publicTurnIdFor(fact.turnId)
      if (!turnId) return events
      this.tools.set(fact.toolUseId, {
        name: fact.toolName,
        nativeTurnId: fact.turnId,
        turnId,
        terminal: false
      })
      if (this.thinking && this.activeTurnId === turnId) {
        this.thinking = false
        events.push(
          nativeEvent(
            { kind: 'thinking.completed', payload: { turnId } },
            `${fact.nativeSessionId}:${turnId}:thinking:completed`,
            fact.nativeType
          )
        )
      }
      events.push(
        nativeEvent(
          {
            kind: 'tool.started',
            payload: {
              callId: fact.toolUseId,
              turnId,
              name: fact.toolName,
              category: toolCategory(fact.toolName)
            }
          },
          `${fact.nativeSessionId}:${turnId}:tool:${fact.toolUseId}:started`,
          fact.nativeType
        )
      )
      return events
    }

    if (fact.type === 'permission-requested') {
      const events = this.reopenCompletedTurn(
        fact.nativeSessionId,
        fact.turnId,
        fact.nativeType
      )
      const turnId = this.publicTurnIdFor(fact.turnId)
      if (!turnId) return events
      const candidates = [...this.tools.entries()].filter(
        ([, tool]) =>
          !tool.terminal &&
          tool.nativeTurnId === fact.turnId &&
          tool.name === fact.toolName
      )
      const callId = candidates.length === 1 ? candidates[0][0] : undefined
      const requestId = callId
        ? `codex:approval:${callId}`
        : `codex:approval:${turnId}:unmatched:${++this.approvalCounter}`
      if (this.approvals.has(requestId)) return []
      this.approvals.set(requestId, { callId, turnId })
      events.push(
        nativeEvent(
          {
            kind: 'approval.requested',
            payload: {
              requestId,
              turnId,
              callId,
              category: approvalCategory(fact.toolName),
              summary: fact.summary
            }
          },
          `${fact.nativeSessionId}:${requestId}:requested`,
          fact.nativeType
        )
      )
      return events
    }

    if (fact.type === 'tool-completed') {
      let tool = this.tools.get(fact.toolUseId)
      if (tool?.terminal) return []
      const events: AdapterEvent[] = this.reopenCompletedTurn(
        fact.nativeSessionId,
        fact.turnId,
        fact.nativeType
      )
      if (!tool) {
        const turnId = this.publicTurnIdFor(fact.turnId)
        if (!turnId) return events
        tool = {
          name: fact.toolName,
          nativeTurnId: fact.turnId,
          turnId,
          terminal: false
        }
        this.tools.set(fact.toolUseId, tool)
        events.push(
          nativeEvent(
            {
              kind: 'tool.started',
              payload: {
                callId: fact.toolUseId,
                turnId,
                name: fact.toolName,
                category: toolCategory(fact.toolName)
              }
            },
            `${fact.nativeSessionId}:${turnId}:tool:${fact.toolUseId}:synthetic-start`,
            fact.nativeType
          )
        )
      }
      tool.terminal = true
      events.push(
        nativeEvent(
          {
            kind: 'tool.completed',
            payload: { callId: fact.toolUseId, turnId: tool.turnId }
          },
          `${fact.nativeSessionId}:${tool.turnId}:tool:${fact.toolUseId}:completed`,
          fact.nativeType
        )
      )
      return events
    }

    if (this.completedTurns.has(fact.turnId)) return []
    const turnId = this.publicTurnIdFor(fact.turnId)
    if (!turnId) return []
    this.completedTurns.add(fact.turnId)
    this.closeNativeOccurrence(turnId)
    const events: AdapterEvent[] = [
      nativeEvent(
        {
          kind: 'turn.completed',
          payload: { turnId, outcome: 'completed' }
        },
        `${fact.nativeSessionId}:${turnId}:completed`,
        fact.nativeType
      )
    ]
    if (this.activeTurnId === turnId) {
      this.activeTurnId = undefined
      this.activeNativeTurnId = undefined
      this.thinking = false
    }
    return events
  }

  private reopenCompletedTurn(
    nativeSessionId: string,
    nativeTurnId: string,
    nativeType: string
  ): AdapterEvent[] {
    if (this.activeNativeTurnId === nativeTurnId && this.activeTurnId) return []
    const continuation = this.completedTurns.delete(nativeTurnId)
    const turnId = continuation
      ? `${nativeTurnId}:continuation:${++this.continuationCounter}`
      : nativeTurnId
    this.activeNativeTurnId = nativeTurnId
    this.activeTurnId = turnId
    this.thinking = false
    return [
      nativeEvent(
        { kind: 'turn.started', payload: { turnId } },
        `${nativeSessionId}:${turnId}:${continuation ? 'continued' : 'implicit'}`,
        nativeType
      )
    ]
  }

  private publicTurnIdFor(nativeTurnId: string): string | undefined {
    return this.activeNativeTurnId === nativeTurnId
      ? this.activeTurnId
      : undefined
  }

  private closeNativeOccurrence(turnId: string): void {
    for (const [requestId, approval] of this.approvals) {
      if (approval.turnId !== turnId) continue
      this.approvals.delete(requestId)
    }
    for (const tool of this.tools.values()) {
      if (tool.turnId !== turnId) continue
      tool.terminal = true
    }
  }

  private resetCorrelation(): void {
    this.activeTurnId = undefined
    this.activeNativeTurnId = undefined
    this.thinking = false
    this.completedTurns.clear()
    this.promptTurns.clear()
    this.tools.clear()
    this.approvals.clear()
  }
}

function toolCategory(
  name: string
): 'read' | 'edit' | 'shell' | 'search' | 'network' | 'mcp' | 'other' {
  const lower = name.toLowerCase()
  if (lower === 'bash' || lower === 'shell') return 'shell'
  if (lower === 'apply_patch' || lower === 'edit' || lower === 'write') {
    return 'edit'
  }
  if (lower.startsWith('mcp__')) return 'mcp'
  return 'other'
}

function approvalCategory(
  name: string
): 'tool' | 'command' | 'file-change' | 'network' | 'other' {
  const category = toolCategory(name)
  if (category === 'shell') return 'command'
  if (category === 'edit') return 'file-change'
  return category === 'other' ? 'other' : 'tool'
}

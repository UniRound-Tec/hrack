import type { AdapterEvent } from '../types'
import type { KimiNativeFact } from './types'

const MAX_REMEMBERED_CORRELATIONS = 10_000

function nativeEvent(
  event: AdapterEvent,
  nativeId: string,
  nativeType: string
): AdapterEvent {
  return { ...event, nativeId, nativeType }
}

function toolKey(nativeSessionId: string, callId: string): string {
  return `${nativeSessionId}\u0000${callId}`
}

function approvalId(nativeSessionId: string, callId: string): string {
  return `kimi:approval:${nativeSessionId}:${callId}`
}

export class KimiHookProjector {
  private activeTurnId: string | undefined
  private continuationAvailable = false
  private thinking = false
  private turnCounter = 0
  private continuationCounter = 0
  private completionCounter = 0
  private readonly tools = new Map<
    string,
    { callId: string; turnId: string; name: string; terminal: boolean }
  >()
  private readonly seenApprovalRequests = new Set<string>()
  private readonly seenApprovalResults = new Set<string>()

  project(fact: KimiNativeFact, now = Date.now()): AdapterEvent[] {
    if (fact.type === 'session-started') {
      const events = this.completeActiveTurn(
        fact.nativeSessionId,
        fact.nativeType,
        'cancelled',
        'session-reset',
        false
      )
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
          `${fact.nativeSessionId}:session-started:${fact.source}`,
          fact.nativeType
        )
      )
      return events
    }

    if (fact.type === 'session-ended') {
      const events = this.completeActiveTurn(
        fact.nativeSessionId,
        fact.nativeType,
        'cancelled',
        'session-end',
        false
      )
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
          `${fact.nativeSessionId}:session-ended`,
          fact.nativeType
        )
      )
      return events
    }

    if (fact.type === 'user-prompt-submit') {
      if (fact.isSteer) {
        return this.ensureActivityTurn(fact.nativeSessionId, fact.nativeType).events
      }

      const events = this.completeActiveTurn(
        fact.nativeSessionId,
        fact.nativeType,
        'cancelled',
        'superseded',
        false
      )
      this.continuationAvailable = false
      const turnId = `kimi:${fact.nativeSessionId}:turn:${++this.turnCounter}`
      this.activeTurnId = turnId
      this.thinking = true
      events.push(
        nativeEvent(
          { kind: 'turn.started', payload: { turnId } },
          `${fact.nativeSessionId}:${turnId}:started`,
          fact.nativeType
        ),
        nativeEvent(
          { kind: 'thinking.started', payload: { turnId } },
          `${fact.nativeSessionId}:${turnId}:thinking:started`,
          fact.nativeType
        )
      )
      return events
    }

    if (fact.type === 'tool-started') {
      const key = toolKey(fact.nativeSessionId, fact.toolCallId)
      if (this.tools.has(key)) return []
      const activity = this.ensureActivityTurn(
        fact.nativeSessionId,
        fact.nativeType
      )
      if (!activity.turnId) return []
      const turnId = activity.turnId
      const events = activity.events
      this.rememberMap(this.tools, key, {
        callId: fact.toolCallId,
        turnId,
        name: fact.toolName,
        terminal: false
      })
      events.push(...this.completeThinking(fact.nativeSessionId, turnId, fact.nativeType))
      events.push(
        nativeEvent(
          {
            kind: 'tool.started',
            payload: {
              callId: fact.toolCallId,
              turnId,
              name: fact.toolName,
              category: toolCategory(fact.toolName)
            }
          },
          `${fact.nativeSessionId}:${turnId}:tool:${fact.toolCallId}:started`,
          fact.nativeType
        )
      )
      return events
    }

    if (fact.type === 'permission-requested') {
      const requestId = approvalId(fact.nativeSessionId, fact.toolCallId)
      if (this.seenApprovalRequests.has(requestId)) return []
      this.rememberSet(this.seenApprovalRequests, requestId)
      const tool = this.tools.get(toolKey(fact.nativeSessionId, fact.toolCallId))
      const activity = tool
        ? { turnId: tool.turnId, events: [] as AdapterEvent[] }
        : this.ensureActivityTurn(fact.nativeSessionId, fact.nativeType)
      if (!activity.turnId) return []
      const events = activity.events
      events.push(
        nativeEvent(
          {
            kind: 'approval.requested',
            payload: {
              requestId,
              turnId: activity.turnId,
              callId: fact.toolCallId,
              category: approvalCategory(fact.toolName),
              summary: `Approve ${fact.toolName}`
            }
          },
          `${fact.nativeSessionId}:${requestId}:requested`,
          fact.nativeType
        )
      )
      return events
    }

    if (fact.type === 'permission-resolved') {
      const requestId = approvalId(fact.nativeSessionId, fact.toolCallId)
      if (this.seenApprovalResults.has(requestId)) return []
      this.rememberSet(this.seenApprovalResults, requestId)
      return [
        nativeEvent(
          {
            kind: 'approval.resolved',
            payload: { requestId, decision: fact.decision }
          },
          `${fact.nativeSessionId}:${requestId}:resolved:${fact.decision}`,
          fact.nativeType
        )
      ]
    }

    if (fact.type === 'tool-completed' || fact.type === 'tool-failed') {
      return this.projectToolTerminal(fact, fact.type)
    }

    if (fact.type === 'subagent-activity') {
      if (fact.phase === 'stopped') return []
      return this.ensureActivityTurn(fact.nativeSessionId, fact.nativeType).events
    }

    if (fact.type === 'interrupted') {
      return this.completeActiveTurn(
        fact.nativeSessionId,
        fact.nativeType,
        'cancelled',
        'interrupted',
        false
      )
    }

    if (fact.type === 'turn-failed') {
      if (!this.activeTurnId) return []
      const turnId = this.activeTurnId
      this.closeNativeTurn(turnId)
      const events: AdapterEvent[] = []
      events.push(
        nativeEvent(
          {
            kind: 'turn.failed',
            payload: {
              turnId,
              message: `Kimi turn failed: ${fact.errorType}`
            }
          },
          `${fact.nativeSessionId}:${turnId}:failed:${fact.errorType}:${++this.completionCounter}`,
          fact.nativeType
        )
      )
      this.activeTurnId = undefined
      this.continuationAvailable = false
      this.thinking = false
      return events
    }

    if (fact.type === 'stopped') {
      return this.completeActiveTurn(
        fact.nativeSessionId,
        fact.nativeType,
        'completed',
        'completed',
        true
      )
    }

    return []
  }

  private projectToolTerminal(
    fact: {
      nativeSessionId: string
      nativeType: string
      toolCallId: string
      toolName: string
    },
    terminalType: 'tool-completed' | 'tool-failed'
  ): AdapterEvent[] {
    const key = toolKey(fact.nativeSessionId, fact.toolCallId)
    let tool = this.tools.get(key)
    if (tool?.terminal) return []
    const events: AdapterEvent[] = []
    if (!tool) {
      const activity = this.ensureActivityTurn(
        fact.nativeSessionId,
        fact.nativeType
      )
      if (!activity.turnId) return []
      events.push(...activity.events)
      const turnId = activity.turnId
      tool = {
        callId: fact.toolCallId,
        turnId,
        name: fact.toolName,
        terminal: false
      }
      this.rememberMap(this.tools, key, tool)
      events.push(...this.completeThinking(fact.nativeSessionId, turnId, fact.nativeType))
      events.push(
        nativeEvent(
          {
            kind: 'tool.started',
            payload: {
              callId: fact.toolCallId,
              turnId,
              name: fact.toolName,
              category: toolCategory(fact.toolName)
            }
          },
          `${fact.nativeSessionId}:${turnId}:tool:${fact.toolCallId}:synthetic-start`,
          fact.nativeType
        )
      )
    }

    tool.terminal = true
    events.push(
      terminalType === 'tool-completed'
        ? nativeEvent(
            {
              kind: 'tool.completed',
              payload: { callId: fact.toolCallId, turnId: tool.turnId }
            },
            `${fact.nativeSessionId}:${tool.turnId}:tool:${fact.toolCallId}:completed`,
            fact.nativeType
          )
        : nativeEvent(
            {
              kind: 'tool.failed',
              payload: {
                callId: fact.toolCallId,
                turnId: tool.turnId,
                message: 'Tool failed'
              }
            },
            `${fact.nativeSessionId}:${tool.turnId}:tool:${fact.toolCallId}:failed`,
            fact.nativeType
          )
    )
    return events
  }

  private ensureActivityTurn(
    nativeSessionId: string,
    nativeType: string
  ): { turnId?: string; events: AdapterEvent[] } {
    if (this.activeTurnId) return { turnId: this.activeTurnId, events: [] }
    if (!this.continuationAvailable) return { events: [] }
    const turnId = `kimi:${nativeSessionId}:turn:${++this.turnCounter}`
    this.continuationAvailable = false
    this.activeTurnId = turnId
    this.thinking = false
    return {
      turnId,
      events: [
        nativeEvent(
          { kind: 'turn.started', payload: { turnId } },
          `${nativeSessionId}:${turnId}:continued:${++this.continuationCounter}`,
          nativeType
        )
      ]
    }
  }

  private completeActiveTurn(
    nativeSessionId: string,
    nativeType: string,
    outcome: 'completed' | 'cancelled',
    reason: string,
    continuable: boolean
  ): AdapterEvent[] {
    if (!this.activeTurnId) return []
    const turnId = this.activeTurnId
    this.closeNativeTurn(turnId)
    const events: AdapterEvent[] = []
    events.push(
      nativeEvent(
        { kind: 'turn.completed', payload: { turnId, outcome } },
        `${nativeSessionId}:${turnId}:${reason}:${++this.completionCounter}`,
        nativeType
      )
    )
    this.activeTurnId = undefined
    this.continuationAvailable = continuable
    this.thinking = false
    return events
  }

  private completeThinking(
    nativeSessionId: string,
    turnId: string,
    nativeType: string,
    reason = 'completed'
  ): AdapterEvent[] {
    if (!this.thinking || this.activeTurnId !== turnId) return []
    this.thinking = false
    return [
      nativeEvent(
        { kind: 'thinking.completed', payload: { turnId } },
        `${nativeSessionId}:${turnId}:thinking:${reason}`,
        nativeType
      )
    ]
  }

  private closeNativeTurn(turnId: string): void {
    for (const tool of this.tools.values()) {
      if (tool.turnId !== turnId) continue
      tool.terminal = true
    }
  }

  private rememberSet(set: Set<string>, value: string): void {
    if (set.size >= MAX_REMEMBERED_CORRELATIONS) set.clear()
    set.add(value)
  }

  private rememberMap<T>(map: Map<string, T>, key: string, value: T): void {
    if (map.size >= MAX_REMEMBERED_CORRELATIONS) {
      const oldest = map.keys().next().value as string | undefined
      if (oldest !== undefined) map.delete(oldest)
    }
    map.set(key, value)
  }

  private resetCorrelation(): void {
    this.activeTurnId = undefined
    this.continuationAvailable = false
    this.thinking = false
    this.tools.clear()
    this.seenApprovalRequests.clear()
    this.seenApprovalResults.clear()
  }
}

function toolCategory(
  name: string
): 'read' | 'edit' | 'shell' | 'search' | 'network' | 'mcp' | 'other' {
  const lower = name.toLowerCase()
  if (lower === 'bash' || lower === 'shell') return 'shell'
  if (lower.includes('read')) return 'read'
  if (lower.includes('write') || lower.includes('edit') || lower === 'apply_patch') {
    return 'edit'
  }
  if (lower.includes('search') || lower === 'grep' || lower === 'glob') return 'search'
  if (
    lower.includes('fetch') ||
    lower.includes('http') ||
    lower.includes('network') ||
    lower === 'web'
  ) {
    return 'network'
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
  if (category === 'network') return 'network'
  return category === 'other' ? 'other' : 'tool'
}

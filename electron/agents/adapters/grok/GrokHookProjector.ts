import type { AdapterEvent } from '../types'
import type { GrokNativeFact } from './types'

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

function approvalId(
  nativeSessionId: string,
  callId: string | undefined,
  promptId: string | undefined,
  toolName: string
): string {
  return `grok:approval:${nativeSessionId}:${callId ?? promptId ?? toolName}`
}

export class GrokHookProjector {
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
  private readonly pendingApprovals = new Map<
    string,
    { requestId: string; callId?: string }
  >()

  project(fact: GrokNativeFact, now = Date.now()): AdapterEvent[] {
    if (fact.subagentType && fact.type !== 'subagent-activity') {
      if (
        fact.type === 'tool-started' ||
        fact.type === 'tool-completed' ||
        fact.type === 'tool-failed'
      ) {
        return this.projectNestedTool(fact)
      }
      return []
    }

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
      const events = this.completeActiveTurn(
        fact.nativeSessionId,
        fact.nativeType,
        'cancelled',
        'superseded',
        false
      )
      this.continuationAvailable = false
      const turnId = `grok:${fact.nativeSessionId}:turn:${++this.turnCounter}`
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
      return this.projectToolStart(fact)
    }

    if (fact.type === 'tool-completed' || fact.type === 'tool-failed') {
      return this.projectToolTerminal(fact, fact.type)
    }

    if (fact.type === 'permission-requested') {
      return this.projectPermissionRequested(fact)
    }

    if (fact.type === 'permission-denied') {
      return this.projectPermissionResolved(
        fact,
        'denied',
        fact.toolCallId,
        fact.toolName
      )
    }

    if (fact.type === 'subagent-activity') {
      if (fact.phase === 'stopped') return []
      return this.ensureActivityTurn(fact.nativeSessionId, fact.nativeType).events
    }

    if (fact.type === 'cancelled') {
      const events: AdapterEvent[] = []
      if (
        fact.reason === 'permission_rejected' ||
        fact.reason === 'permission_cancelled'
      ) {
        events.push(
          ...this.projectPermissionResolved(
            fact,
            fact.reason === 'permission_rejected' ? 'denied' : 'cancelled'
          )
        )
      }
      events.push(
        ...this.completeActiveTurn(
          fact.nativeSessionId,
          fact.nativeType,
          'cancelled',
          fact.reason,
          false
        )
      )
      return events
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
              message: `Grok turn failed: ${fact.errorType}`
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
      if (fact.stopHookActive) return []
      if (fact.reason && fact.reason !== 'end_turn') {
        return this.completeActiveTurn(
          fact.nativeSessionId,
          fact.nativeType,
          'cancelled',
          fact.reason,
          false
        )
      }
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

  private projectNestedTool(
    fact: Extract<
      GrokNativeFact,
      { type: 'tool-started' | 'tool-completed' | 'tool-failed' }
    >
  ): AdapterEvent[] {
    if (fact.type === 'tool-started') return this.projectToolStart(fact)
    return this.projectToolTerminal(fact, fact.type)
  }

  private projectToolStart(fact: {
    nativeSessionId: string
    nativeType: string
    toolCallId: string
    toolName: string
  }): AdapterEvent[] {
    const key = toolKey(fact.nativeSessionId, fact.toolCallId)
    if (this.tools.has(key)) return []
    const activity = this.ensureActivityTurn(fact.nativeSessionId, fact.nativeType)
    if (!activity.turnId) return []
    const turnId = activity.turnId
    const events = activity.events
    this.rememberMap(this.tools, key, {
      callId: fact.toolCallId,
      turnId,
      name: fact.toolName,
      terminal: false
    })
    events.push(
      ...this.completeThinking(fact.nativeSessionId, turnId, fact.nativeType)
    )
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

  private projectPermissionRequested(fact: {
    nativeSessionId: string
    nativeType: string
    promptId?: string
    toolCallId?: string
    toolName: string
  }): AdapterEvent[] {
    const requestId = approvalId(
      fact.nativeSessionId,
      fact.toolCallId,
      fact.promptId,
      fact.toolName
    )
    if (this.seenApprovalRequests.has(requestId)) return []
    this.rememberSet(this.seenApprovalRequests, requestId)
    const tool = fact.toolCallId
      ? this.tools.get(toolKey(fact.nativeSessionId, fact.toolCallId))
      : undefined
    const activity = tool
      ? { turnId: tool.turnId, events: [] as AdapterEvent[] }
      : this.ensureActivityTurn(fact.nativeSessionId, fact.nativeType)
    if (!activity.turnId) return []
    this.rememberMap(this.pendingApprovals, requestId, {
      requestId,
      callId: fact.toolCallId
    })
    return [
      ...activity.events,
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
    ]
  }

  private projectPermissionResolved(
    fact: { nativeSessionId: string; nativeType: string },
    decision: 'approved' | 'denied' | 'cancelled',
    toolCallId?: string,
    toolName?: string
  ): AdapterEvent[] {
    const matched = this.matchPendingApproval(toolCallId, toolName)
    if (!matched) return []
    if (this.seenApprovalResults.has(matched.requestId)) return []
    this.rememberSet(this.seenApprovalResults, matched.requestId)
    this.pendingApprovals.delete(matched.requestId)
    return [
      nativeEvent(
        {
          kind: 'approval.resolved',
          payload: { requestId: matched.requestId, decision }
        },
        `${fact.nativeSessionId}:${matched.requestId}:resolved:${decision}`,
        fact.nativeType
      )
    ]
  }

  private matchPendingApproval(
    toolCallId?: string,
    _toolName?: string
  ): { requestId: string; callId?: string } | undefined {
    if (toolCallId) {
      for (const pending of this.pendingApprovals.values()) {
        if (pending.callId === toolCallId) return pending
      }
    }
    if (this.pendingApprovals.size === 1) {
      return this.pendingApprovals.values().next().value
    }
    return undefined
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
    const events: AdapterEvent[] = []
    if (tool?.terminal) {
      events.push(
        ...this.projectPermissionResolved(
          fact,
          'approved',
          fact.toolCallId,
          fact.toolName
        )
      )
      return events
    }
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
      events.push(
        ...this.completeThinking(fact.nativeSessionId, turnId, fact.nativeType)
      )
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
    if (terminalType === 'tool-completed') {
      events.push(
        ...this.projectPermissionResolved(
          fact,
          'approved',
          fact.toolCallId,
          fact.toolName
        )
      )
    }
    return events
  }

  private ensureActivityTurn(
    nativeSessionId: string,
    nativeType: string
  ): { turnId?: string; events: AdapterEvent[] } {
    if (this.activeTurnId) return { turnId: this.activeTurnId, events: [] }
    if (!this.continuationAvailable) return { events: [] }
    const turnId = `grok:${nativeSessionId}:turn:${++this.turnCounter}`
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
    const events: AdapterEvent[] = [
      nativeEvent(
        { kind: 'turn.completed', payload: { turnId, outcome } },
        `${nativeSessionId}:${turnId}:${reason}:${++this.completionCounter}`,
        nativeType
      )
    ]
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
    this.pendingApprovals.clear()
  }
}

function toolCategory(
  name: string
): 'read' | 'edit' | 'shell' | 'search' | 'network' | 'mcp' | 'other' {
  const lower = name.toLowerCase()
  if (
    lower === 'bash' ||
    lower === 'shell' ||
    lower === 'run_terminal_command' ||
    lower === 'run_terminal_cmd'
  ) {
    return 'shell'
  }
  if (lower.includes('read') || lower === 'read_file') return 'read'
  if (
    lower.includes('write') ||
    lower.includes('edit') ||
    lower === 'search_replace' ||
    lower === 'apply_patch'
  ) {
    return 'edit'
  }
  if (lower.includes('search') || lower === 'grep' || lower === 'glob') {
    return 'search'
  }
  if (
    lower.includes('fetch') ||
    lower.includes('http') ||
    lower.includes('network') ||
    lower.includes('web')
  ) {
    return 'network'
  }
  if (lower.includes('__') || lower.startsWith('mcp')) return 'mcp'
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

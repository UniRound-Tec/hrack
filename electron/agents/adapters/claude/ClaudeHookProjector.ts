import type { AdapterEvent } from '../types'
import type { ClaudeNativeFact } from './types'
import { CLAUDE_HOOK_CAPABILITIES } from './types'

const REQUEST_TTL_MS = 24 * 60 * 60 * 1_000
const MAX_SEEN_DELIVERIES = 2_048
const SHORT_DEDUPE_MS = 5_000

interface ToolState {
  id: string
  name: string
  summary?: string
  fingerprint: string
  startedAt: number
  terminal: boolean
}

interface RequestState {
  id: string
  kind: 'approval' | 'input'
  callId?: string
  expiresAt: number
}

function toolCategory(
  name: string
): 'read' | 'edit' | 'shell' | 'search' | 'network' | 'mcp' | 'other' {
  const lower = name.toLowerCase()
  if (lower === 'read') return 'read'
  if (['write', 'edit', 'multiedit', 'notebookedit'].includes(lower)) return 'edit'
  if (['bash', 'shell', 'command'].includes(lower)) return 'shell'
  if (['glob', 'grep', 'websearch', 'web_search'].includes(lower)) return 'search'
  if (['webfetch', 'web_fetch'].includes(lower)) return 'network'
  if (lower.startsWith('mcp__')) return 'mcp'
  return 'other'
}

function approvalCategory(
  name: string | undefined
): 'tool' | 'command' | 'file-change' | 'network' | 'other' {
  if (!name) return 'other'
  const category = toolCategory(name)
  if (category === 'shell') return 'command'
  if (category === 'edit') return 'file-change'
  if (category === 'network') return 'network'
  return category === 'other' ? 'other' : 'tool'
}

function nativeEvent(
  event: AdapterEvent,
  nativeId: string,
  nativeType: string
): AdapterEvent {
  return { ...event, nativeId, nativeType }
}

/**
 * Claude 私有的有状态投影器。这里吸收 tool 并发、权限关联、乱序与
 * SessionEnd reset；公共 reducer 不需要认识任何 Claude payload 字段。
 */
export class ClaudeHookProjector {
  private nativeSessionId: string | undefined
  private turnId: string | undefined
  private turnCounter = 0
  private thinking = false
  private thinkingEpoch = 0
  private requestCounter = 0
  private readonly tools = new Map<string, ToolState>()
  private readonly requests = new Map<string, RequestState>()
  private readonly seenStable = new Map<string, true>()
  private readonly seenShort = new Map<string, number>()

  project(fact: ClaudeNativeFact, now = Date.now()): AdapterEvent[] {
    const events = this.expireRequests(now)
    if (
      this.nativeSessionId &&
      fact.nativeSessionId !== this.nativeSessionId &&
      fact.type !== 'user-prompt-submit'
    ) {
      return events
    }
    if (!this.nativeSessionId) this.nativeSessionId = fact.nativeSessionId

    switch (fact.type) {
      case 'user-prompt-submit':
        events.push(...this.beginTurn(fact.nativeSessionId, fact.nativeType, now))
        break
      case 'tool-started':
        events.push(...this.startTool(fact, now))
        break
      case 'permission-requested':
        events.push(...this.requestPermission(fact, now))
        break
      case 'tool-completed':
      case 'tool-failed':
        events.push(...this.finishTool(fact, now))
        break
      case 'tool-batch-completed':
        if (this.turnId && !this.thinking && this.markShort('batch', now)) {
          this.thinking = true
          this.thinkingEpoch++
          events.push(nativeEvent(
            { kind: 'thinking.started', payload: { turnId: this.turnId } },
            `${this.turnId}:thinking:started:${this.thinkingEpoch}`,
            fact.nativeType
          ))
        }
        break
      case 'stopped':
        if (this.markShort(`stop:${this.turnId ?? 'none'}`, now)) {
          events.push(...this.completeThinking(fact.nativeType))
          if (!fact.hasRunningBackgroundTasks && this.turnId) {
            events.push(...this.interruptTools(fact.nativeType, 'Tool result unavailable'))
            events.push(...this.cancelRequests('cancelled', fact.nativeType))
            events.push(nativeEvent(
              {
                kind: 'turn.completed',
                payload: { turnId: this.turnId, outcome: 'completed' }
              },
              `${this.turnId}:completed`,
              fact.nativeType
            ))
            if (fact.hasSessionCrons) {
              events.push(nativeEvent(
                {
                  kind: 'session.idle',
                  payload: {
                    since: now,
                    reason: 'scheduled-wakeup',
                    confidence: 'high'
                  }
                },
                `${this.turnId}:scheduled-idle`,
                fact.nativeType
              ))
            }
            this.turnId = undefined
          }
        }
        break
      case 'stop-failed':
        if (this.turnId && this.markShort(`stop-failed:${this.turnId}`, now)) {
          events.push(...this.completeThinking(fact.nativeType))
          events.push(...this.interruptTools(fact.nativeType, 'Tool interrupted'))
          events.push(...this.cancelRequests('cancelled', fact.nativeType))
          events.push(nativeEvent(
            {
              kind: 'turn.failed',
              payload: { turnId: this.turnId, message: 'Claude turn failed' }
            },
            `${this.turnId}:failed`,
            fact.nativeType
          ))
          this.turnId = undefined
        }
        break
      case 'notification':
        events.push(...this.handleNotification(fact, now))
        break
      case 'session-ended':
        events.push(...this.resetNativeSession(fact.nativeType, now))
        break
    }
    return events
  }

  expireRequests(now = Date.now()): AdapterEvent[] {
    const events: AdapterEvent[] = []
    for (const request of [...this.requests.values()]) {
      if (request.expiresAt > now) continue
      this.requests.delete(request.id)
      events.push(nativeEvent(
        request.kind === 'approval'
          ? { kind: 'approval.resolved', payload: { requestId: request.id, decision: 'cancelled' } }
          : { kind: 'input.resolved', payload: { requestId: request.id } },
        `${request.id}:expired`,
        'RequestTTL'
      ))
      events.push(nativeEvent(
        {
          kind: 'observer.degraded',
          payload: { reason: 'stale-request', remaining: CLAUDE_HOOK_CAPABILITIES }
        },
        `${request.id}:stale`,
        'RequestTTL'
      ))
    }
    return events
  }

  private beginTurn(sessionId: string, nativeType: string, now: number): AdapterEvent[] {
    const events: AdapterEvent[] = []
    if (this.turnId) {
      events.push(...this.completeThinking(nativeType))
      events.push(...this.interruptTools(nativeType, 'Tool interrupted'))
      events.push(...this.cancelRequests('cancelled', nativeType))
      events.push(nativeEvent(
        {
          kind: 'turn.completed',
          payload: { turnId: this.turnId, outcome: 'cancelled' }
        },
        `${this.turnId}:superseded`,
        nativeType
      ))
    }
    this.nativeSessionId = sessionId
    this.turnId = `${sessionId}:turn:${++this.turnCounter}`
    this.thinking = true
    this.thinkingEpoch++
    this.tools.clear()
    events.push(nativeEvent(
      { kind: 'turn.started', payload: { turnId: this.turnId } },
      `${this.turnId}:started`,
      nativeType
    ))
    events.push(nativeEvent(
      { kind: 'thinking.started', payload: { turnId: this.turnId } },
      `${this.turnId}:thinking:started:${this.thinkingEpoch}`,
      nativeType
    ))
    return events
  }

  private startTool(
    fact: Extract<ClaudeNativeFact, { type: 'tool-started' }>,
    now: number
  ): AdapterEvent[] {
    const key = `${fact.nativeSessionId}:pre:${fact.toolUseId}`
    if (!this.markStable(key)) return []
    const existing = this.tools.get(fact.toolUseId)
    if (existing?.terminal) return []
    const events = this.completeThinking(fact.nativeType)
    const tool: ToolState = existing ?? {
      id: fact.toolUseId,
      name: fact.toolName,
      summary: fact.summary,
      fingerprint: fact.fingerprint,
      startedAt: now,
      terminal: false
    }
    this.tools.set(fact.toolUseId, tool)
    events.push(nativeEvent(
      {
        kind: 'tool.started',
        payload: {
          callId: tool.id,
          turnId: this.turnId,
          name: tool.name,
          category: toolCategory(tool.name)
        }
      },
      `${key}:started`,
      fact.nativeType
    ))
    if (tool.name.toLowerCase() === 'askuserquestion') {
      const requestId = `input:${tool.id}`
      this.requests.set(requestId, {
        id: requestId,
        kind: 'input',
        callId: tool.id,
        expiresAt: now + REQUEST_TTL_MS
      })
      events.push(nativeEvent(
        { kind: 'input.requested', payload: { requestId } },
        `${key}:input-requested`,
        fact.nativeType
      ))
    }
    return events
  }

  private requestPermission(
    fact: Extract<ClaudeNativeFact, { type: 'permission-requested' }>,
    now: number
  ): AdapterEvent[] {
    const candidates = [...this.tools.values()].filter(
      (tool) =>
        !tool.terminal &&
        (!fact.toolName || tool.name === fact.toolName) &&
        (!fact.fingerprint || tool.fingerprint === fact.fingerprint)
    )
    const callId = candidates.length === 1 ? candidates[0].id : undefined
    const shortKey = `permission:${fact.toolName ?? ''}:${fact.fingerprint ?? ''}:${callId ?? ''}`
    if (!this.markShort(shortKey, now)) return []
    const requestId = callId
      ? `approval:${callId}`
      : `approval:unmatched:${++this.requestCounter}`
    this.requests.set(requestId, {
      id: requestId,
      kind: 'approval',
      callId,
      expiresAt: now + REQUEST_TTL_MS
    })
    return [nativeEvent(
      {
        kind: 'approval.requested',
        payload: {
          requestId,
          callId,
          category: approvalCategory(fact.toolName),
          summary: fact.summary
        }
      },
      `${fact.nativeSessionId}:${requestId}:requested`,
      fact.nativeType
    )]
  }

  private finishTool(
    fact: Extract<ClaudeNativeFact, { type: 'tool-completed' | 'tool-failed' }>,
    now: number
  ): AdapterEvent[] {
    const discriminator = fact.type === 'tool-completed' ? 'completed' : 'failed'
    const stable = `${fact.nativeSessionId}:${discriminator}:${fact.toolUseId}`
    if (!this.markStable(stable)) return []
    let tool = this.tools.get(fact.toolUseId)
    const events: AdapterEvent[] = []
    if (!tool) {
      tool = {
        id: fact.toolUseId,
        name: fact.toolName,
        summary: fact.summary,
        fingerprint: fact.fingerprint,
        startedAt: now,
        terminal: false
      }
      this.tools.set(tool.id, tool)
      events.push(nativeEvent(
        {
          kind: 'tool.started',
          payload: {
            callId: tool.id,
            turnId: this.turnId,
            name: tool.name,
            category: toolCategory(tool.name)
          }
        },
        `${stable}:synthetic-start`,
        fact.nativeType
      ))
    }
    if (tool.terminal) return events
    tool.terminal = true

    const request = [...this.requests.values()].find(
      (candidate) => candidate.callId === tool!.id
    )
    if (request) {
      this.requests.delete(request.id)
      events.push(nativeEvent(
        request.kind === 'input'
          ? { kind: 'input.resolved', payload: { requestId: request.id } }
          : {
              kind: 'approval.resolved',
              payload: {
                requestId: request.id,
                decision: fact.type === 'tool-completed' ? 'approved' : 'cancelled'
              }
            },
        `${stable}:${request.id}:resolved`,
        fact.nativeType
      ))
    }
    events.push(nativeEvent(
      fact.type === 'tool-completed'
        ? {
            kind: 'tool.completed',
            payload: { callId: tool.id, durationMs: fact.durationMs }
          }
        : {
            kind: 'tool.failed',
            payload: {
              callId: tool.id,
              durationMs: fact.durationMs,
              message: 'Tool failed'
            }
          },
      stable,
      fact.nativeType
    ))
    return events
  }

  private handleNotification(
    fact: Extract<ClaudeNativeFact, { type: 'notification' }>,
    now: number
  ): AdapterEvent[] {
    const type = fact.notificationType
    if (type.includes('permission')) {
      if ([...this.requests.values()].some((request) => request.kind === 'approval')) return []
      if (!this.markShort('notification:permission', now)) return []
      const requestId = `approval:notification:${++this.requestCounter}`
      this.requests.set(requestId, {
        id: requestId,
        kind: 'approval',
        expiresAt: now + REQUEST_TTL_MS
      })
      return [nativeEvent(
        { kind: 'approval.requested', payload: { requestId, category: 'other' } },
        `${fact.nativeSessionId}:${requestId}`,
        fact.nativeType
      )]
    }
    if (type.includes('needs_input') || type.includes('elicitation')) {
      if ([...this.requests.values()].some((request) => request.kind === 'input')) return []
      if (!this.markShort('notification:input', now)) return []
      const requestId = `input:notification:${++this.requestCounter}`
      this.requests.set(requestId, {
        id: requestId,
        kind: 'input',
        expiresAt: now + REQUEST_TTL_MS
      })
      return [nativeEvent(
        { kind: 'input.requested', payload: { requestId } },
        `${fact.nativeSessionId}:${requestId}`,
        fact.nativeType
      )]
    }
    if ((type.includes('idle') || type.includes('completed')) && this.turnId) {
      if (!this.markShort(`notification:${type}:${this.turnId}`, now)) return []
      const turnId = this.turnId
      const events = [
        ...this.completeThinking(fact.nativeType),
        ...this.interruptTools(fact.nativeType, 'Tool result unavailable'),
        ...this.cancelRequests('cancelled', fact.nativeType),
        nativeEvent(
          { kind: 'turn.completed', payload: { turnId, outcome: 'completed' } },
          `${turnId}:notification-completed`,
          fact.nativeType
        )
      ]
      this.turnId = undefined
      return events
    }
    return []
  }

  private resetNativeSession(nativeType: string, now: number): AdapterEvent[] {
    const events = [
      ...this.completeThinking(nativeType),
      ...this.interruptTools(nativeType, 'Tool interrupted'),
      ...this.cancelRequests('cancelled', nativeType)
    ]
    if (this.turnId) {
      events.push(nativeEvent(
        {
          kind: 'turn.completed',
          payload: { turnId: this.turnId, outcome: 'cancelled' }
        },
        `${this.turnId}:session-reset`,
        nativeType
      ))
    }
    events.push(nativeEvent(
      {
        kind: 'session.idle',
        payload: { since: now, reason: 'protocol-idle', confidence: 'high' }
      },
      `${this.nativeSessionId ?? 'unknown'}:session-reset:${now}`,
      nativeType
    ))
    this.nativeSessionId = undefined
    this.turnId = undefined
    this.thinking = false
    this.tools.clear()
    this.requests.clear()
    this.seenShort.clear()
    this.seenStable.clear()
    return events
  }

  private completeThinking(nativeType: string): AdapterEvent[] {
    if (!this.thinking || !this.turnId) return []
    this.thinking = false
    return [nativeEvent(
      { kind: 'thinking.completed', payload: { turnId: this.turnId } },
      `${this.turnId}:thinking:completed:${this.thinkingEpoch}`,
      nativeType
    )]
  }

  private interruptTools(nativeType: string, message: string): AdapterEvent[] {
    const events: AdapterEvent[] = []
    for (const tool of this.tools.values()) {
      if (tool.terminal) continue
      tool.terminal = true
      events.push(nativeEvent(
        { kind: 'tool.failed', payload: { callId: tool.id, message } },
        `${tool.id}:interrupted`,
        nativeType
      ))
    }
    return events
  }

  private cancelRequests(
    decision: 'cancelled',
    nativeType: string
  ): AdapterEvent[] {
    const events: AdapterEvent[] = []
    for (const request of this.requests.values()) {
      events.push(nativeEvent(
        request.kind === 'approval'
          ? { kind: 'approval.resolved', payload: { requestId: request.id, decision } }
          : { kind: 'input.resolved', payload: { requestId: request.id } },
        `${request.id}:cancelled`,
        nativeType
      ))
    }
    this.requests.clear()
    return events
  }

  private markStable(key: string): boolean {
    if (this.seenStable.has(key)) return false
    this.seenStable.set(key, true)
    while (this.seenStable.size > MAX_SEEN_DELIVERIES) {
      const oldest = this.seenStable.keys().next().value
      if (oldest === undefined) break
      this.seenStable.delete(oldest)
    }
    return true
  }

  private markShort(key: string, now: number): boolean {
    for (const [seen, at] of this.seenShort) {
      if (now - at > SHORT_DEDUPE_MS) this.seenShort.delete(seen)
    }
    const at = this.seenShort.get(key)
    if (at !== undefined && now - at <= SHORT_DEDUPE_MS) return false
    this.seenShort.set(key, now)
    return true
  }
}

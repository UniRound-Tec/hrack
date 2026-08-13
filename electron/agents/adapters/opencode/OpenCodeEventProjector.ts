import type { AdapterEvent } from '../types'
import type {
  OpenCodeNativeFact,
  OpenCodeSessionInfo,
  OpenCodeSessionStatus,
  OpenCodeSnapshot
} from './types'

const MAX_SEEN = 8_192

interface NativeSessionState {
  info: OpenCodeSessionInfo
  status: OpenCodeSessionStatus
  fatalError?: string
}

interface NativeToolState {
  publicCallId: string
  turnId: string
  sessionId: string
  name: string
  title?: string
  startedAt?: number
  terminal: boolean
}

function event(
  value: AdapterEvent,
  nativeId: string,
  nativeType: string
): AdapterEvent {
  return { ...value, nativeId, nativeType }
}

function toolCategory(
  name: string
): 'read' | 'edit' | 'shell' | 'search' | 'network' | 'mcp' | 'other' {
  const lower = name.toLowerCase()
  if (['read', 'view'].includes(lower)) return 'read'
  if (['write', 'edit', 'patch', 'multiedit'].includes(lower)) return 'edit'
  if (['bash', 'shell', 'command', 'terminal'].includes(lower)) return 'shell'
  if (['glob', 'grep', 'search', 'websearch'].includes(lower)) return 'search'
  if (['fetch', 'webfetch', 'http'].includes(lower)) return 'network'
  if (lower.startsWith('mcp')) return 'mcp'
  return 'other'
}

function approvalCategory(
  permission: string | undefined
): 'tool' | 'command' | 'file-change' | 'network' | 'other' {
  if (!permission) return 'other'
  const value = permission.toLowerCase()
  if (/bash|shell|command|execute/.test(value)) return 'command'
  if (/edit|write|patch|file/.test(value)) return 'file-change'
  if (/network|fetch|web|http/.test(value)) return 'network'
  return 'tool'
}

function duration(
  startedAt: number | undefined,
  endedAt: number | undefined
): number | undefined {
  if (startedAt === undefined || endedAt === undefined || endedAt < startedAt)
    return undefined
  return Math.min(endedAt - startedAt, 7 * 24 * 60 * 60 * 1_000)
}

/**
 * OpenCode 私有 projector：多个 root/child native Session 折叠为一个
 * pane-level turn。公共 reducer 不需要认识 OpenCode 的 Session 层级。
 */
export class OpenCodeEventProjector {
  private readonly sessions = new Map<string, NativeSessionState>()
  private readonly tools = new Map<string, NativeToolState>()
  private readonly reasoning = new Set<string>()
  private readonly approvals = new Map<
    string,
    { sessionId: string; turnId: string; callId?: string }
  >()
  private readonly inputs = new Map<
    string,
    { sessionId: string; turnId: string }
  >()
  private readonly seen = new Map<string, true>()
  private paneTurnId: string | undefined
  private paneTurnCounter = 0
  private thinkingActive = false

  reconcile(snapshot: OpenCodeSnapshot, now = Date.now()): AdapterEvent[] {
    for (const info of snapshot.sessions) {
      const previous = this.sessions.get(info.id)
      this.sessions.set(info.id, {
        info: { ...previous?.info, ...info },
        status: snapshot.statuses.get(info.id) ?? previous?.status ?? 'idle',
        fatalError: previous?.fatalError
      })
    }
    for (const [sessionId, status] of snapshot.statuses) {
      const state = this.ensureSession(sessionId)
      state.status = status
      if (status === 'busy' || status === 'retry') state.fatalError = undefined
    }
    if (this.hasWorkingSession()) {
      return this.beginPaneTurn('reconcile', now)
    }
    return this.maybeSettle('SessionStatusReconcile', now)
  }

  project(fact: OpenCodeNativeFact, now = Date.now()): AdapterEvent[] {
    switch (fact.type) {
      case 'server-connected':
        return []
      case 'session-created':
      case 'session-updated': {
        const current = this.ensureSession(fact.info.id)
        current.info = { ...current.info, ...fact.info }
        return []
      }
      case 'session-deleted':
        return this.removeSession(fact.sessionId, fact.nativeType, now)
      case 'session-status':
        return this.updateStatus(fact, now)
      case 'session-idle':
        return this.idleSession(fact.sessionId, fact.nativeType, now)
      case 'session-error':
        return this.failSession(fact, now)
      case 'message-user': {
        if (!this.mark(`message:user:${fact.messageId}`)) return []
        this.ensureSession(fact.sessionId).status = 'busy'
        return this.beginPaneTurn(fact.nativeType, now)
      }
      case 'message-assistant-completed':
        return this.completeMessage(fact)
      case 'reasoning':
        return this.updateReasoning(fact, now)
      case 'step-started':
        return this.startStep(fact, now)
      case 'text-completed':
        return this.completeText(fact)
      case 'tool':
        return this.updateTool(fact, now)
      case 'step-finished':
        return [
          ...this.closeReasoningForSession(fact.sessionId, fact.nativeType),
          ...this.updateUsage(fact)
        ]
      case 'permission-asked':
        return this.askPermission(fact, now)
      case 'permission-replied':
        return this.resolvePermission(fact)
      case 'question-asked':
        return this.askQuestion(fact, now)
      case 'question-resolved':
        return this.resolveQuestion(fact)
    }
  }

  private ensureSession(sessionId: string): NativeSessionState {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = { info: { id: sessionId }, status: 'idle' }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  private mark(key: string): boolean {
    if (this.seen.has(key)) return false
    this.seen.set(key, true)
    if (this.seen.size > MAX_SEEN) {
      const oldest = this.seen.keys().next().value as string | undefined
      if (oldest) this.seen.delete(oldest)
    }
    return true
  }

  private beginPaneTurn(nativeType: string, _now: number): AdapterEvent[] {
    if (this.paneTurnId) return []
    this.paneTurnId = `opencode:pane:turn:${++this.paneTurnCounter}`
    return [
      event(
        { kind: 'turn.started', payload: { turnId: this.paneTurnId } },
        `${this.paneTurnId}:started`,
        nativeType
      )
    ]
  }

  private updateStatus(
    fact: Extract<OpenCodeNativeFact, { type: 'session-status' }>,
    now: number
  ): AdapterEvent[] {
    const state = this.ensureSession(fact.sessionId)
    state.status = fact.status
    if (fact.status === 'busy' || fact.status === 'retry') {
      state.fatalError = undefined
      return this.beginPaneTurn(fact.nativeType, now)
    }
    if (fact.status === 'idle')
      return this.idleSession(fact.sessionId, fact.nativeType, now)
    if (fact.status === 'error')
      state.fatalError = fact.message ?? 'OpenCode session failed'
    return this.maybeSettle(fact.nativeType, now)
  }

  private idleSession(
    sessionId: string,
    nativeType: string,
    now: number
  ): AdapterEvent[] {
    const state = this.ensureSession(sessionId)
    state.status = 'idle'
    const events = this.closeSessionActivity(sessionId, nativeType)
    events.push(...this.maybeSettle(nativeType, now))
    return events
  }

  private failSession(
    fact: Extract<OpenCodeNativeFact, { type: 'session-error' }>,
    now: number
  ): AdapterEvent[] {
    if (fact.retryable) {
      if (fact.sessionId) this.ensureSession(fact.sessionId).status = 'retry'
      return this.beginPaneTurn(fact.nativeType, now)
    }
    const sessionId = fact.sessionId ?? 'unknown'
    const state = this.ensureSession(sessionId)
    state.status = 'error'
    state.fatalError = fact.cancelled ? undefined : fact.message
    const events = this.closeSessionActivity(sessionId, fact.nativeType)
    events.push(...this.maybeSettle(fact.nativeType, now, fact.cancelled))
    return events
  }

  private completeMessage(
    fact: Extract<OpenCodeNativeFact, { type: 'message-assistant-completed' }>
  ): AdapterEvent[] {
    if (!this.mark(`message:assistant:${fact.messageId}:completed`)) return []
    const events: AdapterEvent[] = []
    const usage = this.usageEvent(
      fact,
      `${fact.sessionId}:${fact.messageId}:usage`,
      fact.nativeType
    )
    if (usage) events.push(usage)
    events.push(
      event(
        {
          kind: 'message.completed',
          payload: {
            turnId: this.paneTurnId,
            role: 'assistant',
            summary: 'Response ready'
          }
        },
        `${fact.sessionId}:${fact.messageId}:message-completed`,
        fact.nativeType
      )
    )
    return events
  }

  private updateReasoning(
    fact: Extract<OpenCodeNativeFact, { type: 'reasoning' }>,
    now: number
  ): AdapterEvent[] {
    const key = `${fact.sessionId}:${fact.partId}`
    if (fact.completed) {
      if (
        !this.reasoning.delete(key) ||
        this.reasoning.size > 0 ||
        !this.thinkingActive
      )
        return []
      this.thinkingActive = false
      return this.paneTurnId
        ? [
            event(
              {
                kind: 'thinking.completed',
                payload: { turnId: this.paneTurnId }
              },
              `${key}:thinking-completed`,
              fact.nativeType
            )
          ]
        : []
    }
    const events = this.beginPaneTurn(fact.nativeType, now)
    if (this.reasoning.has(key)) return events
    this.reasoning.add(key)
    if (!this.thinkingActive && this.paneTurnId) {
      this.thinkingActive = true
      events.push(
        event(
          { kind: 'thinking.started', payload: { turnId: this.paneTurnId } },
          `${key}:thinking-started`,
          fact.nativeType
        )
      )
    }
    return events
  }

  private startStep(
    fact: Extract<OpenCodeNativeFact, { type: 'step-started' }>,
    now: number
  ): AdapterEvent[] {
    const events = this.beginPaneTurn(fact.nativeType, now)
    const key = `${fact.sessionId}:step:${fact.partId}`
    if (this.reasoning.has(key)) return events
    this.reasoning.add(key)
    if (!this.thinkingActive && this.paneTurnId) {
      this.thinkingActive = true
      events.push(
        event(
          { kind: 'thinking.started', payload: { turnId: this.paneTurnId } },
          `${key}:thinking-started`,
          fact.nativeType
        )
      )
    }
    return events
  }

  private completeText(
    fact: Extract<OpenCodeNativeFact, { type: 'text-completed' }>
  ): AdapterEvent[] {
    return this.closeReasoningForSession(fact.sessionId, fact.nativeType)
  }

  private updateTool(
    fact: Extract<OpenCodeNativeFact, { type: 'tool' }>,
    now: number
  ): AdapterEvent[] {
    const key = `${fact.sessionId}:${fact.callId}`
    const publicCallId = `opencode:${key}`
    let tool = this.tools.get(key)
    if (tool?.terminal) return []
    const events = this.beginPaneTurn(fact.nativeType, now)
    const turnId = this.paneTurnId
    if (!turnId) return events
    events.push(
      ...this.closeReasoningForSession(fact.sessionId, fact.nativeType)
    )

    if (!tool && (fact.state === 'pending' || fact.state === 'running')) {
      tool = {
        publicCallId,
        turnId,
        sessionId: fact.sessionId,
        name: fact.name,
        title: fact.title,
        startedAt: fact.startedAt ?? now,
        terminal: false
      }
      this.tools.set(key, tool)
      events.push(
        event(
          {
            kind: 'tool.started',
            payload: {
              callId: publicCallId,
              turnId,
              name: fact.name,
              category: toolCategory(fact.name)
            }
          },
          `${key}:started`,
          fact.nativeType
        )
      )
    }

    if (!tool && (fact.state === 'completed' || fact.state === 'error')) {
      tool = {
        publicCallId,
        turnId,
        sessionId: fact.sessionId,
        name: fact.name,
        title: fact.title,
        startedAt: fact.startedAt ?? now,
        terminal: false
      }
      this.tools.set(key, tool)
      events.push(
        event(
          {
            kind: 'tool.started',
            payload: {
              callId: publicCallId,
              turnId,
              name: fact.name,
              category: toolCategory(fact.name)
            }
          },
          `${key}:synthetic-start`,
          fact.nativeType
        )
      )
    }
    if (!tool) return events

    if (fact.state === 'running' && fact.title && fact.title !== tool.title) {
      tool.title = fact.title
      events.push(
        event(
          {
            kind: 'tool.progress',
            payload: { callId: publicCallId, turnId: tool.turnId, summary: fact.title }
          },
          `${key}:progress:${fact.title}`,
          fact.nativeType
        )
      )
    }

    if (
      (fact.state === 'completed' || fact.state === 'error') &&
      !tool.terminal
    ) {
      tool.terminal = true
      this.forgetRequestsForCall(fact.sessionId, fact.callId)
      events.push(
        event(
          fact.state === 'completed'
            ? {
                kind: 'tool.completed',
                payload: {
                  callId: publicCallId,
                  turnId: tool.turnId,
                  durationMs: duration(tool.startedAt, fact.endedAt)
                }
              }
            : {
                kind: 'tool.failed',
                payload: {
                  callId: publicCallId,
                  turnId: tool.turnId,
                  durationMs: duration(tool.startedAt, fact.endedAt),
                  message: fact.error ?? 'OpenCode tool failed'
                }
              },
          `${key}:${fact.state}`,
          fact.nativeType
        )
      )
    }
    return events
  }

  private updateUsage(
    fact: Extract<OpenCodeNativeFact, { type: 'step-finished' }>
  ): AdapterEvent[] {
    const usage = this.usageEvent(
      fact,
      `${fact.sessionId}:${fact.partId}:usage`,
      fact.nativeType
    )
    return usage && this.mark(`${fact.sessionId}:${fact.partId}:usage`)
      ? [usage]
      : []
  }

  private usageEvent(
    fact: {
      inputTokens?: number
      outputTokens?: number
      cachedInputTokens?: number
      costUsd?: number
    },
    nativeId: string,
    nativeType: string
  ): AdapterEvent | null {
    if (
      fact.inputTokens === undefined &&
      fact.outputTokens === undefined &&
      fact.cachedInputTokens === undefined &&
      fact.costUsd === undefined
    )
      return null
    return event(
      {
        kind: 'usage.updated',
        payload: {
          inputTokens: fact.inputTokens,
          outputTokens: fact.outputTokens,
          cachedInputTokens: fact.cachedInputTokens,
          costUsd: fact.costUsd,
          scope: 'turn'
        }
      },
      nativeId,
      nativeType
    )
  }

  private askPermission(
    fact: Extract<OpenCodeNativeFact, { type: 'permission-asked' }>,
    now: number
  ): AdapterEvent[] {
    const requestId = `opencode:${fact.sessionId}:approval:${fact.requestId}`
    if (this.seen.has(`request:${requestId}:closed`)) return []
    if (this.approvals.has(requestId)) return []
    const events = this.beginPaneTurn(fact.nativeType, now)
    const turnId = this.paneTurnId
    if (!turnId) return events
    const callId = fact.callId
      ? `opencode:${fact.sessionId}:${fact.callId}`
      : undefined
    this.approvals.set(requestId, {
      sessionId: fact.sessionId,
      turnId,
      callId: fact.callId
    })
    events.push(
      event(
        {
          kind: 'approval.requested',
          payload: {
            requestId,
            turnId,
            callId,
            category: approvalCategory(fact.permission),
            summary: fact.title ?? fact.permission
          }
        },
        `${requestId}:asked`,
        fact.nativeType
      )
    )
    return events
  }

  private resolvePermission(
    fact: Extract<OpenCodeNativeFact, { type: 'permission-replied' }>
  ): AdapterEvent[] {
    const requestId = `opencode:${fact.sessionId}:approval:${fact.requestId}`
    if (!this.approvals.delete(requestId) || !this.mark(`${requestId}:replied`))
      return []
    const value = fact.response.toLowerCase()
    const decision = /once|always|allow|approve|yes/.test(value)
      ? 'approved'
      : /reject|deny|no/.test(value)
        ? 'denied'
        : 'cancelled'
    return [
      event(
        { kind: 'approval.resolved', payload: { requestId, decision } },
        `${requestId}:resolved:${decision}`,
        fact.nativeType
      )
    ]
  }

  private askQuestion(
    fact: Extract<OpenCodeNativeFact, { type: 'question-asked' }>,
    now: number
  ): AdapterEvent[] {
    const requestId = `opencode:${fact.sessionId}:input:${fact.requestId}`
    if (this.seen.has(`request:${requestId}:closed`)) return []
    if (this.inputs.has(requestId)) return []
    const events = this.beginPaneTurn(fact.nativeType, now)
    const turnId = this.paneTurnId
    if (!turnId) return events
    this.inputs.set(requestId, { sessionId: fact.sessionId, turnId })
    events.push(
      event(
        {
          kind: 'input.requested',
          payload: { requestId, turnId, prompt: fact.prompt }
        },
        `${requestId}:asked`,
        fact.nativeType
      )
    )
    return events
  }

  private resolveQuestion(
    fact: Extract<OpenCodeNativeFact, { type: 'question-resolved' }>
  ): AdapterEvent[] {
    const requestId = `opencode:${fact.sessionId}:input:${fact.requestId}`
    if (!this.inputs.delete(requestId) || !this.mark(`${requestId}:resolved`))
      return []
    return [
      event(
        { kind: 'input.resolved', payload: { requestId } },
        `${requestId}:resolved`,
        fact.nativeType
      )
    ]
  }

  private forgetRequestsForCall(sessionId: string, callId: string): void {
    for (const [requestId, request] of [...this.approvals]) {
      if (request.sessionId !== sessionId || request.callId !== callId) continue
      this.approvals.delete(requestId)
    }
  }

  private closeReasoningForSession(
    sessionId: string,
    nativeType: string
  ): AdapterEvent[] {
    let changed = false
    for (const key of [...this.reasoning]) {
      if (!key.startsWith(`${sessionId}:`)) continue
      this.reasoning.delete(key)
      changed = true
    }
    if (
      !changed ||
      this.reasoning.size > 0 ||
      !this.thinkingActive ||
      !this.paneTurnId
    )
      return []
    this.thinkingActive = false
    return [
      event(
        { kind: 'thinking.completed', payload: { turnId: this.paneTurnId } },
        `${this.paneTurnId}:thinking-completed:${sessionId}`,
        nativeType
      )
    ]
  }

  private closeSessionActivity(
    sessionId: string,
    nativeType: string
  ): AdapterEvent[] {
    const events = this.closeReasoningForSession(sessionId, nativeType)
    for (const tool of this.tools.values()) {
      if (tool.sessionId !== sessionId || tool.terminal) continue
      tool.terminal = true
    }
    return events
  }

  private removeSession(
    sessionId: string,
    nativeType: string,
    now: number
  ): AdapterEvent[] {
    const events = this.closeSessionActivity(sessionId, nativeType)
    this.sessions.delete(sessionId)
    for (const [requestId, request] of [...this.approvals]) {
      if (request.sessionId !== sessionId) continue
      this.approvals.delete(requestId)
      events.push(
        event(
          {
            kind: 'approval.resolved',
            payload: { requestId, decision: 'cancelled' }
          },
          `${requestId}:session-deleted`,
          nativeType
        )
      )
    }
    for (const [requestId, request] of [...this.inputs]) {
      if (request.sessionId !== sessionId) continue
      this.inputs.delete(requestId)
      events.push(
        event(
          { kind: 'input.resolved', payload: { requestId } },
          `${requestId}:session-deleted`,
          nativeType
        )
      )
    }
    events.push(...this.maybeSettle(nativeType, now))
    return events
  }

  private hasWorkingSession(): boolean {
    if (
      [...this.sessions.values()].some(
        (session) => session.status === 'busy' || session.status === 'retry'
      )
    ) {
      return true
    }
    if ([...this.tools.values()].some((tool) => !tool.terminal)) return true
    return this.reasoning.size > 0
  }

  private maybeSettle(
    nativeType: string,
    now: number,
    cancelled = false
  ): AdapterEvent[] {
    if (this.hasWorkingSession()) return []
    if (!this.paneTurnId) {
      return [
        event(
          {
            kind: 'session.idle',
            payload: { since: now, reason: 'protocol-idle', confidence: 'high' }
          },
          `opencode:pane:idle:${now}`,
          nativeType
        )
      ]
    }
    const turnId = this.paneTurnId
    this.paneTurnId = undefined
    this.thinkingActive = false
    this.reasoning.clear()
    for (const requestId of this.approvals.keys()) {
      this.mark(`request:${requestId}:closed`)
    }
    for (const requestId of this.inputs.keys()) {
      this.mark(`request:${requestId}:closed`)
    }
    this.approvals.clear()
    this.inputs.clear()
    for (const tool of this.tools.values()) tool.terminal = true
    const failure = [...this.sessions.values()].find(
      (session) => session.fatalError
    )?.fatalError
    for (const state of this.sessions.values()) state.fatalError = undefined
    return [
      event(
        failure
          ? { kind: 'turn.failed', payload: { turnId, message: failure } }
          : {
              kind: 'turn.completed',
              payload: {
                turnId,
                outcome: cancelled ? 'cancelled' : 'completed'
              }
            },
        `${turnId}:${failure ? 'failed' : cancelled ? 'cancelled' : 'completed'}`,
        nativeType
      )
    ]
  }
}

/**
 * 主进程订阅 dsh host 事件，把会话状态写成 AgentSessionProjection。
 * 悬浮窗 / 侧边栏 / Home 注意力列表都只吃这条既有管道。
 */

import type { AgentSessionStatus } from '../../shared/agent-events'
import {
  AGENT_DETAIL_COMPLETED,
  AGENT_DETAIL_ERROR,
  AGENT_DETAIL_RUNNING_TOOL,
  AGENT_DETAIL_THINKING,
  AGENT_DETAIL_WAITING_APPROVAL,
  AGENT_DETAIL_WAITING_INPUT
} from '../agents/AgentEventReducer'
import type { DshProjectionBridge } from './DshProjectionBridge'
import type { DshHostManager } from './DshHostManager'

type TurnOutcome = 'completed' | 'cancelled' | 'failed'
type AttentionKind = 'approval' | 'question'

interface ProjectorSession {
  sessionId: string
  name: string
  running: boolean
  cwd?: string
  agentPreset?: string
  pendingAttention: boolean
  attentionKind?: AttentionKind
  attentionSummary?: string
  /** undefined = 保持上次值；null = 显式清除（如收到新的 session-status）。 */
  error?: string | null
  lastTurnId?: string
  lastTurnOutcome?: TurnOutcome
  turnFailedMessage?: string
  activeTools: Record<string, string>
  lastToolCallId?: string
  latestOutputTokens?: number
  updatedAt: number
}

type SessionPatch = Partial<
  Omit<
    ProjectorSession,
    | 'sessionId'
    | 'activeTools'
    | 'lastTurnId'
    | 'lastTurnOutcome'
    | 'turnFailedMessage'
    | 'lastToolCallId'
    | 'latestOutputTokens'
    | 'attentionKind'
    | 'attentionSummary'
    | 'error'
  >
> & {
  sessionId: string
  activeTools?: Record<string, string>
  lastTurnId?: string | null
  lastTurnOutcome?: TurnOutcome | null
  turnFailedMessage?: string | null
  lastToolCallId?: string | null
  latestOutputTokens?: number | null
  attentionKind?: AttentionKind | null
  attentionSummary?: string | null
  error?: string | null
}

const MAX_LABEL = 80

function keepOrClear<T>(
  next: T | null | undefined,
  previous: T | undefined
): T | undefined {
  if (next === null) return undefined
  if (next !== undefined) return next
  return previous
}

function boundedLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/[\r\n\t]+/g, ' ').trim()
  return clean ? clean.slice(0, MAX_LABEL) : undefined
}

function detailWithValue(marker: string, value?: string | number): string {
  return value === undefined || value === '' ? marker : `${marker}:${value}`
}

function turnIdOf(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return boundedLabel(value)
}

function toolResultCallId(data: Record<string, unknown>): string | undefined {
  const message = data.message
  if (!message || typeof message !== 'object') return undefined
  const source = (message as { source?: { callId?: unknown } }).source
  const fromSource = boundedLabel(source?.callId)
  if (fromSource) return fromSource
  const block = (message as { content?: Array<{ toolCallId?: unknown }> }).content?.[0]
  return boundedLabel(block?.toolCallId)
}

function toolDisplayName(
  view: unknown,
  fallbackName: unknown
): string | undefined {
  if (view && typeof view === 'object') {
    const titled = view as {
      for?: unknown
      view?: { title?: unknown }
    }
    if (titled.for === 'call') {
      const title = boundedLabel(titled.view?.title)
      if (title) return title
    }
  }
  return boundedLabel(fallbackName)
}

function turnOutcomeOf(reason: unknown): {
  outcome: TurnOutcome
  message?: string
} {
  const kind =
    reason && typeof reason === 'object'
      ? (reason as { kind?: unknown }).kind
      : undefined
  if (kind === 'error') {
    const error = (reason as { error?: { message?: unknown } }).error
    return {
      outcome: 'failed',
      message: boundedLabel(error?.message)
    }
  }
  if (
    kind === 'aborted' ||
    kind === 'interrupted' ||
    kind === 'blocked'
  ) {
    return { outcome: 'cancelled' }
  }
  return { outcome: 'completed' }
}

function firstQuestion(questions: unknown): string | undefined {
  if (!Array.isArray(questions) || questions.length === 0) return undefined
  const first = questions[0]
  if (!first || typeof first !== 'object') return undefined
  return boundedLabel((first as { question?: unknown }).question)
}

const BOOTSTRAP_RETRY_INITIAL_MS = 100
const BOOTSTRAP_RETRY_MAX_MS = 2_000

function titleOf(session: ProjectorSession): string {
  if (session.cwd) {
    const base = session.cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
    if (base) return base
  }
  return session.agentPreset || session.sessionId
}

function statusOf(session: ProjectorSession): {
  status: AgentSessionStatus
  detail?: string
} {
  if (session.error) {
    return {
      status: 'error',
      detail: detailWithValue(AGENT_DETAIL_ERROR, session.error)
    }
  }
  if (session.pendingAttention) {
    const marker =
      session.attentionKind === 'question'
        ? AGENT_DETAIL_WAITING_INPUT
        : AGENT_DETAIL_WAITING_APPROVAL
    return {
      status: 'needs-you',
      detail: detailWithValue(marker, session.attentionSummary)
    }
  }
  const activeToolName = session.lastToolCallId
    ? session.activeTools[session.lastToolCallId]
    : Object.values(session.activeTools).at(-1)
  if (activeToolName) {
    return {
      status: 'working',
      detail: detailWithValue(AGENT_DETAIL_RUNNING_TOOL, activeToolName)
    }
  }
  if (session.running) {
    return { status: 'working', detail: AGENT_DETAIL_THINKING }
  }
  if (session.lastTurnOutcome === 'failed') {
    return {
      status: 'error',
      detail: detailWithValue(AGENT_DETAIL_ERROR, session.turnFailedMessage)
    }
  }
  if (
    session.lastTurnOutcome === 'completed' ||
    session.lastTurnOutcome === 'cancelled'
  ) {
    return {
      status: 'done',
      detail: detailWithValue(
        AGENT_DETAIL_COMPLETED,
        session.latestOutputTokens
      )
    }
  }
  return { status: 'idle' }
}

export class DshSessionProjector {
  private hostSocket: WebSocket | null = null
  private muxSocket: WebSocket | null = null
  private sessions = new Map<string, ProjectorSession>()
  private seq = 0
  private running = false
  /** Stable Home-created entries mapped to the official DSH session they monitor. */
  private slots = new Map<string, string | undefined>()
  /** Closed slot ids cannot be revived by a late renderer show/event. */
  private closedSlotIds = new Set<string>()
  /** Only official-page selections in this slot may replace its binding. */
  private activeSlotId: string | undefined
  private bootstrapRetryTimer: ReturnType<typeof setTimeout> | null = null
  private bootstrapFailures = 0
  private lifecycleGeneration = 0

  constructor(
    private readonly host: DshHostManager,
    private readonly bridge: DshProjectionBridge
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.bootstrapFailures = 0
    const generation = ++this.lifecycleGeneration
    void this.bootstrap(generation)
  }

  stop(): void {
    this.disconnect()
    this.bridge.clear()
    this.sessions.clear()
    this.slots.clear()
    this.closedSlotIds.clear()
    this.activeSlotId = undefined
  }

  /** Close host streams without unfollowing HRack slots. Used for host restart. */
  pause(): void {
    this.disconnect()
  }

  private disconnect(): void {
    this.running = false
    ++this.lifecycleGeneration
    if (this.bootstrapRetryTimer) {
      clearTimeout(this.bootstrapRetryTimer)
      this.bootstrapRetryTimer = null
    }
    this.hostSocket?.close()
    this.muxSocket?.close()
    this.hostSocket = null
    this.muxSocket = null
  }

  /** Activate one Home-created slot without importing any official history. */
  activateSlot(slotId: string, adapterSessionId?: string): void {
    if (this.closedSlotIds.has(slotId)) return
    this.activeSlotId = slotId
    if (!this.slots.has(slotId) || adapterSessionId !== undefined) {
      this.slots.set(slotId, adapterSessionId)
    }
    this.publishSlot(slotId)
  }

  /** Replace only the active slot's official-session binding. */
  setActiveSession(sessionId: string | undefined): void {
    const slotId = this.activeSlotId
    if (!slotId) return
    const previousSessionId = this.slots.get(slotId)
    this.slots.set(slotId, sessionId)
    if (!sessionId) {
      if (previousSessionId) this.bridge.remove(slotId)
      return
    }
    this.publishSlot(slotId)
  }

  /** Remove one HRack slot without touching the official DSH session. */
  unfollow(slotId: string): void {
    this.slots.delete(slotId)
    this.closedSlotIds.add(slotId)
    if (this.activeSlotId === slotId) this.activeSlotId = undefined
    this.bridge.remove(slotId)
  }

  private requireBaseUrl(): string {
    const status = this.host.getStatus()
    if (status.state !== 'ready' || !status.baseUrl) {
      throw new Error('dsh host is not ready')
    }
    return status.baseUrl
  }

  private async rpc<T>(method: string, payload: unknown = {}): Promise<T> {
    const rpcId = crypto.randomUUID()
    const response = await fetch(`${this.requireBaseUrl()}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method,
        payload
      })
    })
    if (!response.ok) {
      throw new Error(`${method} HTTP ${response.status}`)
    }
    const envelope = (await response.json()) as {
      result?: { ok?: boolean; value?: T; error?: { message?: string } }
    }
    if (!envelope.result?.ok) {
      throw new Error(envelope.result?.error?.message ?? `${method} failed`)
    }
    return envelope.result.value as T
  }

  private async bootstrap(generation: number): Promise<void> {
    try {
      const listed = await this.rpc<{
        items?: Array<{
          sessionId?: string
          cwd?: string
          agentPreset?: string
          running?: boolean
          origin?: string
          updatedAt?: number
          projections?: { values?: { title?: unknown } }
        }>
      }>('session.list')
      const workspaces = await this.rpc<{
        archivedSessionIds?: string[]
      }>('workspace.list')
      const archived = new Set(workspaces.archivedSessionIds ?? [])
      if (!this.running || generation !== this.lifecycleGeneration) return
      this.sessions.clear()
      for (const item of listed.items ?? []) {
        if (
          typeof item.sessionId !== 'string' ||
          archived.has(item.sessionId) ||
          item.origin === 'subagent'
        ) {
          continue
        }
        const title = item.projections?.values?.title
        this.sessions.set(item.sessionId, {
          sessionId: item.sessionId,
          name: typeof title === 'string' && title.trim() ? title.trim() : titleOf({
            sessionId: item.sessionId,
            name: '',
            running: item.running === true,
            cwd: item.cwd,
            agentPreset: item.agentPreset,
            pendingAttention: false,
            activeTools: {},
            updatedAt: item.updatedAt ?? Date.now()
          }),
          running: item.running === true,
          cwd: item.cwd,
          agentPreset: item.agentPreset,
          pendingAttention: false,
          activeTools: {},
          updatedAt: item.updatedAt ?? Date.now()
        })
      }
      this.bootstrapFailures = 0
      this.publishSlots()
      this.openStreams()
    } catch (error) {
      if (!this.running || generation !== this.lifecycleGeneration) return
      this.bootstrapFailures++
      const retryDelay = Math.min(
        BOOTSTRAP_RETRY_INITIAL_MS * 2 ** (this.bootstrapFailures - 1),
        BOOTSTRAP_RETRY_MAX_MS
      )
      console.warn(
        `[dsh-projector] bootstrap failed; retrying in ${retryDelay}ms`,
        error
      )
      this.bootstrapRetryTimer = setTimeout(() => {
        this.bootstrapRetryTimer = null
        if (this.running && generation === this.lifecycleGeneration) {
          void this.bootstrap(generation)
        }
      }, retryDelay)
    }
  }

  private openStreams(): void {
    if (!this.running) return
    const base = this.requireBaseUrl().replace(/^http/, 'ws')
    this.hostSocket = this.openSocket(`${base}/api/events.host`, (payload) => {
      this.onHostFrame(payload)
    })
    this.muxSocket = this.openSocket(`${base}/api/events.mux`, (payload) => {
      this.onMuxFrame(payload)
    })
  }

  private openSocket(
    url: string,
    onPayload: (payload: Record<string, unknown>) => void
  ): WebSocket {
    const socket = new WebSocket(url)
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      try {
        const envelope = JSON.parse(event.data) as {
          payload?: Record<string, unknown>
        }
        if (envelope.payload) onPayload(envelope.payload)
      } catch {
        /* drop malformed */
      }
    }
    socket.onclose = () => {
      if (!this.running) return
      setTimeout(() => {
        if (this.running) this.openStreams()
      }, 1_000)
    }
    return socket
  }

  private upsert(partial: SessionPatch): void {
    const previous = this.sessions.get(partial.sessionId)
    const next: ProjectorSession = {
      sessionId: partial.sessionId,
      name: partial.name ?? previous?.name ?? partial.sessionId,
      running: partial.running ?? previous?.running ?? false,
      cwd: partial.cwd ?? previous?.cwd,
      agentPreset: partial.agentPreset ?? previous?.agentPreset,
      pendingAttention: partial.pendingAttention ?? previous?.pendingAttention ?? false,
      attentionKind: keepOrClear(partial.attentionKind, previous?.attentionKind),
      attentionSummary: keepOrClear(
        partial.attentionSummary,
        previous?.attentionSummary
      ),
      // error 与其余字段不同：mux 侧的 upsert（title / approval）不带 error，
      // 不能因此把 host/agent-error 已记录的错误抹掉；只有显式传 null 才清除。
      error: keepOrClear(partial.error, previous?.error),
      lastTurnId: keepOrClear(partial.lastTurnId, previous?.lastTurnId),
      lastTurnOutcome: keepOrClear(
        partial.lastTurnOutcome,
        previous?.lastTurnOutcome
      ),
      turnFailedMessage: keepOrClear(
        partial.turnFailedMessage,
        previous?.turnFailedMessage
      ),
      activeTools: partial.activeTools ?? previous?.activeTools ?? {},
      lastToolCallId: keepOrClear(
        partial.lastToolCallId,
        previous?.lastToolCallId
      ),
      latestOutputTokens: keepOrClear(
        partial.latestOutputTokens,
        previous?.latestOutputTokens
      ),
      updatedAt: partial.updatedAt ?? Date.now()
    }
    this.sessions.set(next.sessionId, next)
    for (const [slotId, adapterSessionId] of this.slots) {
      if (adapterSessionId === next.sessionId) this.publish(slotId, next)
    }
  }

  private onHostFrame(payload: Record<string, unknown>): void {
    const type = payload.type
    const sessionId = payload.sessionId
    if (type === 'host/session-added' && typeof sessionId === 'string') {
      if (payload.origin === 'subagent') return
      this.upsert({
        sessionId,
        running: false,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
        agentPreset:
          typeof payload.agentPreset === 'string' ? payload.agentPreset : undefined
      })
      return
    }
    if (type === 'host/session-removed' && typeof sessionId === 'string') {
      this.sessions.delete(sessionId)
      for (const [slotId, adapterSessionId] of this.slots) {
        if (adapterSessionId !== sessionId) continue
        this.slots.set(slotId, undefined)
        this.bridge.remove(slotId)
      }
      return
    }
    if (type === 'host/session-status' && typeof sessionId === 'string') {
      if (payload.running === true) {
        this.upsert({
          sessionId,
          running: true,
          // 新的运行状态本身就是错误已消退的证据（如恢复运行）。
          error: null,
          lastTurnOutcome: null,
          turnFailedMessage: null
        })
        return
      }
      const previous = this.sessions.get(sessionId)
      const watchedWork =
        previous?.running === true ||
        Object.keys(previous?.activeTools ?? {}).length > 0
      this.upsert({
        sessionId,
        running: false,
        lastTurnOutcome:
          previous?.lastTurnOutcome ?? (watchedWork ? 'completed' : undefined),
        activeTools: {},
        lastToolCallId: null
      })
      return
    }
    if (type === 'host/agent-error' && typeof sessionId === 'string') {
      this.upsert({
        sessionId,
        error: typeof payload.message === 'string' ? payload.message : 'agent error'
      })
    }
  }

  private onMuxFrame(payload: Record<string, unknown>): void {
    const type = payload.type
    const sessionId = payload.sessionId
    if (typeof sessionId !== 'string') return
    if (type === 'approval/requested' || type === 'question/requested') {
      this.upsert({
        sessionId,
        pendingAttention: true,
        attentionKind: type === 'question/requested' ? 'question' : 'approval',
        attentionSummary:
          type === 'question/requested'
            ? firstQuestion(payload.questions)
            : boundedLabel(payload.reason) ?? boundedLabel(payload.toolName)
      })
      return
    }
    if (type === 'approval/resolved' || type === 'question/resolved') {
      this.upsert({
        sessionId,
        pendingAttention: false,
        attentionKind: null,
        attentionSummary: null
      })
      return
    }
    if (type === 'session/event') {
      this.onSessionEvent(sessionId, payload.event, payload.view)
      return
    }
    if (type === 'session/projection' && payload.key === 'title') {
      const title = payload.value
      if (typeof title === 'string' && title.trim()) {
        this.upsert({ sessionId, name: title.trim() })
      }
    }
  }

  private onSessionEvent(
    sessionId: string,
    rawEvent: unknown,
    view: unknown
  ): void {
    if (!rawEvent || typeof rawEvent !== 'object') return
    const event = rawEvent as { type?: unknown; data?: unknown }
    const type = event.type
    const data =
      event.data && typeof event.data === 'object'
        ? (event.data as Record<string, unknown>)
        : {}

    if (type === 'turn/start') {
      this.upsert({
        sessionId,
        running: true,
        error: null,
        lastTurnId: turnIdOf(data.turn) ?? null,
        lastTurnOutcome: null,
        turnFailedMessage: null,
        activeTools: {},
        lastToolCallId: null,
        latestOutputTokens: null
      })
      return
    }
    if (type === 'turn/end') {
      const ended = turnOutcomeOf(data.reason)
      this.upsert({
        sessionId,
        running: false,
        lastTurnId: turnIdOf(data.turn),
        lastTurnOutcome: ended.outcome,
        turnFailedMessage: ended.message ?? null,
        activeTools: {},
        lastToolCallId: null
      })
      return
    }
    if (type === 'tool/call') {
      const callId = boundedLabel(data.callId)
      const name = toolDisplayName(view, data.name)
      if (!callId || !name) return
      const previous = this.sessions.get(sessionId)
      this.upsert({
        sessionId,
        running: true,
        lastTurnOutcome: null,
        turnFailedMessage: null,
        activeTools: { ...(previous?.activeTools ?? {}), [callId]: name },
        lastToolCallId: callId
      })
      return
    }
    if (type === 'tool/result') {
      const callId = toolResultCallId(data)
      if (!callId) return
      const previous = this.sessions.get(sessionId)
      const activeTools = { ...(previous?.activeTools ?? {}) }
      delete activeTools[callId]
      const remaining = Object.keys(activeTools)
      this.upsert({
        sessionId,
        activeTools,
        lastToolCallId:
          previous?.lastToolCallId === callId
            ? remaining.at(-1) ?? null
            : previous?.lastToolCallId
      })
      return
    }
    if (type === 'assistant/message') {
      const usage = data.usage
      const outputTokens =
        usage && typeof usage === 'object'
          ? (usage as { outputTokens?: unknown }).outputTokens
          : undefined
      if (typeof outputTokens === 'number' && Number.isFinite(outputTokens)) {
        this.upsert({ sessionId, latestOutputTokens: outputTokens })
      }
    }
  }

  private publish(slotId: string, session: ProjectorSession): void {
    const mapped = statusOf(session)
    this.bridge.apply({
      slotId,
      adapterSessionId: session.sessionId,
      name: session.name || titleOf(session),
      status: mapped.status,
      detail: mapped.detail,
      activeToolCount: Object.keys(session.activeTools).length,
      lastActivityAt: session.updatedAt,
      lastSeq: ++this.seq
    })
  }

  private publishSlot(slotId: string): void {
    const adapterSessionId = this.slots.get(slotId)
    if (!adapterSessionId) return
    const session = this.sessions.get(adapterSessionId)
    if (session) this.publish(slotId, session)
  }

  private publishSlots(): void {
    for (const slotId of this.slots.keys()) {
      this.publishSlot(slotId)
    }
  }
}

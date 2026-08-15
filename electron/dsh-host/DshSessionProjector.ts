/**
 * 主进程订阅 dsh host 事件，把会话状态写成 AgentSessionProjection。
 * 悬浮窗 / 侧边栏 / Home 注意力列表都只吃这条既有管道。
 */

import type { AgentSessionStatus } from '../../shared/agent-events'
import type { DshProjectionBridge } from './DshProjectionBridge'
import type { DshHostManager } from './DshHostManager'

interface ProjectorSession {
  sessionId: string
  name: string
  running: boolean
  cwd?: string
  agentPreset?: string
  pendingAttention: boolean
  /** undefined = 保持上次值；null = 显式清除（如收到新的 session-status）。 */
  error?: string | null
  updatedAt: number
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
  if (session.error) return { status: 'error', detail: session.error }
  if (session.pendingAttention) return { status: 'needs-you' }
  if (session.running) return { status: 'working' }
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
    this.bridge.clear()
    this.sessions.clear()
    this.slots.clear()
    this.closedSlotIds.clear()
    this.activeSlotId = undefined
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
            updatedAt: item.updatedAt ?? Date.now()
          }),
          running: item.running === true,
          cwd: item.cwd,
          agentPreset: item.agentPreset,
          pendingAttention: false,
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

  private upsert(partial: Partial<ProjectorSession> & { sessionId: string }): void {
    const previous = this.sessions.get(partial.sessionId)
    const next: ProjectorSession = {
      sessionId: partial.sessionId,
      name: partial.name ?? previous?.name ?? partial.sessionId,
      running: partial.running ?? previous?.running ?? false,
      cwd: partial.cwd ?? previous?.cwd,
      agentPreset: partial.agentPreset ?? previous?.agentPreset,
      pendingAttention: partial.pendingAttention ?? previous?.pendingAttention ?? false,
      // error 与其余字段不同：mux 侧的 upsert（title / approval）不带 error，
      // 不能因此把 host/agent-error 已记录的错误抹掉；只有显式传 null 才清除。
      error:
        partial.error !== undefined
          ? partial.error
          : previous?.error,
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
      this.upsert({
        sessionId,
        running: payload.running === true,
        // 新的运行状态本身就是错误已消退的证据（如恢复运行）。
        error: payload.running === true ? null : undefined
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
      this.upsert({ sessionId, pendingAttention: true })
      return
    }
    if (type === 'approval/resolved' || type === 'question/resolved') {
      this.upsert({ sessionId, pendingAttention: false })
      return
    }
    if (type === 'session/projection' && payload.key === 'title') {
      const title = payload.value
      if (typeof title === 'string' && title.trim()) {
        this.upsert({ sessionId, name: title.trim() })
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

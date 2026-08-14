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

  constructor(
    private readonly host: DshHostManager,
    private readonly bridge: DshProjectionBridge
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    void this.bootstrap()
  }

  stop(): void {
    this.running = false
    this.hostSocket?.close()
    this.muxSocket?.close()
    this.hostSocket = null
    this.muxSocket = null
    this.bridge.clear()
    this.sessions.clear()
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

  private async bootstrap(): Promise<void> {
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
      this.publishAll()
      this.openStreams()
    } catch (error) {
      console.error('[dsh-projector] bootstrap failed', error)
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
    this.publish(next)
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
      this.bridge.remove(sessionId)
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

  private publish(session: ProjectorSession): void {
    const mapped = statusOf(session)
    this.bridge.apply({
      sessionId: session.sessionId,
      name: session.name || titleOf(session),
      status: mapped.status,
      detail: mapped.detail,
      lastActivityAt: session.updatedAt,
      lastSeq: ++this.seq
    })
  }

  private publishAll(): void {
    for (const session of this.sessions.values()) this.publish(session)
  }
}

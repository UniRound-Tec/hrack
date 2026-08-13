/**
 * 把 dsh host 的 session 状态投影进 vibing 既有 AgentSessionProjection 管道。
 * 悬浮窗 / 侧边栏 / Home 注意力列表都只订阅这条通道，DSH 不能另起一套。
 */

import {
  AgentEventChannel,
  NO_OBSERVER_CAPABILITIES,
  type AgentSessionProjection
} from '../../shared/agent-events'
import { emptyCorrelation } from '../agents/AgentEventReducer'
import { dshTerminalId } from '../../shared/dsh-ipc'

export interface DshProjectionSnapshot {
  sessionId: string
  name: string
  status: AgentSessionProjection['status']
  detail?: string
  lastActivityAt: number
  lastSeq: number
}

interface DshProjectionBridgeOptions {
  broadcast: (channel: string, payload: unknown) => void
}

export class DshProjectionBridge {
  private readonly projections = new Map<string, AgentSessionProjection>()
  private seq = 0

  constructor(private readonly options: DshProjectionBridgeOptions) {}

  listActive(): AgentSessionProjection[] {
    return [...this.projections.values()].filter(
      (projection) => projection.status !== 'exited'
    )
  }

  find(sessionId: string): AgentSessionProjection | undefined {
    return this.projections.get(sessionId)
  }

  apply(snapshot: DshProjectionSnapshot): AgentSessionProjection {
    const previous = this.projections.get(snapshot.sessionId)
    const lastSeq = Math.max(previous?.lastSeq ?? 0, snapshot.lastSeq, ++this.seq)
    const projection: AgentSessionProjection = {
      sessionId: snapshot.sessionId,
      terminalId: dshTerminalId(snapshot.sessionId),
      installationId: 'dsh',
      adapterId: 'dsh',
      name: snapshot.name,
      status: snapshot.status,
      statusConfidence: 'high',
      observerHealth: 'healthy',
      detail: snapshot.detail,
      activeToolCount: snapshot.status === 'working' ? 1 : 0,
      pendingAttentionCount: snapshot.status === 'needs-you' ? 1 : 0,
      lastActivityAt: snapshot.lastActivityAt,
      capabilities: {
        ...NO_OBSERVER_CAPABILITIES,
        approvals: 'structured',
        inputRequests: 'structured',
        thinking: 'phase'
      },
      lastSeq,
      correlation: emptyCorrelation()
    }
    if (projection.status === 'exited') {
      this.projections.delete(snapshot.sessionId)
    } else {
      this.projections.set(snapshot.sessionId, projection)
    }
    this.options.broadcast(AgentEventChannel.Projection, projection)
    return projection
  }

  remove(sessionId: string): void {
    const existing = this.projections.get(sessionId)
    if (!existing) return
    this.apply({
      sessionId,
      name: existing.name ?? sessionId,
      status: 'exited',
      lastActivityAt: Date.now(),
      lastSeq: existing.lastSeq + 1
    })
  }

  clear(): void {
    for (const sessionId of [...this.projections.keys()]) {
      this.remove(sessionId)
    }
  }
}

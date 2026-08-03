/**
 * Agent Event → HistoryEvent / stats 的低敏投影（PLAN-S1 §8.2, P2-3）。
 *
 * 不把全部 Agent Event 原样塞进 `events.jsonl`；只投影低频、低敏事件，
 * 并按稳定关联 id 去重（`sessionId + callId`、`sessionId + requestId` 等）。
 * thinking phase、tool progress、usage 高频更新只用于实时投影，不落盘。
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentEvent
} from '../../shared/agent-events'
import type { HistoryEvent } from '../../shared/ipc-contract'

export interface AgentProjectionMeta {
  sessionId: string
  name: string
  workspace: string
  adapterId: string
}

const MAX_DEDUP_KEYS = 100_000

function exitDetail(exitCode: number | undefined): string {
  return exitCode === undefined ? 'exit' : `exit code ${exitCode}`
}

export class AgentEventProjector {
  private readonly dedupKeys = new Set<string>()

  constructor(private readonly meta: AgentProjectionMeta) {}

  record(event: AgentEvent): HistoryEvent | null {
    const occurredAt = event.occurredAt
    switch (event.kind) {
      case 'session.started':
        return this.once(`start:${this.meta.sessionId}`, {
          kind: 'session_start',
          adapterId: this.meta.adapterId,
          occurredAt,
          title: this.meta.name,
          detail: this.meta.workspace
        })
      case 'tool.started': {
        const callId = event.payload.callId
        return this.once(`tool:${this.meta.sessionId}:${callId}`, {
          kind: 'tool_call',
          adapterId: this.meta.adapterId,
          occurredAt,
          title: event.payload.name,
          detail: ''
        })
      }
      case 'approval.requested': {
        const requestId = event.payload.requestId
        return this.once(`blocked:${this.meta.sessionId}:${requestId}`, {
          kind: 'blocked',
          adapterId: this.meta.adapterId,
          occurredAt,
          title: event.payload.category ?? 'approval',
          detail: event.payload.summary ?? ''
        })
      }
      case 'approval.resolved': {
        if (event.payload.decision !== 'approved') return null
        const requestId = event.payload.requestId
        return this.once(`approved:${this.meta.sessionId}:${requestId}`, {
          kind: 'approved',
          adapterId: this.meta.adapterId,
          occurredAt,
          title: 'approved',
          detail: ''
        })
      }
      case 'turn.completed': {
        const turnId = event.payload.turnId
        return this.once(`completed:${this.meta.sessionId}:${turnId}`, {
          kind: 'completed',
          adapterId: this.meta.adapterId,
          occurredAt,
          title: 'turn completed',
          detail: ''
        })
      }
      case 'session.exited':
        return this.once(`exit:${this.meta.sessionId}`, {
          kind: 'session_exit',
          adapterId: this.meta.adapterId,
          occurredAt,
          title: this.meta.name,
          detail: exitDetail(event.payload.exitCode)
        })
      default:
        // thinking phase / tool progress / usage 高频更新只用于实时投影。
        return null
    }
  }

  private once(key: string, event: Omit<HistoryEvent, 'id'>): HistoryEvent | null {
    if (this.dedupKeys.has(key)) return null
    if (this.dedupKeys.size >= MAX_DEDUP_KEYS) this.dedupKeys.clear()
    this.dedupKeys.add(key)
    return { id: randomUUID(), ...event }
  }
}

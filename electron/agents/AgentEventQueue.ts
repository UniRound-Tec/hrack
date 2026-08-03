/**
 * 每 Session 有界 Agent Event 队列（PLAN-S1 §8.1）。
 *
 * - 按事件数和编码后字节数双上限；超限发一次去重的 overflow 标记，
 *   Runtime 据此产生 `observer.degraded`；
 * - `tool.progress`、`usage.updated` 等可合并事件在入队时覆盖旧值；
 * - approval/input、tool terminal、turn terminal、session exit 永不因
 *   progress 洪峰被静默丢弃；
 * - 按 nativeId 去重（hook 重放 / RPC reconnect replay）；
 * - flush 一次性取出整批，由 Runtime 批量归约、批量广播 IPC。
 *
 * Agent Event 与 PTY 字节使用完全独立的队列；本队列绝不触碰 pty。
 */

import type { AgentEvent } from '../../shared/agent-events'

export interface AgentQueueLimits {
  maxEvents: number
  maxBytes: number
  maxSeenNativeIds: number
}

export const DEFAULT_AGENT_QUEUE_LIMITS: AgentQueueLimits = {
  maxEvents: 2_000,
  maxBytes: 512 * 1024,
  maxSeenNativeIds: 8_192
}

/** 洪峰时允许丢弃/合并的事件（高频、可重建）。 */
const COALESCABLE_KINDS: ReadonlySet<string> = new Set([
  'tool.progress',
  'usage.updated',
  'message.completed',
  'thinking.started',
  'thinking.completed',
  'session.idle'
])

/** 永不因洪峰静默丢弃的终态/注意力事件。 */
const TERMINAL_KINDS: ReadonlySet<string> = new Set([
  'session.started',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'approval.requested',
  'approval.resolved',
  'input.requested',
  'input.resolved',
  'session.exited',
  'observer.degraded'
])

export type AgentPushResult =
  | 'accepted'
  | 'coalesced'
  | 'dropped-duplicate'
  | 'dropped-overflow'
  | 'requires-flush'

function coalesceKey(event: AgentEvent): string | null {
  switch (event.kind) {
    case 'tool.progress':
      return `tool.progress:${event.payload.callId}`
    case 'usage.updated':
      return `usage.updated:${event.payload.scope}`
    case 'message.completed':
      return 'message.completed'
    case 'thinking.started':
      return 'thinking.started'
    case 'thinking.completed':
      return 'thinking.completed'
    case 'session.idle':
      return 'session.idle'
    default:
      return null
  }
}

function estimatedBytes(event: AgentEvent): number {
  // 编码近似：字段数级估计足以做有界保护，不追求精确序列化长度。
  let bytes = 64
  if (event.nativeType) bytes += event.nativeType.length
  const payload = event.payload as Record<string, unknown>
  for (const value of Object.values(payload)) {
    if (typeof value === 'string') bytes += value.length + 4
    else if (typeof value === 'number') bytes += 16
    else if (value && typeof value === 'object') {
      bytes += 8
      for (const item of Object.values(value)) {
        bytes += typeof item === 'string' ? item.length : 16
      }
    }
  }
  return bytes
}

export class AgentEventQueue {
  private items: AgentEvent[] = []
  private bytes = 0
  private readonly coalesceIndex = new Map<string, number>()
  private readonly seenNativeIds = new Set<string>()
  private overflowed = false

  constructor(private readonly limits: AgentQueueLimits = DEFAULT_AGENT_QUEUE_LIMITS) {}

  get length(): number {
    return this.items.length
  }

  get byteLength(): number {
    return this.bytes
  }

  /** 本次会话是否发生过溢出（去重标记；Runtime 消费一次）。 */
  hasOverflowed(): boolean {
    return this.overflowed
  }

  push(event: AgentEvent): AgentPushResult {
    const nativeId = event.nativeId
    if (nativeId) {
      if (this.seenNativeIds.has(nativeId)) return 'dropped-duplicate'
    }

    const key = coalesceKey(event)
    if (key !== null) {
      const existingIndex = this.coalesceIndex.get(key)
      if (existingIndex !== undefined && this.items[existingIndex]) {
        // 新事件必须留在队尾，不能用较大的 seq 替换旧位置后跑到中间事件前面。
        this.removeAt(existingIndex)
        const eventBytes = estimatedBytes(event)
        if (this.bytes + eventBytes > this.limits.maxBytes) {
          this.overflowed = true
          this.rememberNativeId(nativeId)
          return 'dropped-overflow'
        }
        this.append(event, eventBytes)
        this.rememberNativeId(nativeId)
        return 'coalesced'
      }
    }

    const eventBytes = estimatedBytes(event)
    if (this.items.length < this.limits.maxEvents && this.bytes + eventBytes <= this.limits.maxBytes) {
      const result = this.append(event, eventBytes)
      this.rememberNativeId(nativeId)
      return result
    }

    // 超限：优先丢弃新到的可合并事件；终态事件则腾出最旧的可合并事件。
    this.overflowed = true
    if (COALESCABLE_KINDS.has(event.kind)) {
      this.rememberNativeId(nativeId)
      return 'dropped-overflow'
    }

    const evictedIndex = this.findEvictableIndex()
    if (evictedIndex !== -1) {
      this.removeAt(evictedIndex)
      const result = this.append(event, eventBytes)
      this.rememberNativeId(nativeId)
      return result
    }
    // 队列全是不可丢事实。让 Runtime 先同步 flush 后重试，既维持硬上限，
    // 又不把 terminal/attention 事件伪装成 accepted。
    return 'requires-flush'
  }

  private rememberNativeId(nativeId: string | undefined): void {
    if (!nativeId || this.limits.maxSeenNativeIds <= 0) return
    this.seenNativeIds.add(nativeId)
    while (this.seenNativeIds.size > this.limits.maxSeenNativeIds) {
      const oldest = this.seenNativeIds.values().next().value as
        | string
        | undefined
      if (oldest === undefined) break
      this.seenNativeIds.delete(oldest)
    }
  }

  private append(event: AgentEvent, eventBytes: number): 'accepted' {
    const key = coalesceKey(event)
    if (key !== null) this.coalesceIndex.set(key, this.items.length)
    this.items.push(event)
    this.bytes += eventBytes
    return 'accepted'
  }

  private findEvictableIndex(): number {
    for (let index = 0; index < this.items.length; index++) {
      if (!TERMINAL_KINDS.has(this.items[index].kind)) return index
    }
    return -1
  }

  private removeAt(index: number): void {
    const removed = this.items[index]
    this.items.splice(index, 1)
    this.bytes = Math.max(0, this.bytes - estimatedBytes(removed))
    // 重建 coalesce 索引（队列不大，重建成本可接受）。
    this.coalesceIndex.clear()
    for (let cursor = 0; cursor < this.items.length; cursor++) {
      const key = coalesceKey(this.items[cursor])
      if (key !== null) this.coalesceIndex.set(key, cursor)
    }
  }

  /** 取出整批待处理事件；seenNativeIds 保留（跨批次去重）。 */
  flush(): AgentEvent[] {
    if (this.items.length === 0) return []
    const batch = this.items
    this.items = []
    this.bytes = 0
    this.coalesceIndex.clear()
    return batch
  }
}

import { app } from 'electron'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile
} from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AllTimeStats,
  HistoryEvent,
  HistoryQuery
} from '../../shared/ipc-contract'

/**
 * 事件持久化管道（SPEC §11.5 / M5.c §4.4）：
 *
 * - `<userData>/events/events.jsonl`：逐行 append HistoryEvent；启动时加载进内存
 *   索引，超过 5,000 条时压缩重写（保留最新 5,000）。查询按 occurredAt 降序，
 *   支持 `before` 游标分页。
 * - `<userData>/events/stats.json`：单调聚合计数，写入时同步累加——计数独立于
 *   日志截断，all-time 语义不受 5,000 条上限影响。
 *
 * 写入失败只记错误并降级为内存态，不阻断会话流程。损坏的日志行逐行跳过。
 */
export const EVENT_LOG_LIMIT = 5_000

interface StatsCounters {
  sessions: number
  toolCalls: number
  blocked: number
  approvals: number
}

const KIND_STATS_KEY: Record<string, keyof StatsCounters> = {
  session_start: 'sessions',
  tool_call: 'toolCalls',
  blocked: 'blocked',
  approved: 'approvals'
}

export class EventLog {
  private events: HistoryEvent[] = []
  private counters: StatsCounters = {
    sessions: 0,
    toolCalls: 0,
    blocked: 0,
    approvals: 0
  }
  private statsPath = ''
  private logPath = ''
  private loaded = false

  constructor() {
    const root = join(app.getPath('userData'), 'events')
    this.statsPath = join(root, 'stats.json')
    this.logPath = join(root, 'events.jsonl')
  }

  /** 启动时加载：stats 读 JSON，日志逐行解析（坏行跳过），随后按需压缩。 */
  async init(): Promise<void> {
    await mkdir(join(this.logPath, '..'), { recursive: true })
    this.counters = await this.readStats()
    this.events = await this.readLog()
    this.loaded = true
    if (this.events.length > EVENT_LOG_LIMIT) await this.compact()
  }

  private async readStats(): Promise<StatsCounters> {
    try {
      const parsed = JSON.parse(await readFile(this.statsPath, 'utf8')) as
        | Partial<StatsCounters>
        | null
      return {
        sessions: numberOrZero(parsed?.sessions),
        toolCalls: numberOrZero(parsed?.toolCalls),
        blocked: numberOrZero(parsed?.blocked),
        approvals: numberOrZero(parsed?.approvals)
      }
    } catch {
      return { sessions: 0, toolCalls: 0, blocked: 0, approvals: 0 }
    }
  }

  private async readLog(): Promise<HistoryEvent[]> {
    let source: string
    try {
      source = await readFile(this.logPath, 'utf8')
    } catch {
      return []
    }
    const events: HistoryEvent[] = []
    for (const line of source.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as HistoryEvent)
      } catch {
        // 断电截断等造成的坏行：跳过，不阻断加载。
      }
    }
    return events
  }

  async record(event: HistoryEvent): Promise<void> {
    if (!this.loaded) {
      this.events.push(event)
      return
    }
    this.events.push(event)
    const key = KIND_STATS_KEY[event.kind]
    if (key) this.counters[key]++
    try {
      appendFileSync(this.logPath, `${JSON.stringify(event)}\n`, 'utf8')
    } catch (error) {
      console.error('[events] 日志追加失败（降级为内存态）:', error)
    }
    if (this.events.length > EVENT_LOG_LIMIT) {
      await this.compact().catch((error) => {
        console.error('[events] 压缩重写失败:', error)
      })
    }
    await this.persistStats()
  }

  /** 压缩重写：只保留最新 EVENT_LOG_LIMIT 条（已按发生时间排序）。 */
  private async compact(): Promise<void> {
    if (this.events.length <= EVENT_LOG_LIMIT) return
    const retained = this.events.slice(this.events.length - EVENT_LOG_LIMIT)
    const temp = `${this.logPath}.compact`
    await writeFile(
      temp,
      retained.map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf8'
    )
    await rename(temp, this.logPath)
    this.events = retained
  }

  private async persistStats(): Promise<void> {
    try {
      const temp = `${this.statsPath}.tmp`
      await writeFile(temp, JSON.stringify(this.counters, null, 2), 'utf8')
      await rename(temp, this.statsPath)
    } catch (error) {
      console.error('[events] stats 落盘失败:', error)
    }
  }

  /** 按 occurredAt 降序查询；`before` 为排他游标（只取更早的事件）。 */
  query(query: HistoryQuery): HistoryEvent[] {
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit) || 50))
    const before = query.before ?? Number.POSITIVE_INFINITY
    const results: HistoryEvent[] = []
    for (let index = this.events.length - 1; index >= 0; index--) {
      const event = this.events[index]
      if (event.occurredAt >= before) continue
      results.push(event)
      if (results.length >= limit) break
    }
    return results
  }

  allTimeStats(): AllTimeStats {
    return { ...this.counters }
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0
}

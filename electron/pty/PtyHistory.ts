import type {
  PtyHistoryEvent,
  PtyHistorySnapshot
} from '../../shared/ipc-contract'

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_EVENTS = 20_000

export interface PtyHistoryOptions {
  maxOutputBytes?: number
  maxEvents?: number
}

/**
 * 主进程中的 resize 免疫原始历史源。
 *
 * 所有 PTY 输出和 resize 都按顺序追加。ConPTY 后续发出的重绘只是新的 output
 * 事件，无法覆盖已经记录的旧事件。达到容量上限时只从最旧端整段淘汰，并在
 * snapshot 中标记 complete=false，避免调用方误以为拿到了完整会话。
 */
export class PtyHistory {
  private readonly maxOutputBytes: number
  private readonly maxEvents: number
  private readonly events: PtyHistoryEvent[] = []
  private nextSequence = 1
  private retainedOutputBytes = 0
  private droppedOutputBytes = 0
  private droppedEvents = 0

  constructor(options: PtyHistoryOptions = {}) {
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
  }

  appendOutput(data: string): void {
    if (data.length === 0) return
    const byteLength = Buffer.byteLength(data)
    this.events.push({
      sequence: this.nextSequence++,
      kind: 'output',
      data,
      byteLength
    })
    this.retainedOutputBytes += byteLength
    this.trim()
  }

  appendResize(cols: number, rows: number): void {
    this.events.push({
      sequence: this.nextSequence++,
      kind: 'resize',
      cols,
      rows
    })
    this.trim()
  }

  appendCursorSync(row: number, column: number): void {
    this.events.push({
      sequence: this.nextSequence++,
      kind: 'cursor-sync',
      row,
      column
    })
    this.trim()
  }

  snapshot(): PtyHistorySnapshot {
    return {
      complete: this.droppedEvents === 0,
      retainedOutputBytes: this.retainedOutputBytes,
      droppedOutputBytes: this.droppedOutputBytes,
      droppedEvents: this.droppedEvents,
      events: this.events.map((event) => ({ ...event }))
    }
  }

  private trim(): void {
    while (
      this.events.length > 0 &&
      (this.retainedOutputBytes > this.maxOutputBytes ||
        this.events.length > this.maxEvents)
    ) {
      const removed = this.events.shift()
      if (!removed) break
      this.droppedEvents++
      if (removed.kind === 'output') {
        this.retainedOutputBytes -= removed.byteLength
        this.droppedOutputBytes += removed.byteLength
      }
    }
  }
}

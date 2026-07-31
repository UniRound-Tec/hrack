import type { PtyFlowControlSnapshot } from '../../shared/ipc-contract'

export const PTY_DATA_HIGH_WATER_MARK_BYTES = 256 * 1024
export const PTY_DATA_LOW_WATER_MARK_BYTES = 64 * 1024
export const PTY_DATA_MAX_BUFFERED_BYTES = 1024 * 1024

export interface PtyDataQueueOptions {
  highWaterMarkBytes: number
  lowWaterMarkBytes: number
  maxBufferedBytes: number
  send: (data: Uint8Array) => void
  pause: () => void
  resume: () => void
}

/**
 * Bounds the amount of PTY output in flight between the main process and xterm.
 *
 * Bytes are acknowledged only after xterm has parsed them. Once the high-water
 * mark is reached, node-pty is paused. Acknowledgements that reach the low-water
 * mark allow queued data to drain and the PTY to resume.
 */
export class PtyDataQueue {
  private readonly queued: Uint8Array[] = []
  private unackedBytes = 0
  private queuedBytes = 0
  private paused = false
  private maxObservedBufferedBytes = 0
  private overflowed = false
  private rejectedBytes = 0
  private pauseCount = 0
  private resumeCount = 0

  constructor(private readonly options: PtyDataQueueOptions) {
    if (
      options.lowWaterMarkBytes < 0 ||
      options.highWaterMarkBytes <= options.lowWaterMarkBytes ||
      options.maxBufferedBytes < options.highWaterMarkBytes
    ) {
      throw new RangeError('invalid PTY data queue water marks')
    }
  }

  push(data: Uint8Array): boolean {
    if (data.byteLength === 0) return true

    if (
      this.unackedBytes + this.queuedBytes + data.byteLength >
      this.options.maxBufferedBytes
    ) {
      this.overflowed = true
      this.rejectedBytes += data.byteLength
      this.pause()
      return false
    }

    if (this.queued.length === 0 && this.unackedBytes < this.options.highWaterMarkBytes) {
      this.send(data)
    } else {
      this.queued.push(data)
      this.queuedBytes += data.byteLength
    }

    if (this.unackedBytes >= this.options.highWaterMarkBytes || this.queued.length > 0) {
      this.pause()
    }
    this.maxObservedBufferedBytes = Math.max(
      this.maxObservedBufferedBytes,
      this.unackedBytes + this.queuedBytes
    )
    return true
  }

  ack(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return
    this.unackedBytes = Math.max(0, this.unackedBytes - Math.floor(bytes))

    if (this.unackedBytes > this.options.lowWaterMarkBytes) return

    while (
      this.queued.length > 0 &&
      this.unackedBytes < this.options.highWaterMarkBytes
    ) {
      const chunk = this.queued.shift()
      if (!chunk) break
      this.queuedBytes -= chunk.byteLength
      this.send(chunk)
    }

    if (
      this.queued.length === 0 &&
      this.unackedBytes < this.options.highWaterMarkBytes
    ) {
      this.resume()
    }
  }

  snapshot(): PtyFlowControlSnapshot {
    return {
      highWaterMarkBytes: this.options.highWaterMarkBytes,
      lowWaterMarkBytes: this.options.lowWaterMarkBytes,
      maxBufferedBytes: this.options.maxBufferedBytes,
      unackedBytes: this.unackedBytes,
      queuedBytes: this.queuedBytes,
      bufferedBytes: this.unackedBytes + this.queuedBytes,
      maxObservedBufferedBytes: this.maxObservedBufferedBytes,
      paused: this.paused,
      pauseCount: this.pauseCount,
      resumeCount: this.resumeCount,
      overflowed: this.overflowed,
      rejectedBytes: this.rejectedBytes
    }
  }

  private send(data: Uint8Array): void {
    this.unackedBytes += data.byteLength
    this.options.send(data)
  }

  private pause(): void {
    if (this.paused) return
    this.paused = true
    this.pauseCount++
    this.options.pause()
  }

  private resume(): void {
    if (!this.paused) return
    this.paused = false
    this.resumeCount++
    this.options.resume()
  }
}

export interface PtyOutputBatcherOptions {
  quietPeriodMs: number
  maxPeriodMs: number
  write(data: Uint8Array, onParsed: () => void): void
  acknowledge(bytes: number): void
  scheduleFlush?(callback: () => void): () => void
}

// ConPTY normally splits one logical repaint across adjacent IPC deliveries only
// a few milliseconds apart. Keep unframed output atomic without holding a
// continuous stream below 30 FPS. Synchronized TUI frames bypass the quiet
// period once their DECRST 2026 boundary arrives and are committed on the next
// browser paint by useXterm.
export const PTY_OUTPUT_QUIET_PERIOD_MS = 8
export const PTY_OUTPUT_MAX_PERIOD_MS = 16

const SYNCHRONIZED_OUTPUT_PREFIX = new Uint8Array([
  0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36
])

/**
 * Coalesces the small IPC chunks that make up one terminal repaint burst.
 *
 * ConPTY can split a TUI update immediately after it moves the cursor to a
 * temporary status position and deliver the restoring cursor move a few
 * milliseconds later. Feeding both chunks to xterm separately lets a browser
 * animation frame expose that intermediate cursor. A short trailing window
 * keeps the repaint atomic, while the maximum window prevents continuous
 * output from being starved.
 */
export class PtyOutputBatcher {
  private readonly chunks: Uint8Array[] = []
  private bytes = 0
  private quietTimer: ReturnType<typeof setTimeout> | null = null
  private maxTimer: ReturnType<typeof setTimeout> | null = null
  private cancelScheduledFlush: (() => void) | null = null
  private synchronizedOutput = false
  private synchronizedPrefixLength = 0
  private disposed = false

  constructor(private readonly options: PtyOutputBatcherOptions) {
    if (
      options.quietPeriodMs <= 0 ||
      options.maxPeriodMs < options.quietPeriodMs
    ) {
      throw new RangeError('invalid PTY output batching periods')
    }
  }

  push(data: Uint8Array): void {
    if (data.byteLength === 0) return
    if (this.disposed) {
      this.options.acknowledge(data.byteLength)
      return
    }

    this.chunks.push(data)
    this.bytes += data.byteLength
    const boundary = this.scanSynchronizedOutput(data)

    if (this.synchronizedOutput) {
      // A newer Pi/ConPTY frame started before the queued paint. Keep it with
      // the preceding frame so xterm parses both but only exposes the newest
      // complete state. The max timer still releases malformed/missing DECRST.
      this.cancelPaintFlush()
      this.clearQuietTimer()
      this.ensureMaxTimer()
      return
    }

    if (boundary.completed) {
      this.requestPaintFlush()
      return
    }

    if (this.cancelScheduledFlush) return
    this.ensureMaxTimer()
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.quietTimer = setTimeout(
      () => this.requestPaintFlush(),
      this.options.quietPeriodMs
    )
  }

  flush(): void {
    if (this.chunks.length === 0) return
    this.cancelPaintFlush()
    this.clearTimers()

    const byteLength = this.bytes
    const data =
      this.chunks.length === 1
        ? this.chunks[0]
        : this.concatenateChunks(byteLength)
    this.chunks.length = 0
    this.bytes = 0
    this.options.write(data, () => this.options.acknowledge(byteLength))
  }

  dispose(): void {
    if (this.disposed) return
    const discardedBytes = this.bytes
    this.chunks.length = 0
    this.bytes = 0
    this.disposed = true
    this.cancelPaintFlush()
    this.clearTimers()
    if (discardedBytes > 0) this.options.acknowledge(discardedBytes)
  }

  private concatenateChunks(byteLength: number): Uint8Array {
    const output = new Uint8Array(byteLength)
    let offset = 0
    for (const chunk of this.chunks) {
      output.set(chunk, offset)
      offset += chunk.byteLength
    }
    return output
  }

  private clearTimers(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer)
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.quietTimer = null
    this.maxTimer = null
  }

  private clearQuietTimer(): void {
    if (!this.quietTimer) return
    clearTimeout(this.quietTimer)
    this.quietTimer = null
  }

  private ensureMaxTimer(): void {
    if (this.maxTimer) return
    this.maxTimer = setTimeout(
      () => this.requestPaintFlush(),
      this.options.maxPeriodMs
    )
  }

  private requestPaintFlush(): void {
    if (this.chunks.length === 0 || this.cancelScheduledFlush) return
    this.clearTimers()
    const schedule =
      this.options.scheduleFlush ??
      ((callback: () => void) => {
        const timer = setTimeout(callback, 0)
        return () => clearTimeout(timer)
      })
    this.cancelScheduledFlush = schedule(() => {
      this.cancelScheduledFlush = null
      this.flush()
    })
  }

  private cancelPaintFlush(): void {
    this.cancelScheduledFlush?.()
    this.cancelScheduledFlush = null
  }

  private scanSynchronizedOutput(data: Uint8Array): {
    completed: boolean
  } {
    let completed = false
    for (const byte of data) {
      if (this.synchronizedPrefixLength < SYNCHRONIZED_OUTPUT_PREFIX.length) {
        const expected =
          SYNCHRONIZED_OUTPUT_PREFIX[this.synchronizedPrefixLength]
        if (byte === expected) {
          this.synchronizedPrefixLength++
          continue
        }
        this.synchronizedPrefixLength =
          byte === SYNCHRONIZED_OUTPUT_PREFIX[0] ? 1 : 0
        continue
      }

      if (byte === 0x68) {
        this.synchronizedOutput = true
      } else if (byte === 0x6c) {
        this.synchronizedOutput = false
        completed = true
      }
      this.synchronizedPrefixLength =
        byte === SYNCHRONIZED_OUTPUT_PREFIX[0] ? 1 : 0
    }
    return { completed }
  }
}

export interface PtyOutputBatcherOptions {
  quietPeriodMs: number
  maxPeriodMs: number
  write(data: Uint8Array, onParsed: () => void): void
  acknowledge(bytes: number): void
}

export const PTY_OUTPUT_QUIET_PERIOD_MS = 32
export const PTY_OUTPUT_MAX_PERIOD_MS = 64

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

    const startsBatch = this.chunks.length === 0
    this.chunks.push(data)
    this.bytes += data.byteLength

    if (startsBatch) {
      this.maxTimer = setTimeout(() => this.flush(), this.options.maxPeriodMs)
    }
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.quietTimer = setTimeout(
      () => this.flush(),
      this.options.quietPeriodMs
    )
  }

  flush(): void {
    if (this.chunks.length === 0) return
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
}

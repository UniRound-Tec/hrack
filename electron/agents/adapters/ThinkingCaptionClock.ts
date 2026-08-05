import type { AdapterEvent } from './types'

/** Shared phase timer for adapters with an authoritative thinking boundary. */
export class ThinkingCaptionClock {
  private timer: ReturnType<typeof setInterval> | null = null
  private startedAt = 0
  private epoch = 0
  private publishedSecond = -1

  constructor(
    private readonly nativeIdPrefix: string,
    private readonly nativeType: string,
    private readonly emit: (event: AdapterEvent) => void
  ) {}

  start(): void {
    this.stop()
    this.epoch++
    this.startedAt = Date.now()
    this.publish()
    this.timer = setInterval(() => this.publish(), 250)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.startedAt = 0
    this.publishedSecond = -1
  }

  private publish(): void {
    if (this.startedAt <= 0) return
    const seconds = Math.max(
      0,
      Math.floor((Date.now() - this.startedAt) / 1_000)
    )
    if (seconds === this.publishedSecond) return
    this.publishedSecond = seconds
    this.emit({
      kind: 'activity.caption',
      payload: {
        text: `@agent:live-thinking:${seconds}:`,
        confidence: 'low'
      },
      nativeId: `${this.nativeIdPrefix}:${this.epoch}:${seconds}`,
      nativeType: this.nativeType
    })
  }
}

const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024
const DEFAULT_MAX_LINE_BYTES = 256 * 1024

export class OpenCodeSseError extends Error {
  constructor(
    readonly code: 'event-too-large' | 'line-too-large' | 'invalid-json',
    message: string
  ) {
    super(message)
    this.name = 'OpenCodeSseError'
  }
}

/**
 * 有界 SSE framing。它只把 data frame 解析为 unknown JSON，不认识任何
 * OpenCode 业务字段；业务 schema 留给 OpenCodeEventParser。
 */
export class OpenCodeSseParser {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false })
  private pending = ''
  private dataLines: string[] = []
  private eventBytes = 0

  constructor(
    private readonly onValue: (value: unknown) => void,
    private readonly limits: {
      maxEventBytes?: number
      maxLineBytes?: number
    } = {}
  ) {}

  push(chunk: Uint8Array | string): void {
    this.pending +=
      typeof chunk === 'string'
        ? chunk
        : this.decoder.decode(chunk, { stream: true })
    this.consumeLines(false)
  }

  end(): void {
    this.pending += this.decoder.decode()
    this.consumeLines(true)
    if (this.dataLines.length > 0) this.dispatch()
  }

  reset(): void {
    this.pending = ''
    this.dataLines = []
    this.eventBytes = 0
  }

  private consumeLines(flush: boolean): void {
    while (true) {
      const newline = this.pending.indexOf('\n')
      if (newline < 0) break
      let line = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.consumeLine(line)
    }

    const maxLine = this.limits.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    if (Buffer.byteLength(this.pending, 'utf8') > maxLine) {
      throw new OpenCodeSseError(
        'line-too-large',
        'OpenCode SSE line exceeds limit'
      )
    }
    if (flush && this.pending.length > 0) {
      const line = this.pending.endsWith('\r')
        ? this.pending.slice(0, -1)
        : this.pending
      this.pending = ''
      this.consumeLine(line)
    }
  }

  private consumeLine(line: string): void {
    const maxLine = this.limits.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    if (Buffer.byteLength(line, 'utf8') > maxLine) {
      throw new OpenCodeSseError(
        'line-too-large',
        'OpenCode SSE line exceeds limit'
      )
    }
    if (line === '') {
      if (this.dataLines.length > 0) this.dispatch()
      return
    }
    if (line.startsWith(':')) return
    if (!line.startsWith('data:')) return
    const value = line.slice(5).replace(/^ /, '')
    this.eventBytes += Buffer.byteLength(value, 'utf8')
    if (
      this.eventBytes > (this.limits.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES)
    ) {
      throw new OpenCodeSseError(
        'event-too-large',
        'OpenCode SSE event exceeds limit'
      )
    }
    this.dataLines.push(value)
  }

  private dispatch(): void {
    const data = this.dataLines.join('\n')
    this.dataLines = []
    this.eventBytes = 0
    let value: unknown
    try {
      value = JSON.parse(data)
    } catch {
      throw new OpenCodeSseError(
        'invalid-json',
        'OpenCode SSE data is not JSON'
      )
    }
    this.onValue(value)
  }
}

import WebSocket from 'ws'

type Frame = Record<string, unknown>

function record(value: unknown): Frame | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Frame
    : undefined
}

/** DSH 0.1.5 moved host events and session projections to Typert remote.mux. */
export class DshTypertSessionStream {
  private socket: WebSocket | null = null
  private retry: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private follows = new Map<string, string>()
  private wanted = new Set<string>()
  private clientId: string | undefined
  private generationAbort = new AbortController()
  private pendingEvents = new Map<string, AbortController>()
  private nextStreamId = 0

  constructor(private readonly options: {
    baseUrl: string
    cookie?: string
    ready(): void
    host(frame: Frame): void
    mux(frame: Frame): void
    /** Observers must pass interactive waterfalls on to the official UI. */
    passEvent(clientId: string, eventId: string, signal: AbortSignal): Promise<void>
  }) {}

  start(): void {
    if (this.stopped || this.socket) return
    const socket = new WebSocket(
      `${this.options.baseUrl.replace(/^http/, 'ws')}/api/remote.mux`,
      {
        headers: this.options.cookie ? { cookie: this.options.cookie } : {},
        perMessageDeflate: false,
        handshakeTimeout: 10_000
      }
    )
    this.socket = socket
    this.clientId = undefined
    this.follows.clear()
    this.generationAbort = new AbortController()
    socket.on('open', () => {
      if (this.socket !== socket || this.stopped) return
      this.open('events', '$events', {})
      this.open('control', 'session/control', {})
      this.syncFollows()
    })
    socket.on('message', (data, isBinary) => {
      if (isBinary || this.socket !== socket || this.stopped) return
      try {
        const frame = record(JSON.parse(data.toString()))
        if (frame) this.accept(frame)
      } catch {
        // Ignore malformed frames; no event data or credentials enter logs.
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.generationAbort.abort()
      this.pendingEvents.clear()
      this.follows.clear()
      if (!this.stopped) {
        this.retry = setTimeout(() => {
          this.retry = undefined
          this.start()
        }, 1_000)
      }
    })
  }

  stop(): void {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
    this.generationAbort.abort()
    this.pendingEvents.clear()
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.follows.clear()
  }

  follow(sessionIds: Iterable<string>): void {
    this.wanted = new Set(sessionIds)
    this.syncFollows()
  }

  private open(streamId: string, endpoint: string, args: Frame): void {
    this.socket?.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
  }

  private syncFollows(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    for (const [streamId, sessionId] of this.follows) {
      if (this.wanted.has(sessionId)) continue
      this.socket.send(JSON.stringify({ type: 'cancel', streamId }))
      this.follows.delete(streamId)
    }
    const followed = new Set(this.follows.values())
    for (const sessionId of this.wanted) {
      if (followed.has(sessionId)) continue
      const streamId = `session-${++this.nextStreamId}`
      this.follows.set(streamId, sessionId)
      this.open(streamId, 'session/follow', {
        request: { address: { kind: 'session', sessionId }, maxMessages: 1 }
      })
    }
  }

  private accept(frame: Frame): void {
    const streamId = frame.streamId
    if (typeof streamId !== 'string') return
    if (frame.type === 'error' || frame.type === 'end') {
      if (streamId === 'events' || streamId === 'control') {
        // A live carrier with a dead logical stream must also reconnect.
        this.socket?.close()
      } else if (this.follows.has(streamId)) {
        this.follows.delete(streamId)
        if (record(frame.error)?.code !== 'session/not-found') this.socket?.close()
      }
      return
    }
    if (frame.type !== 'item') return
    const value = record(frame.value)
    if (!value) return
    if (streamId === 'events') this.event(value)
    else if (streamId === 'control') this.control(value)
    else {
      const sessionId = this.follows.get(streamId)
      if (!sessionId) return
      // The opening history is not a new turn. Only live journal entries
      // advance activity; replaying old turn/end would overwrite list.running.
      if (value.type !== 'snapshot' && record(value.event)) {
        this.options.mux({ type: 'session/event', sessionId, event: value.event, view: value.view })
      }
    }
  }

  private event(frame: Frame): void {
    if (frame.type === 'ready' && typeof frame.clientId === 'string') {
      this.clientId = frame.clientId
      this.options.ready()
      return
    }
    if (frame.type === 'waterfall' && this.clientId && typeof frame.eventId === 'string') {
      const socket = this.socket
      const eventId = frame.eventId
      const abort = new AbortController()
      this.pendingEvents.set(eventId, abort)
      const signal = AbortSignal.any([this.generationAbort.signal, abort.signal])
      void this.options.passEvent(this.clientId, frame.eventId, signal).catch(() => {
        if (!signal.aborted && this.socket === socket) socket?.close()
      }).finally(() => {
        if (this.pendingEvents.get(eventId) === abort) this.pendingEvents.delete(eventId)
      })
      return
    }
    if (frame.type === 'cancel' && typeof frame.eventId === 'string') {
      this.pendingEvents.get(frame.eventId)?.abort()
      this.pendingEvents.delete(frame.eventId)
      return
    }
    if (frame.type !== 'emit' || !Array.isArray(frame.args)) return
    const [first, second] = frame.args
    if (frame.event === 'api-session/added') {
      const summary = record(first)
      if (summary) this.options.host({ ...summary, type: 'host/session-added' })
      return
    }
    if (typeof first !== 'string') return
    const type = {
      'api-session/removed': 'host/session-removed',
      'api-session/status': 'host/session-status',
      'api-session/error': 'host/agent-error',
      'api-session/activity': 'host/session-activity'
    }[String(frame.event)]
    if (type) this.options.host({
      type, sessionId: first,
      ...(type === 'host/session-status' && typeof second === 'boolean' ? { running: second } : {}),
      ...(type === 'host/agent-error' && typeof second === 'string' ? { message: second } : {}),
      ...(type === 'host/session-activity' && typeof second === 'number' ? { updatedAt: second } : {})
    })
  }

  private control(frame: Frame): void {
    if (frame.type === 'projection') {
      this.options.mux({ ...frame, type: 'session/projection' })
    } else if (frame.type === 'baseline') {
      const projections = record(record(frame.value)?.projections)
      for (const [sessionId, block] of Object.entries(projections ?? {})) {
        const values = record(record(block)?.values)
        if (typeof values?.title === 'string') this.options.mux({
          type: 'session/projection', sessionId, key: 'title', value: values.title
        })
      }
    }
  }
}

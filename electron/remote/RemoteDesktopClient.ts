import {
  REMOTE_DRIVE_IDLE_STATE,
  REMOTE_DESKTOP_IDLE_STATE,
  type ExitPayload,
  type RemoteDriveState,
  type RemoteDesktopError,
  type RemoteDesktopState
} from '../../shared/ipc-contract'
import {
  REMOTE_PROTOCOL_LIMITS,
  isRemotePhoneToDesktopMessage,
  parseJoinUrl,
  parseRemoteFrame,
  type JoinUrl,
  type RemoteDriveRejectReason,
  type RemoteMessage,
  type RemotePtyHistorySnapshot,
  type RemoteSession
} from '../../shared/remote-protocol'

export type RemoteSessionChange =
  | { kind: 'upsert'; session: RemoteSession }
  | { kind: 'removed'; sessionId: string }

export interface RemoteSessionSource {
  list(): RemoteSession[]
  subscribe(listener: (change: RemoteSessionChange) => void): () => void
}

export interface RemoteDriveObserver {
  onOutput(data: Uint8Array): void
  onExit(payload: ExitPayload): void
  onOverflow(): void
}

export interface RemoteDrivenPty {
  readonly sessionId: string
  readonly terminalId: string
  readonly history: RemotePtyHistorySnapshot
  write(data: string): void
  resize(cols: number, rows: number): void
  acknowledge(bytes: number): void
  release(): void
}

export type RemotePtyOpenResult =
  | { ok: true; target: RemoteDrivenPty }
  | { ok: false; reason: RemoteDriveRejectReason }

export interface RemotePtyHost {
  open(
    input: { sessionId: string; cols: number; rows: number },
    observer: RemoteDriveObserver
  ): RemotePtyOpenResult
}

function driveOkMessage(
  request: Extract<RemoteMessage, { type: 'drive' }>,
  history: RemotePtyHistorySnapshot
): Extract<RemoteMessage, { type: 'drive-ok' }> {
  return {
    v: 1,
    type: 'drive-ok',
    requestId: request.requestId,
    sessionId: request.sessionId,
    cols: request.cols,
    rows: request.rows,
    history
  }
}

/** Keep the newest complete history events while guaranteeing one valid v1 frame. */
function boundedDriveOkMessage(
  request: Extract<RemoteMessage, { type: 'drive' }>,
  history: RemotePtyHistorySnapshot
): Extract<RemoteMessage, { type: 'drive-ok' }> {
  const full = driveOkMessage(request, history)
  if (
    history.retainedOutputBytes <=
      REMOTE_PROTOCOL_LIMITS.frameBytes - 32 * 1024 &&
    Buffer.byteLength(JSON.stringify(full)) <=
    REMOTE_PROTOCOL_LIMITS.frameBytes
  ) {
    return full
  }

  const selected = [] as RemotePtyHistorySnapshot['events']
  let selectedJsonBytes = 0
  const eventBudget = REMOTE_PROTOCOL_LIMITS.frameBytes - 32 * 1024
  for (let index = history.events.length - 1; index >= 0; index--) {
    const event = history.events[index]
    if (!event) continue
    const encodedBytes = Buffer.byteLength(JSON.stringify(event)) + 1
    if (selectedJsonBytes + encodedBytes > eventBudget) break
    selected.push(event)
    selectedJsonBytes += encodedBytes
  }
  selected.reverse()

  const build = (): Extract<RemoteMessage, { type: 'drive-ok' }> => {
    const omittedCount = history.events.length - selected.length
    const omitted = history.events.slice(0, omittedCount)
    const droppedOutputBytes = omitted.reduce(
      (total, event) =>
        total + (event.kind === 'output' ? event.byteLength : 0),
      0
    )
    const retainedOutputBytes = selected.reduce(
      (total, event) =>
        total + (event.kind === 'output' ? event.byteLength : 0),
      0
    )
    return driveOkMessage(request, {
      complete: history.complete && omittedCount === 0,
      retainedOutputBytes,
      droppedOutputBytes: history.droppedOutputBytes + droppedOutputBytes,
      droppedEvents: history.droppedEvents + omittedCount,
      events: [...selected]
    })
  }

  let bounded = build()
  while (
    selected.length > 0 &&
    Buffer.byteLength(JSON.stringify(bounded)) >
      REMOTE_PROTOCOL_LIMITS.frameBytes
  ) {
    selected.shift()
    bounded = build()
  }
  return bounded
}

export class RemoteDesktopClient {
  private socket: WebSocket | null = null
  private join: JoinUrl | null = null
  private userClosed = false
  private snapshotSent = false
  private unsubscribe: (() => void) | null = null
  private state: RemoteDesktopState = REMOTE_DESKTOP_IDLE_STATE
  private driveState: RemoteDriveState = REMOTE_DRIVE_IDLE_STATE
  private driven: RemoteDrivenPty | null = null
  private phoneGraceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingRevoke: {
    promise: Promise<RemoteDesktopState>
    resolve: (state: RemoteDesktopState) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  constructor(
    private readonly deps: {
      sessions: RemoteSessionSource
      broadcast: (state: RemoteDesktopState) => void
      pty?: RemotePtyHost
      broadcastDrive?: (state: RemoteDriveState) => void
      revokeTimeoutMs?: number
      phoneGraceMs?: number
    }
  ) {}

  getState(): RemoteDesktopState {
    return this.state
  }

  getDriveState(): RemoteDriveState {
    return this.driveState
  }

  reclaim(sessionId: string): RemoteDriveState {
    if (this.driven?.sessionId === sessionId) {
      this.releaseDrive('reclaim')
    }
    return this.driveState
  }

  connect(rawUrl: string): RemoteDesktopState {
    this.cancelPendingRevoke(REMOTE_DESKTOP_IDLE_STATE)
    this.tearDownSocket()
    const parsed = parseJoinUrl(rawUrl)
    if (!parsed.ok) {
      this.setState({
        phase: 'error',
        href: rawUrl.trim() || null,
        origin: null,
        error: parsed.reason
      })
      return this.state
    }

    this.userClosed = false
    this.join = parsed.value
    this.setState({
      phase: 'connecting',
      href: parsed.value.href,
      origin: parsed.value.origin,
      error: null
    })

    const socket = new WebSocket(parsed.value.wsUrl)
    this.socket = socket
    this.unsubscribe = this.deps.sessions.subscribe((change) => {
      this.onSessionChange(change)
    })

    socket.onopen = () => {
      if (this.socket !== socket) return
      this.send({
        v: 1,
        type: 'hello',
        role: 'desktop',
        roomId: parsed.value.roomId
      })
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      if (typeof event.data !== 'string') return
      this.onFrame(event.data)
    }
    socket.onerror = () => {
      /* close 会跟上来 */
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.cancelPhoneGrace()
      this.releaseDrive()
      this.snapshotSent = false
      this.unsubscribe?.()
      this.unsubscribe = null
      if (this.pendingRevoke) {
        this.finishRevoke(false)
        return
      }
      if (this.userClosed) return
      if (this.state.phase === 'error') return
      this.setState({
        phase: 'error',
        href: parsed.value.href,
        origin: parsed.value.origin,
        error: 'connect-failed'
      })
    }
    return this.state
  }

  disconnect(): RemoteDesktopState {
    this.tearDownSocket()
    this.setState(REMOTE_DESKTOP_IDLE_STATE)
    this.cancelPendingRevoke(this.state)
    return this.state
  }

  revoke(): Promise<RemoteDesktopState> {
    if (this.pendingRevoke) return this.pendingRevoke.promise
    const roomId = this.join?.roomId
    if (!roomId || this.socket?.readyState !== WebSocket.OPEN) {
      const href = this.join?.href ?? this.state.href
      const origin = this.join?.origin ?? this.state.origin
      this.setState({ phase: 'error', href, origin, error: 'not-connected' })
      return Promise.resolve(this.state)
    }
    const join = this.join
    if (!join) return Promise.resolve(this.state)
    let resolvePromise!: (state: RemoteDesktopState) => void
    const promise = new Promise<RemoteDesktopState>((resolve) => {
      resolvePromise = resolve
    })
    const timer = setTimeout(
      () => this.finishRevoke(false),
      this.deps.revokeTimeoutMs ?? 3_000
    )
    this.pendingRevoke = { promise, resolve: resolvePromise, timer }
    this.setState({
      phase: 'revoking',
      href: join.href,
      origin: join.origin,
      error: null
    })
    this.send({ v: 1, type: 'revoke', roomId })
    return promise
  }

  dispose(): void {
    this.disconnect()
  }

  private onFrame(text: string): void {
    const parsed = parseRemoteFrame(text)
    if (!parsed.ok) return
    const message = parsed.value
    switch (message.type) {
      case 'hello-ok':
        if (message.peer.phone) this.cancelPhoneGrace()
        this.setState({
          phase: message.peer.phone ? 'peer-online' : 'waiting-phone',
          href: this.join?.href ?? this.state.href,
          origin: this.join?.origin ?? this.state.origin,
          error: null
        })
        if (message.peer.phone) this.sendSnapshot()
        return
      case 'peer-join':
        if (message.role !== 'phone') return
        this.cancelPhoneGrace()
        this.setState({
          phase: 'peer-online',
          href: this.join?.href ?? this.state.href,
          origin: this.join?.origin ?? this.state.origin,
          error: null
        })
        this.sendSnapshot()
        return
      case 'peer-leave':
        if (message.role !== 'phone') return
        this.snapshotSent = false
        this.setState({
          phase: 'waiting-phone',
          href: this.join?.href ?? this.state.href,
          origin: this.join?.origin ?? this.state.origin,
          error: null
        })
        this.startPhoneGrace()
        return
      case 'occupied':
        this.fail('occupied')
        return
      case 'bad-key':
        this.fail('bad-key')
        return
      case 'revoked':
        if (this.pendingRevoke) {
          this.finishRevoke(true)
          return
        }
        this.fail('revoked')
        return
      case 'drive':
        this.startDrive(message)
        return
      case 'undrive':
        if (this.driven?.sessionId !== message.sessionId) return
        this.releaseDrive('left')
        return
      case 'pty-resize':
        if (this.driven?.sessionId !== message.sessionId) return
        this.driven.resize(message.cols, message.rows)
        this.setDriveState({
          phase: 'driven',
          sessionId: this.driven.sessionId,
          terminalId: this.driven.terminalId,
          cols: message.cols,
          rows: message.rows
        })
        return
      case 'pty-in':
        if (this.driven?.sessionId !== message.sessionId) return
        this.driven.write(message.data)
        return
      case 'pty-ack':
        if (this.driven?.sessionId !== message.sessionId) return
        this.driven.acknowledge(message.bytes)
        return
      default:
        if (isRemotePhoneToDesktopMessage(message)) {
          const reply: RemoteMessage = {
            v: 1,
            type: 'not-implemented',
            for: message.type
          }
          if ('requestId' in message) reply.requestId = message.requestId
          this.send(reply)
        }
    }
  }

  private onSessionChange(change: RemoteSessionChange): void {
    if (!this.snapshotSent) return
    if (change.kind === 'removed') {
      this.send({ v: 1, type: 'session-removed', sessionId: change.sessionId })
      return
    }
    this.send({ v: 1, type: 'session-upsert', session: change.session })
  }

  private startDrive(
    message: Extract<RemoteMessage, { type: 'drive' }>
  ): void {
    if (this.driven) {
      this.send({
        v: 1,
        type: 'drive-reject',
        requestId: message.requestId,
        sessionId: message.sessionId,
        reason: 'busy'
      })
      return
    }
    const opened = this.deps.pty?.open(
      {
        sessionId: message.sessionId,
        cols: message.cols,
        rows: message.rows
      },
      {
        onOutput: (data) => {
          if (this.driven?.sessionId !== message.sessionId) return
          this.send({
            v: 1,
            type: 'pty-out',
            sessionId: message.sessionId,
            data: Buffer.from(data).toString('base64'),
            byteLength: data.byteLength
          })
        },
        onExit: (payload) => {
          if (this.driven?.sessionId !== message.sessionId) return
          const exit: RemoteMessage = {
            v: 1,
            type: 'pty-exit',
            sessionId: message.sessionId
          }
          if (typeof payload.code === 'number') exit.code = payload.code
          if (typeof payload.signal === 'number') exit.signal = payload.signal
          this.send(exit)
          this.releaseDrive('session-exit')
        },
        onOverflow: () => {
          if (this.driven?.sessionId !== message.sessionId) return
          this.releaseDrive('desktop-offline')
        }
      }
    )
    if (!opened) {
      const reply: RemoteMessage = {
        v: 1,
        type: 'not-implemented',
        for: message.type,
        requestId: message.requestId
      }
      this.send(reply)
      return
    }
    if (!opened.ok) {
      this.send({
        v: 1,
        type: 'drive-reject',
        requestId: message.requestId,
        sessionId: message.sessionId,
        reason: opened.reason
      })
      return
    }
    this.driven = opened.target
    this.setDriveState({
      phase: 'driven',
      sessionId: opened.target.sessionId,
      terminalId: opened.target.terminalId,
      cols: message.cols,
      rows: message.rows
    })
    this.send(boundedDriveOkMessage(message, opened.target.history))
  }

  private sendSnapshot(): void {
    this.send({
      v: 1,
      type: 'sessions-snapshot',
      sessions: this.deps.sessions.list()
    })
    this.snapshotSent = true
  }

  private fail(error: RemoteDesktopError): void {
    const href = this.join?.href ?? this.state.href
    const origin = this.join?.origin ?? this.state.origin
    this.tearDownSocket()
    this.setState({ phase: 'error', href, origin, error })
    this.cancelPendingRevoke(this.state)
  }

  private send(message: RemoteMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(message))
  }

  private tearDownSocket(): void {
    this.userClosed = true
    this.cancelPhoneGrace()
    this.releaseDrive('desktop-offline')
    this.unsubscribe?.()
    this.unsubscribe = null
    this.snapshotSent = false
    const socket = this.socket
    this.socket = null
    this.join = null
    if (
      socket &&
      (socket.readyState === WebSocket.CONNECTING ||
        socket.readyState === WebSocket.OPEN)
    ) {
      socket.close()
    }
  }

  private releaseDrive(
    reason?: Extract<RemoteMessage, { type: 'undriven' }>['reason']
  ): void {
    this.cancelPhoneGrace()
    const driven = this.driven
    this.driven = null
    driven?.release()
    this.setDriveState(REMOTE_DRIVE_IDLE_STATE)
    if (driven && reason) {
      this.send({
        v: 1,
        type: 'undriven',
        sessionId: driven.sessionId,
        reason
      })
    }
  }

  private setDriveState(state: RemoteDriveState): void {
    if (
      state.phase === this.driveState.phase &&
      state.sessionId === this.driveState.sessionId &&
      state.terminalId === this.driveState.terminalId &&
      state.cols === this.driveState.cols &&
      state.rows === this.driveState.rows
    ) {
      return
    }
    this.driveState = state
    this.deps.broadcastDrive?.(state)
  }

  private startPhoneGrace(): void {
    this.cancelPhoneGrace()
    if (!this.driven) return
    this.phoneGraceTimer = setTimeout(() => {
      this.phoneGraceTimer = null
      this.releaseDrive('phone-timeout')
    }, this.deps.phoneGraceMs ?? 15_000)
  }

  private cancelPhoneGrace(): void {
    if (!this.phoneGraceTimer) return
    clearTimeout(this.phoneGraceTimer)
    this.phoneGraceTimer = null
  }

  private finishRevoke(confirmed: boolean): void {
    const pending = this.pendingRevoke
    if (!pending) return
    this.pendingRevoke = null
    clearTimeout(pending.timer)
    const href = this.join?.href ?? this.state.href
    const origin = this.join?.origin ?? this.state.origin
    this.tearDownSocket()
    this.setState(
      confirmed
        ? REMOTE_DESKTOP_IDLE_STATE
        : { phase: 'error', href, origin, error: 'revoke-unconfirmed' }
    )
    pending.resolve(this.state)
  }

  private cancelPendingRevoke(state: RemoteDesktopState): void {
    const pending = this.pendingRevoke
    if (!pending) return
    this.pendingRevoke = null
    clearTimeout(pending.timer)
    pending.resolve(state)
  }

  private setState(state: RemoteDesktopState): void {
    this.state = state
    this.deps.broadcast(state)
  }
}

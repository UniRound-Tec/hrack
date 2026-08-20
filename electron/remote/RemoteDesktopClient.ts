import {
  REMOTE_DESKTOP_IDLE_STATE,
  type RemoteDesktopError,
  type RemoteDesktopState
} from '../../shared/ipc-contract'
import {
  isRemotePhoneToDesktopMessage,
  parseJoinUrl,
  parseRemoteFrame,
  type JoinUrl,
  type RemoteMessage,
  type RemoteSession
} from '../../shared/remote-protocol'

export type RemoteSessionChange =
  | { kind: 'upsert'; session: RemoteSession }
  | { kind: 'removed'; sessionId: string }

export interface RemoteSessionSource {
  list(): RemoteSession[]
  subscribe(listener: (change: RemoteSessionChange) => void): () => void
}

export class RemoteDesktopClient {
  private socket: WebSocket | null = null
  private join: JoinUrl | null = null
  private userClosed = false
  private snapshotSent = false
  private unsubscribe: (() => void) | null = null
  private state: RemoteDesktopState = REMOTE_DESKTOP_IDLE_STATE
  private pendingRevoke: {
    promise: Promise<RemoteDesktopState>
    resolve: (state: RemoteDesktopState) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  constructor(
    private readonly deps: {
      sessions: RemoteSessionSource
      broadcast: (state: RemoteDesktopState) => void
      revokeTimeoutMs?: number
    }
  ) {}

  getState(): RemoteDesktopState {
    return this.state
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

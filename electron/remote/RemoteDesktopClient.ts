import type { RemoteDesktopState } from '../../shared/ipc-contract'
import {
  parseJoinUrl,
  parseRemoteMessage,
  type JoinUrl,
  type RemoteMessage,
  type RemoteSession
} from '../../shared/remote-protocol'

const UNIMPLEMENTED_FROM_PHONE = new Set([
  'drive',
  'undrive',
  'create',
  'pty-in',
  'pty-resize',
  'pty-ack'
])

export type RemoteSessionChange =
  | { kind: 'upsert'; session: RemoteSession }
  | { kind: 'removed'; sessionId: string }

export interface RemoteSessionSource {
  list(): RemoteSession[]
  subscribe(listener: (change: RemoteSessionChange) => void): () => void
}

const IDLE: RemoteDesktopState = {
  phase: 'idle',
  href: null,
  origin: null,
  error: null
}

export class RemoteDesktopClient {
  private socket: WebSocket | null = null
  private join: JoinUrl | null = null
  private userClosed = false
  private phoneSeated = false
  private snapshotSent = false
  private unsubscribe: (() => void) | null = null
  private state: RemoteDesktopState = IDLE

  constructor(
    private readonly deps: {
      sessions: RemoteSessionSource
      broadcast: (state: RemoteDesktopState) => void
    }
  ) {}

  getState(): RemoteDesktopState {
    return this.state
  }

  connect(rawUrl: string): RemoteDesktopState {
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
      this.phoneSeated = false
      this.snapshotSent = false
      this.unsubscribe?.()
      this.unsubscribe = null
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
    this.setState(IDLE)
    return this.state
  }

  revoke(): RemoteDesktopState {
    const roomId = this.join?.roomId
    if (roomId && this.socket?.readyState === WebSocket.OPEN) {
      this.send({ v: 1, type: 'revoke', roomId })
    }
    return this.disconnect()
  }

  dispose(): void {
    this.disconnect()
  }

  private onFrame(text: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(text) as unknown
    } catch {
      return
    }
    const parsed = parseRemoteMessage(raw)
    if (!parsed.ok) return
    const message = parsed.value
    switch (message.type) {
      case 'hello-ok':
        this.phoneSeated = message.peer.phone
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
        this.phoneSeated = true
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
        this.phoneSeated = false
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
        this.fail('revoked')
        return
      default:
        if (UNIMPLEMENTED_FROM_PHONE.has(message.type)) {
          this.send({ v: 1, type: 'not-implemented', for: message.type })
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

  private fail(error: string): void {
    const href = this.join?.href ?? this.state.href
    const origin = this.join?.origin ?? this.state.origin
    this.tearDownSocket()
    this.setState({ phase: 'error', href, origin, error })
  }

  private send(message: RemoteMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(message))
  }

  private tearDownSocket(): void {
    this.userClosed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    this.phoneSeated = false
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

  private setState(state: RemoteDesktopState): void {
    this.state = state
    this.deps.broadcast(state)
  }
}

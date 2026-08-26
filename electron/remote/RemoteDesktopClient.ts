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
  parseJoinUrl,
  parseRemoteFrame,
  type JoinUrl,
  type RemoteCreateRejectReason,
  type RemoteDriveRejectReason,
  type RemoteLaunchable,
  type RemoteMessage,
  type RemotePtyHistorySnapshot,
  type RemoteSession,
  type RemoteWebSurface,
  type RemoteWorkspaceEntry,
  type RemoteWorkspaceListRejectReason
} from '../../shared/remote-protocol'
import WebSocket, { type RawData } from 'ws'

const METRICS_BROADCAST_INTERVAL_MS = 500
const LATENCY_PROBE_INTERVAL_MS = 5_000
const LATENCY_PROBE_TIMEOUT_MS = 10_000
const LATENCY_PROBE_PREFIX = 'hrack-rtt:'

type RemoteDesktopCoreState = Omit<
  RemoteDesktopState,
  'latencyMs' | 'uploadedBytes' | 'downloadedBytes'
>

function rawDataByteLength(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.byteLength
  if (data instanceof ArrayBuffer) return data.byteLength
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0)
  }
  return 0
}

function rawDataToText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return ''
}

export interface RemoteDshTunnelLease {
  roomId: string
  tunnelUrl: string
  publicOrigin: string
  seatToken: string
}

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

export interface RemoteLaunchRequest {
  installationId: string
  workspace: string
  args: readonly string[]
  skipApproval: boolean
  cols: number
  rows: number
}

export type RemoteLaunchResult =
  | { ok: true; sessionId: string; workspace: string }
  | {
      ok: false
      reason: Extract<
        RemoteCreateRejectReason,
        'invalid-workspace' | 'installation-not-found' | 'launch-failed'
      >
      detail?: string
    }

export interface RemoteLaunchHost {
  catalog(): Promise<RemoteLaunchable[]>
  create(input: RemoteLaunchRequest): Promise<RemoteLaunchResult>
}

export type RemoteWorkspaceListResult =
  | {
      ok: true
      path: string | null
      parentPath?: string
      entries: RemoteWorkspaceEntry[]
      nextOffset?: number
    }
  | { ok: false; reason: RemoteWorkspaceListRejectReason }

export interface RemoteWorkspaceHost {
  list(input: {
    installationId: string
    path?: string
    offset: number
  }): Promise<RemoteWorkspaceListResult>
}

interface CreateRequestRecord {
  fingerprint: string
  result: Promise<RemoteMessage[]>
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
  private recentWorkspaces: string[] = []
  private readonly createRequests = new Map<string, CreateRequestRecord>()
  private activeCreateRequestId: string | null = null
  private readonly activeWorkspaceRequests = new Map<string, WebSocket>()
  private phoneGraceTimer: ReturnType<typeof setTimeout> | null = null
  private metricsBroadcastTimer: ReturnType<typeof setTimeout> | null = null
  private latencyProbeTimer: ReturnType<typeof setTimeout> | null = null
  private latencyProbe: { token: string; startedAt: number } | null = null
  private latencyProbeSequence = 0
  private latencyMs: number | null = null
  private uploadedBytes = 0
  private downloadedBytes = 0
  private dshSurface: RemoteWebSurface | null = null
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
      launch?: RemoteLaunchHost
      workspace?: RemoteWorkspaceHost
      focusSession?: (sessionId: string) => boolean
      broadcastDrive?: (state: RemoteDriveState) => void
      revokeTimeoutMs?: number
      phoneGraceMs?: number
      onDshTunnelLease?: (lease: RemoteDshTunnelLease | null) => void
    }
  ) {}

  getState(): RemoteDesktopState {
    return this.state
  }

  getDriveState(): RemoteDriveState {
    return this.driveState
  }

  setRecentWorkspaces(workspaces: readonly string[]): void {
    const next: string[] = []
    const seen = new Set<string>()
    for (const value of workspaces) {
      if (typeof value !== 'string') continue
      const workspace = value.trim()
      if (
        !workspace ||
        workspace.length > REMOTE_PROTOCOL_LIMITS.workspaceChars ||
        workspace.includes('\0') ||
        seen.has(workspace)
      ) {
        continue
      }
      seen.add(workspace)
      next.push(workspace)
      if (next.length === 5) break
    }
    if (
      next.length === this.recentWorkspaces.length &&
      next.every(
        (workspace, index) => workspace === this.recentWorkspaces[index]
      )
    ) {
      return
    }
    this.recentWorkspaces = next
    this.refreshCatalog()
  }

  refreshCatalog(): void {
    void this.sendCatalog()
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
    this.resetMetrics()
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

    socket.on('open', () => {
      if (this.socket !== socket) return
      this.send({
        v: 1,
        type: 'hello',
        role: 'desktop',
        roomId: parsed.value.roomId
      })
      this.startLatencyProbes(socket)
    })
    socket.on('message', (data, isBinary) => {
      if (this.socket !== socket) return
      this.recordTraffic('down', rawDataByteLength(data))
      if (isBinary) return
      this.onFrame(rawDataToText(data))
    })
    socket.on('pong', (data) => {
      if (this.socket !== socket) return
      this.acceptLatencyPong(socket, data)
    })
    socket.on('error', () => {
      /* close 会跟上来 */
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.stopLatencyProbes()
      this.deps.onDshTunnelLease?.(null)
      this.cancelPhoneGrace()
      this.releaseDrive()
      this.resetCreateRequests()
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
    })
    return this.state
  }

  disconnect(): RemoteDesktopState {
    this.tearDownSocket()
    this.resetMetrics()
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
        this.publishDshLease(message)
        if (message.peer.phone) this.cancelPhoneGrace()
        this.setState({
          phase: message.peer.phone ? 'peer-online' : 'waiting-phone',
          href: this.join?.href ?? this.state.href,
          origin: this.join?.origin ?? this.state.origin,
          error: null
        })
        if (message.peer.phone) {
          this.sendSnapshot()
          this.refreshCatalog()
          this.sendDshSurface()
        }
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
        this.refreshCatalog()
        this.sendDshSurface()
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
      case 'focus-session':
        this.deps.focusSession?.(message.sessionId)
        return
      case 'drive':
        this.send(this.openDrive(message))
        return
      case 'create':
        void this.startCreate(message)
        return
      case 'workspace-list':
        void this.startWorkspaceList(message)
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
        return
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

  private async startCreate(
    message: Extract<RemoteMessage, { type: 'create' }>
  ): Promise<void> {
    const fingerprint = JSON.stringify([
      message.installationId,
      message.workspace,
      message.cols,
      message.rows,
      message.skipApproval === undefined
        ? ['absent']
        : ['present', message.skipApproval],
      message.args === undefined ? ['absent'] : ['present', ...message.args]
    ])
    const existing = this.createRequests.get(message.requestId)
    if (existing && existing.fingerprint !== fingerprint) {
      this.send({
        v: 1,
        type: 'create-reject',
        requestId: message.requestId,
        reason: 'duplicate-mismatch'
      })
      return
    }

    let record = existing
    if (!record) {
      const result =
        this.driven || this.activeCreateRequestId
          ? Promise.resolve<RemoteMessage[]>([
              {
                v: 1,
                type: 'create-reject',
                requestId: message.requestId,
                reason: 'busy'
              }
            ])
          : this.runCreate(message)
      record = { fingerprint, result }
      this.createRequests.set(message.requestId, record)
    }

    const responses = await record.result
    if (this.createRequests.get(message.requestId) !== record) return
    for (const response of responses) this.send(response)
  }

  setDshSurface(surface: RemoteWebSurface | null): void {
    this.dshSurface = surface ? { ...surface } : null
    this.sendDshSurface()
  }

  private async startWorkspaceList(
    message: Extract<RemoteMessage, { type: 'workspace-list' }>
  ): Promise<void> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (
      this.activeWorkspaceRequests.has(message.requestId) ||
      this.activeWorkspaceRequests.size >= 2
    ) {
      this.send({
        v: 1,
        type: 'workspace-list-reject',
        requestId: message.requestId,
        reason: 'busy'
      })
      return
    }
    const workspace = this.deps.workspace
    if (!workspace) {
      this.send({
        v: 1,
        type: 'not-implemented',
        for: message.type,
        requestId: message.requestId
      })
      return
    }

    this.activeWorkspaceRequests.set(message.requestId, socket)
    try {
      const result = await workspace.list({
        installationId: message.installationId,
        ...(message.path ? { path: message.path } : {}),
        offset: message.offset ?? 0
      })
      if (
        this.socket !== socket ||
        socket.readyState !== WebSocket.OPEN ||
        this.activeWorkspaceRequests.get(message.requestId) !== socket
      ) {
        return
      }
      if (result.ok) {
        this.send({
          v: 1,
          type: 'workspace-list-ok',
          requestId: message.requestId,
          installationId: message.installationId,
          path: result.path,
          entries: result.entries,
          ...(result.parentPath ? { parentPath: result.parentPath } : {}),
          ...(result.nextOffset !== undefined
            ? { nextOffset: result.nextOffset }
            : {})
        })
      } else {
        this.send({
          v: 1,
          type: 'workspace-list-reject',
          requestId: message.requestId,
          reason: result.reason
        })
      }
    } catch {
      if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
        this.send({
          v: 1,
          type: 'workspace-list-reject',
          requestId: message.requestId,
          reason: 'unavailable'
        })
      }
    } finally {
      if (this.activeWorkspaceRequests.get(message.requestId) === socket) {
        this.activeWorkspaceRequests.delete(message.requestId)
      }
    }
  }

  private async runCreate(
    message: Extract<RemoteMessage, { type: 'create' }>
  ): Promise<RemoteMessage[]> {
    const launch = this.deps.launch
    if (!launch) {
      return [
        {
          v: 1,
          type: 'not-implemented',
          for: message.type,
          requestId: message.requestId
        }
      ]
    }
    this.activeCreateRequestId = message.requestId
    let result: RemoteLaunchResult
    try {
      result = await launch.create({
        installationId: message.installationId,
        workspace: message.workspace,
        args: message.args ?? [],
        skipApproval: message.skipApproval === true,
        cols: message.cols,
        rows: message.rows
      })
    } catch {
      result = { ok: false, reason: 'launch-failed' }
    } finally {
      if (this.activeCreateRequestId === message.requestId) {
        this.activeCreateRequestId = null
      }
    }
    if (result.ok) {
      const created: Extract<RemoteMessage, { type: 'create-ok' }> = {
        v: 1,
        type: 'create-ok',
        requestId: message.requestId,
        sessionId: result.sessionId
      }
      const drive = this.openDrive({
        v: 1,
        type: 'drive',
        requestId: message.requestId,
        sessionId: result.sessionId,
        cols: message.cols,
        rows: message.rows
      })
      return [created, drive]
    }
    const rejection: Extract<RemoteMessage, { type: 'create-reject' }> = {
      v: 1,
      type: 'create-reject',
      requestId: message.requestId,
      reason: result.reason
    }
    if (result.detail) rejection.detail = result.detail
    return [rejection]
  }

  private openDrive(
    message: Extract<RemoteMessage, { type: 'drive' }>
  ): RemoteMessage {
    if (this.driven) {
      return {
        v: 1,
        type: 'drive-reject',
        requestId: message.requestId,
        sessionId: message.sessionId,
        reason: 'busy'
      }
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
      return {
        v: 1,
        type: 'not-implemented',
        for: message.type,
        requestId: message.requestId
      }
    }
    if (!opened.ok) {
      return {
        v: 1,
        type: 'drive-reject',
        requestId: message.requestId,
        sessionId: message.sessionId,
        reason: opened.reason
      }
    }
    this.driven = opened.target
    this.setDriveState({
      phase: 'driven',
      sessionId: opened.target.sessionId,
      terminalId: opened.target.terminalId,
      cols: message.cols,
      rows: message.rows
    })
    return boundedDriveOkMessage(message, opened.target.history)
  }

  private sendSnapshot(): void {
    this.send({
      v: 1,
      type: 'sessions-snapshot',
      sessions: this.deps.sessions.list()
    })
    this.snapshotSent = true
  }

  private sendDshSurface(): void {
    if (!this.dshSurface) return
    this.send({ v: 1, type: 'dsh-surface-state', surface: this.dshSurface })
  }

  private publishDshLease(
    message: Extract<RemoteMessage, { type: 'hello-ok' }>
  ): void {
    const tunnel = message.relayCapabilities?.dshWebTunnel
    const join = this.join
    if (!tunnel || !message.dshSeatToken || !join) {
      this.deps.onDshTunnelLease?.(null)
      return
    }
    this.deps.onDshTunnelLease?.({
      roomId: join.roomId,
      tunnelUrl: join.wsUrl.replace(/\/v1\/ws$/, '/v1/dsh-tunnel'),
      publicOrigin: tunnel.origin,
      seatToken: message.dshSeatToken
    })
  }

  private async sendCatalog(): Promise<void> {
    const launch = this.deps.launch
    const socket = this.socket
    if (!launch || !this.snapshotSent || socket?.readyState !== WebSocket.OPEN) {
      return
    }
    try {
      const launchable = await launch.catalog()
      if (
        this.socket !== socket ||
        !this.snapshotSent ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return
      }
      this.send({
        v: 1,
        type: 'catalog',
        launchable,
        recentWorkspaces: [...this.recentWorkspaces]
      })
    } catch {
      // Catalog refresh is recoverable; the session/drive channel remains live.
    }
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
    const payload = JSON.stringify(message)
    this.socket.send(payload)
    this.recordTraffic('up', Buffer.byteLength(payload))
  }

  private startLatencyProbes(socket: WebSocket): void {
    this.stopLatencyProbes()
    const probe = (): void => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
      const now = Date.now()
      if (
        this.latencyProbe &&
        now - this.latencyProbe.startedAt >= LATENCY_PROBE_TIMEOUT_MS
      ) {
        this.latencyProbe = null
        this.latencyMs = null
        this.broadcastMetrics()
      }
      if (!this.latencyProbe) {
        const token = `${LATENCY_PROBE_PREFIX}${++this.latencyProbeSequence}`
        this.latencyProbe = { token, startedAt: now }
        socket.ping(token)
      }
      this.latencyProbeTimer = setTimeout(probe, LATENCY_PROBE_INTERVAL_MS)
    }
    probe()
  }

  private acceptLatencyPong(socket: WebSocket, data: Buffer): void {
    if (this.socket !== socket || !this.latencyProbe) return
    if (data.toString('utf8') !== this.latencyProbe.token) return
    this.latencyMs = Math.max(0, Date.now() - this.latencyProbe.startedAt)
    this.latencyProbe = null
    this.broadcastMetrics()
  }

  private stopLatencyProbes(): void {
    if (this.latencyProbeTimer) clearTimeout(this.latencyProbeTimer)
    this.latencyProbeTimer = null
    this.latencyProbe = null
  }

  private recordTraffic(direction: 'up' | 'down', bytes: number): void {
    if (bytes <= 0) return
    if (direction === 'up') this.uploadedBytes += bytes
    else this.downloadedBytes += bytes
    if (this.metricsBroadcastTimer) return
    this.metricsBroadcastTimer = setTimeout(() => {
      this.metricsBroadcastTimer = null
      this.broadcastMetrics()
    }, METRICS_BROADCAST_INTERVAL_MS)
  }

  private broadcastMetrics(): void {
    this.setState(this.state)
  }

  private resetMetrics(): void {
    if (this.metricsBroadcastTimer) clearTimeout(this.metricsBroadcastTimer)
    this.metricsBroadcastTimer = null
    this.stopLatencyProbes()
    this.latencyMs = null
    this.uploadedBytes = 0
    this.downloadedBytes = 0
  }

  private tearDownSocket(): void {
    this.userClosed = true
    this.stopLatencyProbes()
    this.cancelPhoneGrace()
    this.releaseDrive('desktop-offline')
    this.unsubscribe?.()
    this.unsubscribe = null
    this.snapshotSent = false
    this.resetCreateRequests()
    this.deps.onDshTunnelLease?.(null)
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

  private resetCreateRequests(): void {
    this.createRequests.clear()
    this.activeCreateRequestId = null
    this.activeWorkspaceRequests.clear()
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
    if (confirmed) this.resetMetrics()
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

  private setState(state: RemoteDesktopCoreState | RemoteDesktopState): void {
    this.state = {
      phase: state.phase,
      href: state.href,
      origin: state.origin,
      error: state.error,
      latencyMs: this.latencyMs,
      uploadedBytes: this.uploadedBytes,
      downloadedBytes: this.downloadedBytes
    }
    this.deps.broadcast(this.state)
  }
}

import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  disconnect,
  emptyRooms,
  hello,
  isRemoteDesktopToPhoneMessage,
  isRemotePhoneToDesktopMessage,
  openRoom,
  parseRemoteFrame,
  revoke,
  type RemoteMessage,
  type RemoteRole,
  type RoomTable
} from '../../shared/remote-protocol'
import { parseDshTunnelControl } from '../../shared/dsh-tunnel-protocol'

interface SocketMeta {
  connectionId: string
  roomId: string | null
  role: RemoteRole | null
}

export class RemoteTestRelay {
  private rooms: RoomTable = emptyRooms()
  private readonly sockets = new Map<string, WebSocket>()
  private readonly meta = new Map<string, SocketMeta>()
  readonly hellos: Array<{ role: RemoteRole; roomId: string }> = []
  readonly fromDesktop: RemoteMessage[] = []
  readonly fromPhone: RemoteMessage[] = []
  readonly revokes: string[] = []
  readonly dshFrames: Array<string | Buffer> = []
  confirmRevokes = true
  private dshCapability: { publicOrigin: string; seatToken: string } | null = null
  private dshSocket: WebSocket | null = null

  private constructor(
    private readonly http: Server,
    private readonly wss: WebSocketServer,
    private readonly dshWss: WebSocketServer,
    readonly port: number,
    readonly base: string
  ) {}

  static listen(port = 0, base = ''): Promise<RemoteTestRelay> {
    const http = createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    const wss = new WebSocketServer({ noServer: true })
    const dshWss = new WebSocketServer({ noServer: true })
    http.on('upgrade', (request, socket, head) => {
      const host = request.headers.host ?? '127.0.0.1'
      const pathname = new URL(request.url ?? '/', `http://${host}`).pathname
      if (pathname === `${base}/v1/dsh-tunnel`) {
        dshWss.handleUpgrade(request, socket, head, (ws) => {
          dshWss.emit('connection', ws, request)
        })
        return
      }
      if (pathname !== `${base}/v1/ws`) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request)
      })
    })

    return new Promise((resolve, reject) => {
      http.once('error', reject)
      http.listen(port, '127.0.0.1', () => {
        const address = http.address()
        if (!address || typeof address === 'string') {
          reject(new Error('test relay has no TCP port'))
          return
        }
        const relay = new RemoteTestRelay(http, wss, dshWss, address.port, base)
        wss.on('connection', (ws) => relay.accept(ws))
        dshWss.on('connection', (ws) => relay.acceptDsh(ws))
        resolve(relay)
      })
    })
  }

  get origin(): string {
    return `ws://127.0.0.1:${this.port}`
  }

  joinUrl(roomId: string): string {
    return `${this.origin}${this.base}/${roomId}`
  }

  openRoom(roomId: string): void {
    this.rooms = openRoom(this.rooms, roomId)
  }

  enableDsh(publicOrigin: string, seatToken = 'dsh-seat-token-for-tests'): void {
    this.dshCapability = { publicOrigin, seatToken }
  }

  sendDsh(message: string | Buffer): void {
    if (this.dshSocket?.readyState !== WebSocket.OPEN) {
      throw new Error('DSH tunnel is not open')
    }
    this.dshSocket.send(message)
  }

  close(): Promise<void> {
    for (const socket of this.sockets.values()) {
      socket.terminate()
    }
    this.wss.close()
    this.dshSocket?.terminate()
    this.dshWss.close()
    return new Promise((resolve, reject) => {
      this.http.close((error) => (error ? reject(error) : resolve()))
    })
  }

  private acceptDsh(ws: WebSocket): void {
    if (this.dshSocket?.readyState === WebSocket.OPEN) {
      ws.close(4009, 'occupied')
      return
    }
    this.dshSocket = ws
    ws.on('message', (data, isBinary) => {
      const value = isBinary ? Buffer.from(data as Buffer) : data.toString()
      if (!isBinary && this.dshFrames.length === 0) {
        const hello = parseDshTunnelControl(value as string)
        if (
          !hello.ok ||
          hello.value.type !== 'dsh-tunnel-hello' ||
          hello.value.dshSeatToken !== this.dshCapability?.seatToken
        ) {
          ws.close(4003, 'bad tunnel hello')
          return
        }
      }
      this.dshFrames.push(value)
    })
    ws.once('close', () => {
      if (this.dshSocket === ws) this.dshSocket = null
    })
  }

  private accept(ws: WebSocket): void {
    const connectionId = randomUUID()
    this.sockets.set(connectionId, ws)
    this.meta.set(connectionId, {
      connectionId,
      roomId: null,
      role: null
    })
    ws.on('message', (data) => {
      const text = typeof data === 'string' ? data : data.toString()
      this.onMessage(connectionId, text)
    })
    ws.on('close', () => this.onClose(connectionId))
  }

  private onMessage(connectionId: string, text: string): void {
    const parsed = parseRemoteFrame(text)
    if (!parsed.ok) return
    const message = parsed.value
    const info = this.meta.get(connectionId)
    if (!info) return

    if (message.type === 'hello') {
      this.hellos.push({ role: message.role, roomId: message.roomId })
      const outcome = hello(this.rooms, {
        roomId: message.roomId,
        role: message.role,
        connectionId
      })
      this.rooms = outcome.rooms
      const seated = outcome.replies.some(
        (reply) =>
          reply.connectionId === connectionId &&
          reply.message.type === 'hello-ok'
      )
      if (seated) {
        info.roomId = message.roomId
        info.role = message.role
      }
      this.dispatch(outcome.replies)
      return
    }

    if (message.type === 'revoke') {
      if (info.role !== 'desktop' || info.roomId !== message.roomId) return
      this.revokes.push(message.roomId)
      if (!this.confirmRevokes) return
      const outcome = revoke(this.rooms, message.roomId)
      this.rooms = outcome.rooms
      this.dispatch(outcome.replies)
      for (const reply of outcome.replies) {
        const socket = this.sockets.get(reply.connectionId)
        if (socket?.readyState === WebSocket.OPEN) {
          socket.close(4001, 'revoked')
        }
      }
      return
    }

    if (info.role === 'desktop') {
      if (!isRemoteDesktopToPhoneMessage(message)) return
      this.fromDesktop.push(message)
    } else if (info.role === 'phone') {
      if (!isRemotePhoneToDesktopMessage(message)) return
      this.fromPhone.push(message)
    } else {
      return
    }

    const peerId = this.peerOf(info)
    if (!peerId) return
    this.send(peerId, message)
  }

  private onClose(connectionId: string): void {
    this.sockets.delete(connectionId)
    this.meta.delete(connectionId)
    const outcome = disconnect(this.rooms, connectionId)
    this.rooms = outcome.rooms
    this.dispatch(outcome.replies)
  }

  private peerOf(info: SocketMeta): string | null {
    if (!info.roomId || !info.role) return null
    const room = this.rooms[info.roomId]
    if (!room || room.status !== 'open') return null
    const peerId = info.role === 'desktop' ? room.phone : room.desktop
    return peerId
  }

  private dispatch(
    replies: Array<{ connectionId: string; message: RemoteMessage }>
  ): void {
    for (const reply of replies) {
      this.send(reply.connectionId, reply.message)
    }
  }

  private send(connectionId: string, message: RemoteMessage): void {
    const socket = this.sockets.get(connectionId)
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const info = this.meta.get(connectionId)
    const outbound =
      message.type === 'hello-ok' &&
      info?.role === 'desktop' &&
      this.dshCapability
        ? {
            ...message,
            relayCapabilities: {
              dshWebTunnel: {
                origin: this.dshCapability.publicOrigin,
                protocol: 1 as const
              }
            },
            dshSeatToken: this.dshCapability.seatToken
          }
        : message
    socket.send(JSON.stringify(outbound))
  }
}

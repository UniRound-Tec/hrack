import { randomUUID } from 'node:crypto'
import { chmod, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { BridgeRequest, BridgeWatchEvent } from '../../shared/bridge-protocol'
import { asBridgeError, BridgeError } from './errors'
import type { OpenCodeControlPlane } from './OpenCodeControlPlane'
import {
  bridgeSocketPath,
  readOrCreateBridgeToken,
  tokensEqual
} from './paths'

const MAX_LINE = 256 * 1024

export interface BridgeServerOptions {
  userDataDir: string
  plane: OpenCodeControlPlane
  socketPath?: string
}

function writeJson(socket: Socket, value: unknown): void {
  if (socket.destroyed) return
  socket.write(`${JSON.stringify(value)}\n`)
}

export class BridgeServer {
  private server: Server | null = null
  private token = ''
  private readonly sockets = new Set<Socket>()
  readonly socketPath: string

  constructor(private readonly options: BridgeServerOptions) {
    this.socketPath = options.socketPath ?? bridgeSocketPath()
  }

  async start(): Promise<string> {
    this.token = await readOrCreateBridgeToken(this.options.userDataDir)
    if (process.platform !== 'win32') {
      mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 })
      await unlink(this.socketPath).catch(() => {})
    }
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.accept(socket))
      server.once('error', reject)
      server.listen(this.socketPath, () => {
        server.off('error', reject)
        resolve()
      })
      this.server = server
    })
    if (process.platform !== 'win32') {
      await chmod(this.socketPath, 0o600).catch(() => {})
    }
    return this.socketPath
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (process.platform !== 'win32') {
      await unlink(this.socketPath).catch(() => {})
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    let buffer = ''
    const cancelWatch = new Map<string, () => void>()
    const cleanup = (): void => {
      for (const cancel of cancelWatch.values()) cancel()
      cancelWatch.clear()
      this.sockets.delete(socket)
    }
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_LINE * 4) {
        socket.destroy()
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) void this.handleLine(socket, line, cancelWatch)
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('close', cleanup)
    socket.on('error', cleanup)
  }

  private async handleLine(
    socket: Socket,
    line: string,
    cancelWatch: Map<string, () => void>
  ): Promise<void> {
    let request: BridgeRequest
    try {
      request = JSON.parse(line) as BridgeRequest
    } catch {
      writeJson(socket, {
        kind: 'result',
        id: 'unknown',
        ok: false,
        error: { code: 'invalid', message: 'Invalid JSON' }
      })
      return
    }
    const id = typeof request.id === 'string' && request.id ? request.id : randomUUID()
    if (typeof request.token !== 'string' || !tokensEqual(request.token, this.token)) {
      writeJson(socket, {
        kind: 'result',
        id,
        ok: false,
        error: BridgeError.unauthorized('Invalid bridge token').toBody()
      })
      socket.end()
      return
    }
    if (typeof request.method !== 'string') {
      writeJson(socket, {
        kind: 'result',
        id,
        ok: false,
        error: BridgeError.invalid('method is required').toBody()
      })
      return
    }
    try {
      const handled = await this.options.plane.handle(request.method, request.params)
      if (handled.kind === 'json') {
        writeJson(socket, { kind: 'result', id, ok: true, result: handled.value })
        return
      }
      writeJson(socket, { kind: 'result', id, ok: true, result: { watching: handled.sessionId } })
      const cancel = this.options.plane.watch(
        handled.sessionId,
        (event: BridgeWatchEvent) => {
          writeJson(socket, { kind: 'event', id, event })
          if (event.type === 'exited') socket.end()
        },
        () => {
          if (!socket.destroyed) socket.end()
        }
      )
      cancelWatch.set(id, cancel)
    } catch (error) {
      const bridged = asBridgeError(error)
      writeJson(socket, {
        kind: 'result',
        id,
        ok: false,
        error: bridged.toBody()
      })
    }
  }
}

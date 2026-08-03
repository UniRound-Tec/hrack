import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process'
import http, { type IncomingMessage } from 'node:http'
import type { Readable } from 'node:stream'
import type { OpenCodeSnapshot } from './types'
import { parseOpenCodeSnapshot } from './OpenCodeEventParser'
import { OpenCodeSseError, OpenCodeSseParser } from './OpenCodeSseParser'

const MAX_BODY = 1024 * 1024
const REQUEST_TIMEOUT_MS = 3_000
const SSE_FIRST_BYTE_TIMEOUT_MS = 3_000

export class OpenCodeTransportError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'OpenCodeTransportError'
  }
}

export interface OpenCodeConnection {
  dispose(): Promise<void>
}

export interface OpenCodeTransport {
  readonly kind: 'host-direct' | 'wsl-stdio'
  health(): Promise<{ version: string }>
  snapshot(): Promise<OpenCodeSnapshot>
  connect(
    onEvent: (value: unknown) => void,
    onDisconnect: (reason: string) => void
  ): Promise<OpenCodeConnection>
  dispose(): Promise<void>
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    throw new OpenCodeTransportError(
      'invalid-json',
      'OpenCode returned invalid JSON'
    )
  }
}

function healthOf(value: unknown): { version: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const data =
    raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)
      ? (raw.data as Record<string, unknown>)
      : raw
  if (data.healthy !== true || typeof data.version !== 'string') return null
  return { version: data.version.slice(0, 64) }
}

function collectResponse(
  response: IncomingMessage,
  resolve: (value: string) => void,
  reject: (reason: Error) => void
): void {
  if (response.statusCode === 401 || response.statusCode === 403) {
    response.resume()
    reject(
      new OpenCodeTransportError(
        'auth-required',
        'OpenCode server requires authentication'
      )
    )
    return
  }
  if (
    !response.statusCode ||
    response.statusCode < 200 ||
    response.statusCode >= 300
  ) {
    response.resume()
    reject(
      new OpenCodeTransportError(
        'http-status',
        `OpenCode HTTP ${response.statusCode ?? 0}`
      )
    )
    return
  }
  const chunks: Buffer[] = []
  let bytes = 0
  response.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY) {
      response.destroy(
        new OpenCodeTransportError(
          'body-too-large',
          'OpenCode response exceeds limit'
        )
      )
      return
    }
    chunks.push(buffer)
  })
  response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  response.once('error', reject)
}

function httpText(endpoint: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get(`${endpoint}${path}`, {
      headers: { Accept: 'application/json', Connection: 'close' }
    })
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(
        new OpenCodeTransportError('timeout', `OpenCode ${path} timed out`)
      )
    })
    request.once('response', (response) =>
      collectResponse(response, resolve, reject)
    )
    request.once('error', reject)
  })
}

export class HostOpenCodeTransport implements OpenCodeTransport {
  readonly kind = 'host-direct' as const
  private readonly connections = new Set<OpenCodeConnection>()

  constructor(private readonly endpoint: string) {}

  async health(): Promise<{ version: string }> {
    const health = healthOf(
      parseJsonBody(await httpText(this.endpoint, '/global/health'))
    )
    if (!health)
      throw new OpenCodeTransportError(
        'identity',
        'Unexpected OpenCode health payload'
      )
    return health
  }

  async snapshot(): Promise<OpenCodeSnapshot> {
    const [sessions, statuses] = await Promise.all([
      httpText(this.endpoint, '/session').then(parseJsonBody),
      httpText(this.endpoint, '/session/status').then(parseJsonBody)
    ])
    const snapshot = parseOpenCodeSnapshot(sessions, statuses)
    if (!snapshot)
      throw new OpenCodeTransportError(
        'snapshot',
        'Invalid OpenCode session snapshot'
      )
    return snapshot
  }

  connect(
    onEvent: (value: unknown) => void,
    onDisconnect: (reason: string) => void
  ): Promise<OpenCodeConnection> {
    const controller = new AbortController()
    const parser = new OpenCodeSseParser(onEvent)
    let disposed = false
    let disconnected = false
    const notifyDisconnect = (reason: string): void => {
      if (disposed || disconnected) return
      disconnected = true
      onDisconnect(reason)
    }
    const handshakeTimer = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    )

    return fetch(`${this.endpoint}/global/event`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal
    }).then(
      (response) => {
        clearTimeout(handshakeTimer)
        if (response.status === 401 || response.status === 403) {
          controller.abort()
          throw new OpenCodeTransportError(
            'auth-required',
            'OpenCode server requires authentication'
          )
        }
        if (!response.ok || !response.body) {
          controller.abort()
          throw new OpenCodeTransportError(
            'http-status',
            `OpenCode SSE HTTP ${response.status}`
          )
        }

        const reader = response.body.getReader()
        const connection: OpenCodeConnection = {
          dispose: async () => {
            if (disposed) return
            disposed = true
            this.connections.delete(connection)
            controller.abort()
            await reader.cancel().catch(() => {})
            parser.reset()
          }
        }
        this.connections.add(connection)
        void (async () => {
          try {
            while (!disposed) {
              const { done, value } = await reader.read()
              if (done) {
                notifyDisconnect('OpenCode SSE ended')
                return
              }
              if (value) parser.push(value)
            }
          } catch (error) {
            notifyDisconnect(
              error instanceof Error ? error.message : String(error)
            )
          }
        })()
        return connection
      },
      (error) => {
        clearTimeout(handshakeTimer)
        if (controller.signal.aborted) {
          throw new OpenCodeTransportError(
            'timeout',
            'OpenCode SSE handshake timed out'
          )
        }
        throw error
      }
    )
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.connections].map((connection) => connection.dispose())
    )
    this.connections.clear()
  }
}

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

export function runWslCommand(
  distro: string,
  executable: string,
  args: readonly string[],
  timeout = REQUEST_TIMEOUT_MS
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['--distribution', distro, '--exec', executable, ...args],
      {
        encoding: 'utf8',
        timeout,
        maxBuffer: MAX_BODY,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const failure = error as
          (NodeJS.ErrnoException & { code?: string | number }) | null
        resolve({
          code:
            typeof failure?.code === 'number' ? failure.code : error ? null : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '').slice(-8192)
        })
      }
    )
  })
}

function curlArgs(endpoint: string, path: string): string[] {
  return [
    '--silent',
    '--show-error',
    '--fail',
    '--max-time',
    '3',
    '--header',
    'Accept: application/json',
    `${endpoint}${path}`
  ]
}

export class WslOpenCodeTransport implements OpenCodeTransport {
  readonly kind = 'wsl-stdio' as const
  private readonly children = new Set<
    ChildProcessByStdio<null, Readable, Readable>
  >()

  constructor(
    private readonly distro: string,
    private readonly curlPath: string,
    private readonly endpoint: string
  ) {}

  private async text(path: string): Promise<string> {
    const result = await runWslCommand(
      this.distro,
      this.curlPath,
      curlArgs(this.endpoint, path)
    )
    if (result.code !== 0) {
      throw new OpenCodeTransportError(
        'curl-failed',
        result.stderr || `WSL curl failed for ${path}`
      )
    }
    if (Buffer.byteLength(result.stdout, 'utf8') > MAX_BODY) {
      throw new OpenCodeTransportError(
        'body-too-large',
        'OpenCode response exceeds limit'
      )
    }
    return result.stdout
  }

  async health(): Promise<{ version: string }> {
    const health = healthOf(parseJsonBody(await this.text('/global/health')))
    if (!health)
      throw new OpenCodeTransportError(
        'identity',
        'Unexpected OpenCode health payload'
      )
    return health
  }

  async snapshot(): Promise<OpenCodeSnapshot> {
    const [sessions, statuses] = await Promise.all([
      this.text('/session').then(parseJsonBody),
      this.text('/session/status').then(parseJsonBody)
    ])
    const snapshot = parseOpenCodeSnapshot(sessions, statuses)
    if (!snapshot)
      throw new OpenCodeTransportError(
        'snapshot',
        'Invalid OpenCode session snapshot'
      )
    return snapshot
  }

  connect(
    onEvent: (value: unknown) => void,
    onDisconnect: (reason: string) => void
  ): Promise<OpenCodeConnection> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'wsl.exe',
        [
          '--distribution',
          this.distro,
          '--exec',
          this.curlPath,
          '--no-buffer',
          '--silent',
          '--show-error',
          '--fail',
          '--header',
          'Accept: text/event-stream',
          `${this.endpoint}/global/event`
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      this.children.add(child)
      let disposed = false
      let ready = false
      let disconnected = false
      let stderr = ''
      const parser = new OpenCodeSseParser(onEvent)
      const notifyDisconnect = (reason: string): void => {
        if (disposed || disconnected) return
        disconnected = true
        onDisconnect(reason)
      }
      const timer = setTimeout(() => {
        if (ready || disposed) return
        disposed = true
        child.kill()
        this.children.delete(child)
        reject(
          new OpenCodeTransportError(
            'timeout',
            'WSL OpenCode SSE first byte timed out'
          )
        )
      }, SSE_FIRST_BYTE_TIMEOUT_MS)
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-8192)
      })
      child.stdout.on('data', (chunk: Buffer) => {
        if (disposed) return
        try {
          parser.push(chunk)
          if (!ready) {
            ready = true
            clearTimeout(timer)
            resolve(connection)
          }
        } catch (error) {
          const reason =
            error instanceof OpenCodeSseError ? error.message : String(error)
          child.kill()
          if (!ready) reject(new OpenCodeTransportError('sse-invalid', reason))
          else notifyDisconnect(reason)
        }
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        this.children.delete(child)
        if (!ready) reject(error)
        else notifyDisconnect(error.message)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        this.children.delete(child)
        if (disposed) return
        const reason =
          stderr || `WSL OpenCode SSE helper exited (${code ?? 'unknown'})`
        if (!ready) reject(new OpenCodeTransportError('helper-exited', reason))
        else notifyDisconnect(reason)
      })
      const connection: OpenCodeConnection = {
        dispose: async () => {
          if (disposed) return
          disposed = true
          clearTimeout(timer)
          parser.reset()
          this.children.delete(child)
          child.kill()
        }
      }
    })
  }

  async dispose(): Promise<void> {
    for (const child of this.children) child.kill()
    this.children.clear()
  }
}

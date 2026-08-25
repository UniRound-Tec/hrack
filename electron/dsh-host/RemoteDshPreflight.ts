import { request, type IncomingHttpHeaders } from 'node:http'
import WebSocket from 'ws'

const REQUEST_TIMEOUT_MS = 5_000
const MAX_PREFLIGHT_BODY = 16 * 1024 * 1024

interface LocalResponse {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

export interface RemoteDshPreflightEvidence {
  manifestEntries: number
  eventSockets: number
  privilegedDenied: number
}

function localRequest(
  baseUrl: string,
  publicOrigin: string,
  input: { method?: 'GET' | 'POST'; path: string; body?: string }
): Promise<LocalResponse> {
  const target = new URL(baseUrl)
  const authority = new URL(publicOrigin).host
  const body = input.body ?? ''
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: target.hostname,
      port: target.port,
      method: input.method ?? 'GET',
      path: input.path,
      headers: {
        host: authority,
        origin: publicOrigin,
        ...(body
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body)
            }
          : {})
      }
    }, (response) => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > MAX_PREFLIGHT_BODY) {
          req.destroy(new Error('DSH preflight response exceeded its limit'))
          return
        }
        chunks.push(chunk)
      })
      response.once('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks)
        })
      })
    })
    req.once('error', reject)
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`DSH preflight timeout: ${input.path}`))
    })
    if (body) req.write(body)
    req.end()
  })
}

function rpcBody(method: string, args: unknown = {}): string {
  return JSON.stringify({
    type: 'client-request',
    rpcId: crypto.randomUUID(),
    method,
    payload: { args }
  })
}

export function parseDshBootManifestEntries(
  html: string
): Array<{ id: string; url: string }> {
  // DSH 0.1.0 used `window.__DSH_BOOT__`, while 0.1.1 switched to the
  // equivalent `globalThis["__DSH_BOOT__"]`. The JavaScript spelling is not
  // a product capability; validate the manifest payload below instead.
  const assignment = /(?:window|globalThis)(?:\.__DSH_BOOT__|\[\s*["']__DSH_BOOT__["']\s*\])\s*=\s*/.exec(
    html
  )
  const start = assignment ? assignment.index + assignment[0].length : -1
  const end = start < 0 ? -1 : html.indexOf('</script>', start)
  if (start < 0 || end < 0) {
    throw new Error('DSH boot manifest is missing')
  }
  const parsed = JSON.parse(html.slice(start, end)) as {
    entries?: unknown
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error('DSH boot manifest entries are invalid')
  }
  const entries: Array<{ id: string; url: string }> = []
  for (const value of parsed.entries) {
    if (!value || typeof value !== 'object') {
      throw new Error('DSH boot manifest entry is invalid')
    }
    const entry = value as Record<string, unknown>
    if (typeof entry.id !== 'string' || typeof entry.url !== 'string') {
      throw new Error('DSH boot manifest entry is invalid')
    }
    entries.push({ id: entry.id, url: entry.url })
  }
  return entries
}

function assertRpcSuccess(method: string, response: LocalResponse): void {
  if (response.status !== 200) {
    throw new Error(`${method} HTTP ${response.status}`)
  }
  const envelope = JSON.parse(response.body.toString('utf8')) as {
    result?: { ok?: boolean; error?: { message?: string } }
  }
  if (envelope.result?.ok !== true) {
    throw new Error(envelope.result?.error?.message ?? `${method} failed`)
  }
}

function probeSse(baseUrl: string, publicOrigin: string): Promise<void> {
  const target = new URL(baseUrl)
  const authority = new URL(publicOrigin).host
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: target.hostname,
      port: target.port,
      method: 'GET',
      path: '/plugins/events',
      headers: { host: authority, origin: publicOrigin, accept: 'text/event-stream' }
    })
    const timer = setTimeout(() => {
      req.destroy(new Error('DSH plugin event stream did not open'))
    }, REQUEST_TIMEOUT_MS)
    req.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    req.once('response', (response) => {
      clearTimeout(timer)
      const status = response.statusCode ?? 0
      response.destroy()
      req.destroy()
      if (status !== 200) {
        reject(new Error(`DSH plugin event stream HTTP ${status}`))
        return
      }
      resolve()
    })
    req.end()
  })
}

function probeWebSocket(
  baseUrl: string,
  publicOrigin: string,
  path: string
): Promise<void> {
  const local = new URL(baseUrl)
  const url = `ws://${local.host}${path}`
  const authority = new URL(publicOrigin).host
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      origin: publicOrigin,
      headers: { host: authority },
      handshakeTimeout: REQUEST_TIMEOUT_MS
    })
    socket.once('open', () => {
      socket.close(1000, 'preflight-complete')
      resolve()
    })
    socket.once('error', reject)
  })
}

/** Product-ready probe: public authority works while the DSH host fence remains closed. */
export async function preflightRemoteDsh(
  baseUrl: string,
  publicOrigin: string
): Promise<RemoteDshPreflightEvidence> {
  const root = await localRequest(baseUrl, publicOrigin, { path: '/' })
  if (root.status !== 200) throw new Error(`DSH root HTTP ${root.status}`)
  const entries = parseDshBootManifestEntries(root.body.toString('utf8'))
  const browseId = '@deepseek-ai/dsh-client-ui-directory-picker-browse'
  if (entries.filter((entry) => entry.id === browseId).length !== 1) {
    throw new Error('DSH browse directory picker client is not unique')
  }
  if (entries.some((entry) => /directory-picker-(?:native|auto)/.test(entry.id))) {
    throw new Error('DSH native/auto directory picker remains enabled')
  }
  const browse = entries.find((entry) => entry.id === browseId)!
  const browseAsset = await localRequest(baseUrl, publicOrigin, {
    path: browse.url
  })
  if (browseAsset.status !== 200 || browseAsset.body.byteLength === 0) {
    throw new Error('DSH browse directory picker client cannot be loaded')
  }

  for (const method of [
    'host.describe',
    'session.list',
    'workspace.list',
    'host.listDirectory'
  ]) {
    const response = await localRequest(baseUrl, publicOrigin, {
      method: 'POST',
      path: `/api/${method}`,
      body: rpcBody(method)
    })
    assertRpcSuccess(method, response)
  }

  let privilegedDenied = 0
  for (const method of [
    'host.pickDirectory',
    'host.openPath',
    'settings.describe',
    'credentials.describe'
  ]) {
    const response = await localRequest(baseUrl, publicOrigin, {
      method: 'POST',
      path: `/api/${method}`,
      body: rpcBody(method)
    })
    if (response.status !== 403 || response.body.toString('utf8') !== 'forbidden') {
      throw new Error(`${method} escaped the DSH public-authority fence`)
    }
    privilegedDenied += 1
  }

  await probeSse(baseUrl, publicOrigin)
  await Promise.all([
    probeWebSocket(baseUrl, publicOrigin, '/api/events.host'),
    probeWebSocket(baseUrl, publicOrigin, '/api/events.mux')
  ])
  return {
    manifestEntries: entries.length,
    eventSockets: 2,
    privilegedDenied
  }
}

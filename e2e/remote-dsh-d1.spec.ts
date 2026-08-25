import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  encodeDshTunnelBinary,
  encodeDshTunnelControl,
  parseDshTunnelBinary,
  parseDshTunnelControl,
  type DshTunnelControl,
  type DshTunnelHeaders
} from '../shared/dsh-tunnel-protocol'
import { parseDshBootManifestEntries } from '../electron/dsh-host/RemoteDshPreflight'
import { launchApp } from './helpers'
import { RemoteTestRelay } from './helpers/remoteTestRelay'

const PUBLIC_ORIGIN = 'https://dsh.remote.test'

interface TunnelResponse {
  status: number
  headers: DshTunnelHeaders
  body: Buffer
}

async function tunnelRequest(
  relay: RemoteTestRelay,
  streamId: number,
  input: { method?: 'GET' | 'HEAD' | 'POST'; path: string; body?: string }
): Promise<TunnelResponse> {
  const method = input.method ?? 'GET'
  const body = Buffer.from(input.body ?? '')
  const start = relay.dshFrames.length
  relay.sendDsh(encodeDshTunnelControl({
    type: 'http-open',
    streamId,
    method,
    path: input.path,
    headers: [
      ['accept', '*/*'],
      ['origin', PUBLIC_ORIGIN],
      ...(body.byteLength ? [['content-type', 'application/json'] as [string, string]] : [])
    ],
    bodyLength: body.byteLength
  }))
  if (body.byteLength) {
    relay.sendDsh(Buffer.from(encodeDshTunnelBinary({
      kind: 1,
      streamId,
      sequence: 0,
      payload: body
    })))
  }
  relay.sendDsh(encodeDshTunnelControl({ type: 'http-end', streamId }))

  const chunks: Buffer[] = []
  let status = 0
  let headers: DshTunnelHeaders = []
  let index = start
  let sequence = 0
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    while (index < relay.dshFrames.length) {
      const frame = relay.dshFrames[index++]!
      if (Buffer.isBuffer(frame)) {
        const parsed = parseDshTunnelBinary(frame)
        if (!parsed.ok || parsed.value.streamId !== streamId) continue
        expect(parsed.value.kind).toBe(1)
        expect(parsed.value.sequence).toBe(sequence++)
        const chunk = Buffer.from(parsed.value.payload)
        chunks.push(chunk)
        relay.sendDsh(encodeDshTunnelControl({
          type: 'credit',
          streamId,
          bytes: chunk.byteLength
        }))
        continue
      }
      const parsed = parseDshTunnelControl(frame)
      if (!parsed.ok || !('streamId' in parsed.value) || parsed.value.streamId !== streamId) continue
      if (parsed.value.type === 'http-head') {
        status = parsed.value.status
        headers = parsed.value.headers
      } else if (parsed.value.type === 'http-end') {
        return { status, headers, body: Buffer.concat(chunks) }
      } else if (parsed.value.type === 'http-abort') {
        throw new Error(`desktop aborted stream: ${parsed.value.reason}`)
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  throw new Error(`DSH tunnel request timed out: ${method} ${input.path}`)
}

function rpcBody(method: string, args: unknown = {}): string {
  return JSON.stringify({
    type: 'client-request',
    rpcId: crypto.randomUUID(),
    method,
    payload: { args }
  })
}

async function waitForControl(
  relay: RemoteTestRelay,
  start: number,
  predicate: (message: DshTunnelControl) => boolean
): Promise<void> {
  const deadline = Date.now() + 20_000
  let index = start
  while (Date.now() < deadline) {
    while (index < relay.dshFrames.length) {
      const frame = relay.dshFrames[index++]!
      if (typeof frame !== 'string') continue
      const parsed = parseDshTunnelControl(frame)
      if (parsed.ok && predicate(parsed.value)) return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  throw new Error('timed out waiting for DSH tunnel control')
}

test('D1 Desktop carries real DSH HTTP through a fixed public-authority tunnel', async () => {
  const executable = process.env['HRACK_E2E_REAL_DSH']
  test.skip(!executable, 'Set HRACK_E2E_REAL_DSH to a real installed dsh executable')
  test.setTimeout(240_000)

  const relay = await RemoteTestRelay.listen()
  const roomId = 'dsh-d1-real-room'
  relay.openRoom(roomId)
  relay.enableDsh(PUBLIC_ORIGIN)
  const appState = await launchApp({
    createDefaultTerminal: false,
    localDsh: true,
    env: { HRACK_E2E_DSH_INSTALLATION: executable! }
  })
  try {
    await appState.window.evaluate(async ({ joinUrl }) => {
      await window.remoteApi.setDshEnabled(true)
      await window.remoteApi.connect(joinUrl)
    }, { joinUrl: relay.joinUrl(roomId) })

    await expect.poll(() => appState.window.evaluate(() =>
      window.dshApi.getStatus().then((status) => status.state)
    ), {
      timeout: 90_000,
      intervals: [500, 1_000, 2_000]
    }).toMatch(/ready|failed/)
    const hostStatus = await appState.window.evaluate(() => window.dshApi.getStatus())
    if (hostStatus.state !== 'ready') {
      throw new Error(`real DSH product preflight failed: ${hostStatus.error ?? 'unknown'}`)
    }
    await expect.poll(() => appState.window.evaluate(() =>
      window.remoteApi.getDshState()
    ), {
      timeout: 30_000,
      intervals: [250, 500, 1_000]
    }).toMatchObject({
      enabled: true,
      relaySupported: true,
      surface: { state: 'ready', generation: expect.any(Number) }
    })
    await expect.poll(() => relay.dshFrames.length, { timeout: 30_000 }).toBeGreaterThan(0)
    const hello = parseDshTunnelControl(relay.dshFrames[0] as string)
    expect(hello).toMatchObject({
      ok: true,
      value: { type: 'dsh-tunnel-hello', roomId, protocol: 1 }
    })

    const root = await tunnelRequest(relay, 1, { path: '/' })
    expect(root.status).toBe(200)
    const html = root.body.toString('utf8')
    const entries = parseDshBootManifestEntries(html)
    expect(entries.some((entry) =>
      entry.id === '@deepseek-ai/dsh-client-ui-directory-picker-browse'
    )).toBe(true)
    expect(entries.some((entry) => entry.id.includes('directory-picker-native'))).toBe(false)

    const htmlAssets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1]!)
      .filter((path) => path.startsWith('/assets/'))
    const resources = [...new Set([...entries.map((entry) => entry.url), ...htmlAssets])]
    let resourceBytes = 0
    let streamId = 2
    for (const path of resources) {
      const response = await tunnelRequest(relay, streamId++, { path })
      expect(response.status, path).toBe(200)
      resourceBytes += response.body.byteLength
    }
    expect(resourceBytes).toBeGreaterThan(1_000_000)

    const sseId = streamId++
    let controlStart = relay.dshFrames.length
    relay.sendDsh(encodeDshTunnelControl({
      type: 'http-open',
      streamId: sseId,
      method: 'GET',
      path: '/plugins/events',
      headers: [['accept', 'text/event-stream'], ['origin', PUBLIC_ORIGIN]],
      bodyLength: 0
    }))
    relay.sendDsh(encodeDshTunnelControl({ type: 'http-end', streamId: sseId }))
    await waitForControl(relay, controlStart, (message) =>
      message.type === 'http-head' && message.streamId === sseId && message.status === 200
    )
    relay.sendDsh(encodeDshTunnelControl({
      type: 'http-abort', streamId: sseId, reason: 'test-complete'
    }))

    for (const path of ['/api/events.host', '/api/events.mux']) {
      const wsId = streamId++
      controlStart = relay.dshFrames.length
      relay.sendDsh(encodeDshTunnelControl({
        type: 'ws-open',
        streamId: wsId,
        path,
        headers: [['origin', PUBLIC_ORIGIN]]
      }))
      await waitForControl(relay, controlStart, (message) =>
        message.type === 'ws-open-ok' && message.streamId === wsId
      )
      relay.sendDsh(encodeDshTunnelControl({
        type: 'ws-close', streamId: wsId, code: 1000, reason: 'test-complete'
      }))
    }

    for (const method of [
      'host.describe',
      'session.list',
      'workspace.list',
      'host.listDirectory'
    ]) {
      const response = await tunnelRequest(relay, streamId++, {
        method: 'POST',
        path: `/api/${method}`,
        body: rpcBody(method)
      })
      expect(response.status, method).toBe(200)
      expect(JSON.parse(response.body.toString('utf8')), method).toMatchObject({
        type: 'server-response',
        result: { ok: true }
      })
    }

    for (const method of [
      'host.pickDirectory',
      'host.openPath',
      'settings.describe',
      'credentials.describe'
    ]) {
      const response = await tunnelRequest(relay, streamId++, {
        method: 'POST',
        path: `/api/${method}`,
        body: rpcBody(method)
      })
      expect(response.status, method).toBe(403)
      expect(response.body.toString('utf8')).toBe('forbidden')
    }

    const workspace = resolve(appState.userDataDir, 'd1-real-workspace')
    mkdirSync(workspace, { recursive: true })
    const created = await tunnelRequest(relay, streamId++, {
      method: 'POST',
      path: '/api/session.create',
      body: rpcBody('session.create', { cwd: workspace })
    })
    expect(created.status).toBe(200)
    expect(JSON.parse(created.body.toString('utf8'))).toMatchObject({
      type: 'server-response',
      result: { ok: true, value: { sessionId: expect.any(String) } }
    })

    const overlay = resolve(appState.userDataDir, 'dsh-runtime/remote-web.patch.yml')
    expect(existsSync(overlay)).toBe(true)
    expect(readFileSync(overlay, 'utf8')).toContain('directory-picker-browse-surface')
    expect(existsSync(resolve(appState.userDataDir, 'dsh-home/remote-web.patch.yml'))).toBe(false)
    const persisted = JSON.parse(
      readFileSync(resolve(appState.userDataDir, 'main-prefs.json'), 'utf8')
    ) as { remoteDshEnabled?: boolean }
    expect(persisted.remoteDshEnabled).toBe(true)

    console.log(
      `[dsh-d1] runtime=real resources=${resources.length} bytes=${resourceBytes} ` +
      `privileged=denied session=blank tunnel=fixed`
    )
  } finally {
    await appState.app.close()
    await relay.close()
  }
})

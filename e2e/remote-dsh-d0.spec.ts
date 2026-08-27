import { chromium, expect, test } from '@playwright/test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, resolve } from 'node:path'

const PUBLIC_AUTHORITY = 'dsh.remote.test'
const PUBLIC_ORIGIN = `http://${PUBLIC_AUTHORITY}`
const OUTPUT_TAIL_LIMIT = 32 * 1024

interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

function allocatePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('failed to allocate DSH prototype port'))
        return
      }
      server.close(() => resolvePort(address.port))
    })
  })
}

function requestLocal(
  port: number,
  input: {
    method?: 'GET' | 'HEAD' | 'POST'
    path: string
    body?: string
    origin?: string
  }
): Promise<HttpResult> {
  return new Promise((resolveResponse, reject) => {
    const body = input.body ?? ''
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method: input.method ?? 'GET',
      path: input.path,
      headers: {
        host: `${PUBLIC_AUTHORITY}:${port}`,
        ...(input.origin ? { origin: input.origin } : {}),
        ...(body
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body)
            }
          : {})
      }
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('end', () => {
        resolveResponse({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks)
        })
      })
    })
    request.once('error', reject)
    request.setTimeout(10_000, () => {
      request.destroy(new Error(`DSH request timeout: ${input.path}`))
    })
    if (body) request.write(body)
    request.end()
  })
}

async function waitForReady(port: number, child: ChildProcess): Promise<string> {
  const deadline = Date.now() + 120_000
  let last = 'DSH has not answered yet'
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`DSH exited before ready (code ${child.exitCode}): ${last}`)
    }
    try {
      const response = await requestLocal(port, { path: '/' })
      if (response.status === 200) return response.body.toString('utf8')
      last = `root responded ${response.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`real DSH did not become ready: ${last}`)
}

function stopProcessTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore'
    })
    return
  }
  child.kill('SIGTERM')
}

function quoteCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function rpcBody(method: string, sequence: number, args: unknown = {}): string {
  const suffix = String(sequence).padStart(12, '0')
  return JSON.stringify({
    type: 'client-request',
    rpcId: `00000000-0000-4000-8000-${suffix}`,
    method,
    payload: { args }
  })
}

function bootManifest(html: string): {
  entries: Array<{ id: string; url: string }>
} {
  const marker = 'window.__DSH_BOOT__ = '
  const start = html.indexOf(marker)
  const end = start === -1 ? -1 : html.indexOf('</script>', start)
  if (start === -1 || end === -1) {
    throw new Error('real DSH page carries no complete __DSH_BOOT__ manifest')
  }
  return JSON.parse(html.slice(start + marker.length, end)) as {
    entries: Array<{ id: string; url: string }>
  }
}

test('D0 real DSH supports a trusted public browser without loopback privilege', async ({
  browserName
}) => {
  test.skip(browserName !== 'chromium', 'host resolver prototype uses Chromium')
  const executable = process.env['HRACK_E2E_REAL_DSH']
  test.skip(!executable, 'Set HRACK_E2E_REAL_DSH to a real installed dsh executable')
  test.setTimeout(180_000)

  const port = await allocatePort()
  const dshHome = mkdtempSync(resolve(tmpdir(), 'hrack-dsh-d0-home-'))
  const overlay = resolve(__dirname, 'fixtures/dsh-remote-browse.patch.yml')
  const args = [
    '--profile', 'web',
    '--patch', overlay,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--trusted-host', PUBLIC_AUTHORITY,
    '--no-open'
  ]
  const useShell = process.platform === 'win32' &&
    ['.cmd', '.bat'].includes(extname(executable!).toLowerCase())
  const child = useShell
    ? spawn(
        process.env['ComSpec'] ?? 'cmd.exe',
        [
          '/d',
          '/v:off',
          '/c',
          `call ${[executable!, ...args].map(quoteCmdArg).join(' ')}`
        ],
        {
          env: {
            ...process.env,
            DSH_HOME: dshHome,
            DSH_TELEMETRY_DISABLED: '1',
            SSH_CONNECTION: 'hrack-embed'
          },
          windowsVerbatimArguments: true,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
    : spawn(executable!, args, {
        env: {
          ...process.env,
          DSH_HOME: dshHome,
          DSH_TELEMETRY_DISABLED: '1',
          SSH_CONNECTION: 'hrack-embed'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
  let outputTail = ''
  const appendOutput = (chunk: Buffer): void => {
    outputTail = (outputTail + chunk.toString()).slice(-OUTPUT_TAIL_LIMIT)
  }
  child.stdout?.on('data', appendOutput)
  child.stderr?.on('data', appendOutput)

  const browser = await chromium.launch({
    headless: true,
    args: [
      `--host-resolver-rules=MAP ${PUBLIC_AUTHORITY} 127.0.0.1`,
      '--no-proxy-server'
    ]
  })
  try {
    const html = await waitForReady(port, child).catch((error) => {
      throw new Error(`${String(error)}\n${outputTail}`)
    })
    const manifest = bootManifest(html)
    expect(manifest.entries.length).toBeGreaterThan(20)
    expect(manifest.entries.some((entry) =>
      entry.id === '@deepseek-ai/dsh-client-ui-directory-picker-browse'
    )).toBe(true)
    expect(manifest.entries.some((entry) =>
      entry.id === '@deepseek-ai/dsh-client-ui-directory-picker-native'
    )).toBe(false)

    const htmlAssets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((path) => path.startsWith('/assets/'))
    const resources = [
      ...new Set([
        ...manifest.entries.map((entry) => entry.url),
        ...htmlAssets
      ])
    ]
    let resourceBytes = 0
    for (const path of resources) {
      const response = await requestLocal(port, { path })
      expect(response.status, path).toBe(200)
      resourceBytes += response.body.byteLength
    }
    expect(resourceBytes).toBeGreaterThan(1_000_000)

    const page = await browser.newPage({ viewport: { width: 412, height: 915 } })
    const requests = new Set<string>()
    const webSockets = new Set<string>()
    const statuses = new Map<string, number>()
    const pageErrors: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.hostname === PUBLIC_AUTHORITY) {
        requests.add(`${request.method()} ${url.pathname}`)
      }
    })
    page.on('response', (response) => {
      const url = new URL(response.url())
      if (url.hostname === PUBLIC_AUTHORITY) {
        statuses.set(`${response.request().method()} ${url.pathname}`, response.status())
      }
    })
    page.on('websocket', (socket) => {
      const url = new URL(socket.url())
      if (url.hostname === PUBLIC_AUTHORITY) webSockets.add(url.pathname)
    })
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await page.goto(`${PUBLIC_ORIGIN}:${port}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    })
    await expect.poll(() => page.title(), { timeout: 30_000 }).toBe(
      'DeepSeek Harness'
    )
    await expect.poll(() => page.locator('body').innerText().then((text) => text.length), {
      timeout: 30_000
    }).toBeGreaterThan(20)
    await expect.poll(() => webSockets.size, { timeout: 30_000 }).toBe(2)
    await expect.poll(() => statuses.get('GET /plugins/events'), {
      timeout: 30_000
    }).toBe(200)

    expect(webSockets).toEqual(new Set([
      '/api/events.host',
      '/api/events.mux'
    ]))
    expect(requests).toContain(
      'GET /plugins/@deepseek-ai/dsh-client-ui-directory-picker-browse/client.js'
    )
    expect([...requests].some((request) => request.includes(
      'dsh-client-ui-directory-picker-native'
    ))).toBe(false)
    for (const privilegedRequest of [
      'POST /api/settings.describe',
      'POST /api/credentials.describe'
    ]) {
      if (statuses.has(privilegedRequest)) {
        expect(statuses.get(privilegedRequest), privilegedRequest).toBe(403)
      }
    }
    expect(pageErrors).toEqual([])

    for (const [sequence, method] of [
      'host.describe',
      'session.list',
      'workspace.list'
    ].entries()) {
      const ordinary = await requestLocal(port, {
        method: 'POST',
        path: `/api/${method}`,
        origin: `${PUBLIC_ORIGIN}:${port}`,
        body: rpcBody(method, sequence + 1)
      })
      expect(ordinary.status, method).toBe(200)
      expect(JSON.parse(ordinary.body.toString('utf8')), method).toMatchObject({
        type: 'server-response',
        result: { ok: true }
      })
    }

    const directory = await requestLocal(port, {
      method: 'POST',
      path: '/api/host.listDirectory',
      origin: `${PUBLIC_ORIGIN}:${port}`,
      body: rpcBody('host.listDirectory', 10)
    })
    expect(directory.status).toBe(200)
    expect(JSON.parse(directory.body.toString('utf8'))).toMatchObject({
      type: 'server-response',
      result: { ok: true }
    })

    for (const [sequence, method] of [
      'host.pickDirectory',
      'host.openPath',
      'settings.describe',
      'credentials.describe'
    ].entries()) {
      const privileged = await requestLocal(port, {
        method: 'POST',
        path: `/api/${method}`,
        origin: `${PUBLIC_ORIGIN}:${port}`,
        body: rpcBody(method, sequence + 20)
      })
      expect(privileged.status, method).toBe(403)
      expect(privileged.body.toString('utf8')).toBe('forbidden')
    }

    console.log(
      `[dsh-d0] version=real resources=${resources.length} bytes=${resourceBytes} ` +
      `http=${statuses.size} ws=${webSockets.size} privileged=denied`
    )
  } finally {
    await browser.close().catch(() => {})
    stopProcessTree(child)
  }
})

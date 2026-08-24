import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { request } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import WebSocket from 'ws'
import {
  RemotePhoneClient,
  type RemotePhoneState,
  type RemoteSocket
} from '../remotes/app/src/remote/RemotePhoneClient'
import { launchApp } from './helpers'

const execFileAsync = promisify(execFile)
const joinUrl = process.env.HRACK_REMOTE_DSH_D4_JOIN_URL
const dshOrigin = process.env.HRACK_REMOTE_DSH_D4_ORIGIN
const dshExecutable = process.env.HRACK_E2E_REAL_DSH
const adbExecutable = process.env.HRACK_ANDROID_ADB
const appPackage =
  process.env.HRACK_ANDROID_APP_PACKAGE ?? 'app.modplex.hrack.remote'
const uiDumpPath = '/sdcard/hrack-dsh-d4-window.xml'

class NodeSocketAdapter implements RemoteSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  private readonly socket: WebSocket

  constructor(url: string) {
    this.socket = new WebSocket(url)
    this.socket.on('open', () => this.onopen?.())
    this.socket.on('message', (data, binary) =>
      this.onmessage?.({ data: binary ? data : data.toString('utf8') })
    )
    this.socket.on('error', () => this.onerror?.())
    this.socket.on('close', () => this.onclose?.())
  }

  get readyState(): number {
    return this.socket.readyState
  }

  send(data: string): void {
    this.socket.send(data)
  }

  close(): void {
    this.socket.close()
  }
}

async function waitForPhoneState(
  client: RemotePhoneClient,
  predicate: (state: RemotePhoneState) => boolean,
  label: string
): Promise<RemotePhoneState> {
  return new Promise((resolveState, rejectState) => {
    let unsubscribe = () => {}
    let latest = client.getState()
    const timer = setTimeout(() => {
      unsubscribe()
      rejectState(
        new Error(
          `timed out waiting for ${label}: ${JSON.stringify({
            phase: latest.phase,
            desktopConnected: latest.desktopConnected,
            dshOrigin: latest.dsh.origin,
            dshSurface: latest.dsh.surface?.state ?? null,
            terminal: latest.terminal,
            sessionCount: latest.sessions.length,
            protocolErrors: latest.protocolErrors
          })}`
        )
      )
    }, 20_000)
    unsubscribe = client.subscribe((state) => {
      latest = state
      if (!predicate(state)) return
      clearTimeout(timer)
      unsubscribe()
      resolveState(state)
    })
  })
}

async function openPublicWebSocket(
  origin: string,
  path: '/api/events.host' | '/api/events.mux',
  cookie: string
): Promise<WebSocket> {
  const target = new URL(path, origin)
  target.protocol = 'wss:'
  const socket = new WebSocket(target, {
    origin,
    headers: { cookie }
  })
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => {
      socket.terminate()
      rejectOpen(new Error(`${path} timed out`))
    }, 15_000)
    socket.once('open', () => {
      clearTimeout(timer)
      resolveOpen()
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      rejectOpen(error)
    })
  })
  return socket
}

async function waitForPublicWebSocketClose(socket: WebSocket): Promise<number> {
  if (socket.readyState === WebSocket.CLOSED) return 1006
  return new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      socket.terminate()
      rejectClose(new Error('public DSH WebSocket did not close after invalidation'))
    }, 15_000)
    socket.once('close', (code) => {
      clearTimeout(timer)
      resolveClose(code)
    })
  })
}

async function probePublicSse(origin: string, cookie: string): Promise<void> {
  return new Promise((resolveProbe, rejectProbe) => {
    const req = httpsRequest(
      new URL('/plugins/events', origin),
      {
        method: 'GET',
        headers: { cookie, origin, accept: 'text/event-stream' }
      },
      (response) => {
        const status = response.statusCode ?? 0
        response.destroy()
        if (status === 200) resolveProbe()
        else rejectProbe(new Error(`public DSH SSE HTTP ${status}`))
      }
    )
    req.setTimeout(15_000, () => req.destroy(new Error('public DSH SSE timed out')))
    req.once('error', rejectProbe)
    req.end()
  })
}

async function connectPublicTicket(url: string): Promise<{
  status: number
  setCookie: string | null
}> {
  return new Promise((resolveConnect, rejectConnect) => {
    const req = httpsRequest(
      new URL(url),
      {
        method: 'GET',
        headers: {
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate'
        }
      },
      (response) => {
        response.resume()
        response.once('end', () => {
          const setCookie = response.headers['set-cookie']?.[0] ?? null
          resolveConnect({ status: response.statusCode ?? 0, setCookie })
        })
      }
    )
    req.setTimeout(15_000, () => req.destroy(new Error('public DSH ticket timed out')))
    req.once('error', rejectConnect)
    req.end()
  })
}

function quoteRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function adb(...args: string[]): Promise<string> {
  if (!adbExecutable) throw new Error('HRACK_ANDROID_ADB is not configured')
  const result = await execFileAsync(adbExecutable, args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  })
  return result.stdout
}

async function dumpUi(): Promise<string> {
  await adb('shell', 'uiautomator', 'dump', uiDumpPath)
  return adb('exec-out', 'cat', uiDumpPath)
}

function boundsFor(xml: string, resourceId: string): [number, number] | null {
  const match = xml.match(
    new RegExp(
      `<node[^>]*resource-id="${quoteRegex(resourceId)}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`
    )
  )
  if (!match) return null
  return [
    Math.round((Number(match[1]) + Number(match[3])) / 2),
    Math.round((Number(match[2]) + Number(match[4])) / 2)
  ]
}

function boundsForText(xml: string, text: string): [number, number] | null {
  const match = xml.match(
    new RegExp(
      `<node[^>]*text="${quoteRegex(text)}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`
    )
  )
  if (!match) return null
  return [
    Math.round((Number(match[1]) + Number(match[3])) / 2),
    Math.round((Number(match[2]) + Number(match[4])) / 2)
  ]
}

function textForResource(xml: string, resourceId: string): string | null {
  const node = xml.match(
    new RegExp(`<node[^>]*resource-id="${quoteRegex(resourceId)}"[^>]*>`)
  )?.[0]
  return node?.match(/\btext="([^"]*)"/)?.[1] ?? null
}

function resourceIsEnabled(xml: string, resourceId: string): boolean {
  const node = xml.match(
    new RegExp(`<node[^>]*resource-id="${quoteRegex(resourceId)}"[^>]*>`)
  )?.[0]
  return node?.includes('enabled="true"') === true
}

async function waitForUi(
  predicate: (xml: string) => boolean,
  label: string,
  timeoutMs = 45_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let latest = ''
  while (Date.now() < deadline) {
    latest = await dumpUi().catch(() => '')
    if (predicate(latest)) return latest
    await new Promise((resolveWait) => setTimeout(resolveWait, 350))
  }
  throw new Error(`Timed out waiting for Android UI: ${label}`)
}

async function tapResource(resourceId: string): Promise<void> {
  const xml = await waitForUi(
    (candidate) => boundsFor(candidate, resourceId) !== null,
    resourceId
  )
  const point = boundsFor(xml, resourceId)
  if (!point) throw new Error(`Android resource disappeared: ${resourceId}`)
  await adb('shell', 'input', 'tap', String(point[0]), String(point[1]))
}

async function tapText(text: string): Promise<void> {
  const xml = await waitForUi(
    (candidate) => boundsForText(candidate, text) !== null,
    text
  )
  const point = boundsForText(xml, text)
  if (!point) throw new Error(`Android text disappeared: ${text}`)
  await adb('shell', 'input', 'tap', String(point[0]), String(point[1]))
}

async function replaceFocusedText(value: string): Promise<void> {
  const xml = await dumpUi()
  const node = xml.match(
    /<node[^>]*class="android\.widget\.EditText"[^>]*focused="true"[^>]*>/
  )?.[0]
  if (!node) throw new Error('focused WebView path input was not exposed')
  const current = node.match(/\btext="([^"]*)"/)?.[1] ?? ''
  await adb(
    'shell',
    'input',
    'keyevent',
    'KEYCODE_MOVE_END',
    ...Array.from({ length: current.length }, () => 'KEYCODE_DEL')
  )
  for (const chunk of value.match(/.{1,12}/g) ?? []) {
    const shellQuotedChunk = `'${chunk.replace(/'/g, `'\\''`)}'`
    await adb('shell', 'input', 'text', shellQuotedChunk)
  }
}

async function pairAndroid(targetJoinUrl: string): Promise<void> {
  await tapResource('pairing-manual-toggle')
  await tapResource('pairing-url')
  for (const chunk of targetJoinUrl.match(/.{1,12}/g) ?? []) {
    const shellQuotedChunk = `'${chunk.replace(/'/g, `'\\''`)}'`
    await adb('shell', 'input', 'text', shellQuotedChunk)
    await new Promise((resolveWait) => setTimeout(resolveWait, 120))
  }
  await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
  const pairingUi = await dumpUi()
  if (boundsFor(pairingUi, 'pairing-connect') === null) {
    await tapResource('pairing-manual-toggle')
  }
  await waitForUi(
    (xml) =>
      textForResource(xml, 'pairing-url') === targetJoinUrl &&
      resourceIsEnabled(xml, 'pairing-connect'),
    'complete pairing URL and enabled connect button',
    10_000
  )
  await tapResource('pairing-connect')
}

async function startAndroid(): Promise<void> {
  await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
  await adb('shell', 'wm', 'dismiss-keyguard')
  await adb('shell', 'cmd', 'statusbar', 'collapse')
  await adb('shell', 'pm', 'clear', appPackage)
  await adb('shell', 'am', 'start', '-W', '-n', `${appPackage}/.MainActivity`)
  await waitForUi(
    (xml) => boundsFor(xml, 'pairing-manual-toggle') !== null,
    'pairing screen'
  )
}

async function connectHrack(page: Page, targetJoinUrl: string): Promise<void> {
  await page.evaluate(
    async ({ url }) => {
      await window.remoteApi.setDshEnabled(true)
      await window.remoteApi.connect(url)
    },
    { url: targetJoinUrl }
  )
  await expect
    .poll(() => page.evaluate(() => window.remoteApi.getState()), {
      timeout: 45_000,
      intervals: [250, 500, 1_000]
    })
    .toMatchObject({ phase: expect.stringMatching(/waiting-phone|peer-online/) })
}

async function launchFixtureSession(page: Page, name: string): Promise<{
  sessionId: string
  ptyId: string
}> {
  await page.evaluate(() => window.__hrackDebugShell?.navigate('home'))
  await expect(page.getByTestId('home-quick-codex')).toBeVisible({ timeout: 45_000 })
  await page.getByTestId('home-quick-codex').click()
  await page.getByTestId('cli-session-name').fill(name)
  await page.getByTestId('cli-workspace').fill(process.cwd())
  await page.getByTestId('cli-launch').click()
  await expect
    .poll(
      () => page.evaluate(async (targetName) =>
        (await window.agentApi.listActive()).find((item) => item.name === targetName)?.sessionId ?? null,
      name),
      { timeout: 30_000 }
    )
    .not.toBeNull()
  return page.evaluate(async (targetName) => {
    const session = (await window.agentApi.listActive()).find((item) => item.name === targetName)
    if (!session) throw new Error('D4 fixture session disappeared')
    const pty = (await window.ptyApi.listRecoverable()).find(
      (item) => item.terminalId === session.terminalId
    )
    if (!pty) throw new Error('D4 fixture PTY disappeared')
    return { sessionId: session.sessionId, ptyId: pty.ptyId }
  }, name)
}

async function ptyHistoryText(page: Page, ptyId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const history = await window.ptyApi.getHistory(id)
    return history?.events
      .filter((event) => event.kind === 'output')
      .map((event) => event.kind === 'output' ? event.data : '')
      .join('') ?? ''
  }, ptyId)
}

async function screenshot(testInfo: TestInfo, name: string): Promise<string> {
  const remotePath = `/sdcard/${name}`
  const localPath = testInfo.outputPath(name)
  await adb('shell', 'screencap', '-p', remotePath)
  await adb('pull', remotePath, localPath)
  return localPath
}

async function dshRpc<T>(
  baseUrl: string,
  publicOrigin: string,
  method: string,
  args: unknown = {}
): Promise<T> {
  const local = new URL(baseUrl)
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: crypto.randomUUID(),
    method,
    payload: { args }
  })
  return new Promise<T>((resolveRequest, rejectRequest) => {
    const req = request(
      {
        hostname: local.hostname,
        port: local.port,
        method: 'POST',
        path: `/api/${method}`,
        headers: {
          host: new URL(publicOrigin).host,
          origin: publicOrigin,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
        }
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        response.once('end', () => {
          try {
            if (response.statusCode !== 200) {
              throw new Error(`${method} HTTP ${response.statusCode ?? 0}`)
            }
            const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              result?: { ok?: boolean; value?: T; error?: { message?: string } }
            }
            if (envelope.result?.ok !== true) {
              throw new Error(envelope.result?.error?.message ?? `${method} failed`)
            }
            resolveRequest(envelope.result.value as T)
          } catch (error) {
            rejectRequest(error)
          }
        })
      }
    )
    req.setTimeout(10_000, () => req.destroy(new Error(`${method} timed out`)))
    req.once('error', rejectRequest)
    req.end(body)
  })
}

test.describe('remote DSH D4 Android public relay', () => {
  test.skip(
    !joinUrl || !dshOrigin || !dshExecutable || !adbExecutable,
    'set the D4 join URL, DSH origin, real DSH executable and adb'
  )

  test('carries real Android DSH and PTY traffic together through public TLS', async ({}, testInfo) => {
    test.skip(process.platform !== 'win32', 'current Android/desktop gate is Windows')
    test.setTimeout(300_000)
    if (!joinUrl || !dshOrigin || !dshExecutable) {
      throw new Error('missing D4 environment')
    }

    const origin = new URL(dshOrigin).origin
    expect(origin).toBe(dshOrigin)
    expect(origin.startsWith('https://')).toBe(true)
    const health = await fetch(`${origin}/_healthz`)
    expect(health.status).toBe(200)
    const anonymousRoot = await fetch(`${origin}/`, { redirect: 'manual' })
    expect([401, 404]).toContain(anonymousRoot.status)

    let app: ElectronApplication | undefined
    let publicPhone: RemotePhoneClient | undefined
    let stopTerminalSubscription = () => {}
    try {
      const launched = await launchApp({
        createDefaultTerminal: false,
        localDsh: true,
        env: {
          HRACK_E2E_DSH_INSTALLATION: dshExecutable,
          HRACK_FIXTURE_OBSERVER: '1',
          HRACK_FIXTURE_OBSERVER_HOLD: '1',
          HRACK_E2E_CLI_EXECUTABLE: resolve(
            __dirname,
            'fixtures/remote/interactive-cli.cmd'
          )
        }
      })
      app = launched.app
      const workspace = resolve(launched.userDataDir, 'd4-real-workspace')
      mkdirSync(workspace, { recursive: true })
      const fixtureSession = await launchFixtureSession(launched.window, 'D4 PTY parallel')
      await connectHrack(launched.window, joinUrl)

      await expect
        .poll(() => launched.window.evaluate(() => window.dshApi.getStatus()), {
          timeout: 90_000,
          intervals: [500, 1_000, 2_000]
        })
        .toMatchObject({ state: 'ready', baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/) })
      const hostStatus = await launched.window.evaluate(() => window.dshApi.getStatus())
      if (!hostStatus.baseUrl) throw new Error('real DSH base URL is unavailable')
      await expect
        .poll(() => launched.window.evaluate(() => window.remoteApi.getDshState()), {
          timeout: 45_000,
          intervals: [500, 1_000, 2_000]
        })
        .toMatchObject({
          enabled: true,
          relaySupported: true,
          surface: { state: 'ready', generation: expect.any(Number) }
        })

      await startAndroid()
      await pairAndroid(joinUrl)
      await waitForUi(
        (xml) => boundsFor(xml, 'dsh-surface') !== null && xml.includes('DeepSeek Harness'),
        'real DSH surface in the paired session list',
        60_000
      )
      const firstLoadStartedAt = Date.now()
      await tapResource('dsh-surface')
      const pageUi = await waitForUi(
        (xml) =>
          boundsFor(xml, 'dsh-back') !== null &&
          boundsFor(xml, 'dsh-webview') !== null,
        'real DSH WebView',
        90_000
      )
      const settledUi = await waitForUi(
        (xml) =>
          xml.includes('Continue') ||
          xml.includes('Failed to load plugins') ||
          xml.includes('failed to import loader entry'),
        'official DSH boot result',
        45_000
      )
      await testInfo.attach('d4-android-real-dsh.xml', {
        body: settledUi,
        contentType: 'application/xml'
      })
      await screenshot(testInfo, 'd4-android-real-dsh.png')

      const visibleTextCount = [...settledUi.matchAll(/\btext="([^"]+)"/g)]
        .filter((match) => Boolean(match[1])).length
      expect(settledUi).not.toContain('Failed to load plugins')
      expect(settledUi).not.toContain('failed to import loader entry')
      expect(visibleTextCount).toBeGreaterThan(3)

      if (boundsForText(settledUi, 'Continue')) {
        await tapText('Continue')
      }
      const homeUi = await waitForUi(
        (xml) =>
          !xml.includes('Internal Testing Notice') &&
          !xml.includes('Failed to load plugins') &&
          xml.includes('New session') &&
          xml.includes('Add workspace') &&
          boundsFor(xml, 'dsh-back') !== null,
        'DSH home after its first-run notice',
        45_000
      )
      const firstLoadMs = Date.now() - firstLoadStartedAt
      const sessionsBefore = await dshRpc<{
        items?: Array<{ sessionId?: string; cwd?: string }>
      }>(hostStatus.baseUrl, origin, 'session.list')
      const sessionIdsBefore = new Set(
        (sessionsBefore.items ?? [])
          .map((item) => item.sessionId)
          .filter((id): id is string => typeof id === 'string')
      )
      await screenshot(testInfo, 'd4-android-real-dsh-home.png')

      await tapText('Add workspace')
      await new Promise((resolveWait) => setTimeout(resolveWait, 3_000))
      const pickerUi = await dumpUi()
      expect(pickerUi).not.toContain('Failed to load plugins')
      await screenshot(testInfo, 'd4-android-real-dsh-picker.png')

      await tapText('Edit path')
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
      await dumpUi()
      await screenshot(testInfo, 'd4-android-real-dsh-edit-path.png')

      await replaceFocusedText(workspace.replaceAll('\\', '/'))
      await adb('shell', 'input', 'keyevent', 'KEYCODE_ENTER')
      await waitForUi(
        (xml) => xml.includes('d4-real-workspace'),
        'test-owned workspace path in browse picker',
        20_000
      )
      await tapText('Open')
      await waitForUi(
        (xml) =>
          !xml.includes('Select Workspace Directory') &&
          xml.includes('d4-real-workspace'),
        'test-owned workspace selected through official browse picker',
        30_000
      )
      await screenshot(testInfo, 'd4-android-real-dsh-workspace.png')

      let createdSession = (
        await dshRpc<{
          items?: Array<{ sessionId?: string; cwd?: string }>
        }>(hostStatus.baseUrl, origin, 'session.list')
      ).items?.find(
        (item) =>
          typeof item.sessionId === 'string' &&
          !sessionIdsBefore.has(item.sessionId) &&
          item.cwd?.toLowerCase() === workspace.toLowerCase()
      )
      if (!createdSession) {
        await tapText('New session')
        await expect
          .poll(
            async () => {
              const listed = await dshRpc<{
                items?: Array<{ sessionId?: string; cwd?: string }>
              }>(hostStatus.baseUrl!, origin, 'session.list')
              createdSession = listed.items?.find(
                (item) =>
                  typeof item.sessionId === 'string' &&
                  !sessionIdsBefore.has(item.sessionId) &&
                  item.cwd?.toLowerCase() === workspace.toLowerCase()
              )
              return createdSession?.sessionId ?? null
            },
            { timeout: 20_000, intervals: [250, 500, 1_000] }
          )
          .not.toBeNull()
      }
      expect(createdSession?.sessionId).toEqual(expect.any(String))

      await tapResource('dsh-back')
      await waitForUi(
        (xml) => boundsFor(xml, 'dsh-surface') !== null && boundsFor(xml, 'dsh-back') === null,
        'paired session list after leaving DSH',
        15_000
      )
      const reentryStartedAt = Date.now()
      await tapResource('dsh-surface')
      await waitForUi(
        (xml) =>
          boundsFor(xml, 'dsh-back') !== null &&
          boundsFor(xml, 'dsh-webview') !== null &&
          xml.includes('d4-real-workspace'),
        'cached DSH WebView re-entry',
        15_000
      )
      const reentryMs = Date.now() - reentryStartedAt
      await screenshot(testInfo, 'd4-android-real-dsh-reentry.png')

      // Hand the only Phone seat from Android to the product phone client so
      // the same real public room can prove ticket replay, public denial, SSE
      // and both event WebSockets without extracting the App's HttpOnly Cookie.
      await adb('shell', 'am', 'force-stop', appPackage)
      await expect
        .poll(() => launched.window.evaluate(() => window.remoteApi.getState()), {
          timeout: 20_000,
          intervals: [250, 500, 1_000]
        })
        .toMatchObject({ phase: 'waiting-phone' })

      publicPhone = new RemotePhoneClient((url) => new NodeSocketAdapter(url))
      let terminalHistoryOpened = false
      let terminalAckBytes = 0
      stopTerminalSubscription = publicPhone.subscribeTerminal((event) => {
        if (!publicPhone || event.sessionId !== fixtureSession.sessionId) return
        if (event.type === 'open') {
          terminalHistoryOpened = publicPhone.markTerminalHistoryReady(
            event.sessionId,
            52,
            20
          )
          return
        }
        if (publicPhone.acknowledgeTerminalOutput(
          event.sessionId,
          event.deliveryId,
          event.byteLength
        )) {
          terminalAckBytes += event.byteLength
        }
      })
      expect(publicPhone.connect(joinUrl)).toEqual({ ok: true })
      const publicReady = await waitForPhoneState(
        publicPhone,
        (state) =>
          state.phase === 'ready' &&
          state.desktopConnected &&
          state.dsh.origin === origin &&
          state.dsh.surface?.state === 'ready',
        'public DSH phone seat'
      )
      expect(publicReady.sessions.some(
        (session) => session.sessionId === fixtureSession.sessionId
      )).toBe(true)
      expect(publicPhone.driveSession(fixtureSession.sessionId, 52, 20)).toMatchObject({
        ok: true
      })
      await waitForPhoneState(
        publicPhone,
        (state) =>
          state.terminal.phase === 'driven' &&
          state.terminal.sessionId === fixtureSession.sessionId,
        'parallel public PTY drive'
      )
      expect(terminalHistoryOpened).toBe(true)
      const ticket = await publicPhone.requestDshTicket()
      if (!ticket.ok) throw new Error(`public DSH ticket rejected: ${ticket.reason}`)
      const connected = await connectPublicTicket(ticket.url)
      expect(connected.status).toBe(303)
      const cookie = connected.setCookie?.split(';', 1)[0]
      if (!cookie) throw new Error('public DSH Cookie was not issued')
      expect((await connectPublicTicket(ticket.url)).status).toBe(404)

      const privileged = await fetch(`${origin}/api/settings.describe`, {
        method: 'POST',
        headers: {
          cookie,
          origin,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method: 'settings.describe',
          payload: { args: {} }
        })
      })
      expect(privileged.status).toBe(403)
      const loopbackProxy = await fetch(`${origin}/http://127.0.0.1:1/`, {
        headers: { cookie, origin }
      })
      expect(loopbackProxy.status).toBe(404)

      await probePublicSse(origin, cookie)
      const eventSockets = await Promise.all([
        openPublicWebSocket(origin, '/api/events.host', cookie),
        openPublicWebSocket(origin, '/api/events.mux', cookie)
      ])
      const ptyMarker = `d4pty${Date.now()}`
      const ptyInputStartedAt = Date.now()
      expect(publicPhone.sendTerminalInput(
        fixtureSession.sessionId,
        `echo ${ptyMarker}\r`
      )).toBe(true)
      await expect
        .poll(() => ptyHistoryText(launched.window, fixtureSession.ptyId), {
          timeout: 20_000,
          intervals: [100, 250, 500]
        })
        .toContain(ptyMarker)
      const ptyInputAckMs = Date.now() - ptyInputStartedAt
      await expect.poll(() => terminalAckBytes, { timeout: 10_000 }).toBeGreaterThan(0)

      const eventSocketClosures = eventSockets.map(waitForPublicWebSocketClose)
      await launched.window.evaluate(() => window.remoteApi.setDshEnabled(false))
      await waitForPhoneState(
        publicPhone,
        (state) =>
          state.dsh.surface?.state === 'unavailable' &&
          state.terminal.phase === 'driven' &&
          state.terminal.sessionId === fixtureSession.sessionId,
        'DSH invalidation without PTY release'
      )
      expect(await Promise.all(eventSocketClosures)).toEqual([1001, 1001])
      expect((await fetch(`${origin}/`, { headers: { cookie, origin } })).status).toBe(401)
      await expect
        .poll(() => launched.window.evaluate(() => window.remoteApi.getDshState()))
        .toMatchObject({ enabled: false, surface: { state: 'unavailable' } })

      console.log(
        `[dsh-d4-red] origin=${origin} webview=ready accessibleBytes=${Buffer.byteLength(pageUi)} ` +
          `officialText=${pageUi.includes('DeepSeek Harness') ? 'visible' : 'not-exposed'} ` +
          `visibleTextCount=${visibleTextCount} homeBytes=${Buffer.byteLength(homeUi)} ` +
          `firstLoadMs=${firstLoadMs} cacheReentryMs=${reentryMs} ` +
          `blankSession=created ticket=one-use privileged=denied websocket=2 ` +
          `pty=driven ptyAckBytes=${terminalAckBytes} ptyInputAckMs=${ptyInputAckMs} ` +
          `invalidation=cookie+websocket+tunnel ptyAfterInvalidation=driven`
      )
    } finally {
      stopTerminalSubscription()
      publicPhone?.disconnect(true)
      await adb('shell', 'am', 'force-stop', appPackage).catch(() => {})
      await app?.close().catch(() => {})
    }
  })
})

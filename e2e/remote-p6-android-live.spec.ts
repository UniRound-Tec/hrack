import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@playwright/test'
import WebSocket from 'ws'
import { launchApp } from './helpers'
import {
  parseJoinUrl,
  parseRemoteFrame,
  type RemoteMessage
} from '../shared/remote-protocol'

const execFileAsync = promisify(execFile)
const targetUrl = process.env.HRACK_REMOTE_P6_URL
const adbExecutable = process.env.HRACK_ANDROID_ADB
const appPackage =
  process.env.HRACK_ANDROID_APP_PACKAGE ?? 'app.modplex.hrack.remote'
const uiDumpPath = '/sdcard/hrack-p6-window.xml'

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

async function enterSensitiveText(value: string): Promise<void> {
  try {
    await adb('shell', 'input', 'text', value)
  } catch {
    throw new Error('Android failed to enter the pairing URL')
  }
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

async function waitForUi(
  predicate: (xml: string) => boolean,
  label: string,
  timeoutMs = 30_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let latest = ''
  while (Date.now() < deadline) {
    latest = await dumpUi().catch(() => '')
    if (predicate(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 350))
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

async function screenshot(testInfo: TestInfo, name: string): Promise<void> {
  const remotePath = `/sdcard/${name}`
  await adb('shell', 'screencap', '-p', remotePath)
  await adb('pull', remotePath, testInfo.outputPath(name))
}

async function pairAndroid(joinUrl: string): Promise<void> {
  await tapResource('pairing-manual-toggle')
  await tapResource('pairing-url')
  await enterSensitiveText(joinUrl)
  await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
  await tapResource('pairing-connect')
}

async function startAndroid(): Promise<void> {
  await adb('shell', 'pm', 'clear', appPackage)
  await adb(
    'shell',
    'am',
    'start',
    '-W',
    '-n',
    `${appPackage}/.MainActivity`
  )
  await waitForUi(
    (xml) => boundsFor(xml, 'pairing-manual-toggle') !== null,
    'pairing screen',
    45_000
  )
}

async function launchSession(
  page: Page,
  name: string
): Promise<{ sessionId: string; terminalId: string }> {
  await page.evaluate(() => window.__hrackDebugShell?.navigate('home'))
  await page.getByTestId('home-quick-codex').click()
  await page.getByTestId('cli-session-name').fill(name)
  await page.getByTestId('cli-workspace').fill(process.cwd())
  await page.getByTestId('cli-launch').click()
  await expect
    .poll(
      () =>
        page.evaluate(async (targetName) => {
          const session = (await window.agentApi.listActive()).find(
            (candidate) => candidate.name === targetName
          )
          return session
            ? { sessionId: session.sessionId, terminalId: session.terminalId }
            : null
        }, name),
      { timeout: 30_000 }
    )
    .not.toBeNull()
  return page.evaluate(async (targetName) => {
    const session = (await window.agentApi.listActive()).find(
      (candidate) => candidate.name === targetName
    )
    if (!session) throw new Error('launched session disappeared')
    return { sessionId: session.sessionId, terminalId: session.terminalId }
  }, name)
}

async function connectHrack(page: Page, joinUrl: string): Promise<void> {
  await page.evaluate(() => window.__hrackDebugShell?.navigate('settings'))
  await page.getByTestId('settings-category-remote').click()
  await page.getByTestId('settings-remote-url').fill(joinUrl)
  await page.getByTestId('settings-remote-connect').click()
  await page.getByTestId('settings-remote-confirm-accept').click()
  await expect(page.getByTestId('settings-remote-status')).toHaveAttribute(
    'data-remote-phase',
    'peer-online'
  )
}

async function openPhoneSeat(joinUrl: string): Promise<WebSocket> {
  const parsed = parseJoinUrl(joinUrl)
  if (!parsed.ok) throw new Error('relay generated an invalid join URL')
  const socket = new WebSocket(parsed.value.wsUrl, {
    headers: { origin: parsed.value.origin }
  })
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('phone seat failed')), {
      once: true
    })
  })
  const hello = new Promise<RemoteMessage>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('phone seat hello timed out')),
      10_000
    )
    socket.addEventListener(
      'message',
      (event) => {
        const parsedFrame = parseRemoteFrame(String(event.data))
        if (!parsedFrame.ok) return
        clearTimeout(timeout)
        resolve(parsedFrame.value)
      },
      { once: true }
    )
  })
  socket.send(
    JSON.stringify({
      v: 1,
      type: 'hello',
      role: 'phone',
      roomId: parsed.value.roomId
    } satisfies RemoteMessage)
  )
  expect((await hello).type).toBe('hello-ok')
  return socket
}

test.describe('remote P6 Android live relay', () => {
  test.skip(
    !targetUrl || !adbExecutable,
    'set HRACK_REMOTE_P6_URL and HRACK_ANDROID_ADB for the installed App gate'
  )

  test('pairs the installed App with real Electron sessions over public WSS', async ({
    page: relayPage
  }, testInfo) => {
    test.skip(process.platform !== 'win32', 'current Android/Electron gate is Windows')
    test.setTimeout(180_000)
    if (!targetUrl) throw new Error('missing live relay target')

    let app: ElectronApplication | undefined
    let occupyingPhone: WebSocket | undefined
    let roomCreated = false
    let roomRevoked = false

    try {
      await adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0')
      await adb('shell', 'settings', 'put', 'system', 'user_rotation', '0')
      await startAndroid()
      await screenshot(testInfo, 'p6-android-pairing.png')

      const response = await relayPage.goto(targetUrl)
      if (!response?.ok()) throw new Error('relay generate page did not load')
      await relayPage.getByTestId('create-room').click()
      await expect(relayPage.getByTestId('join-url')).toBeVisible()
      roomCreated = true
      const joinUrl = await relayPage.getByTestId('join-url').innerText()

      await pairAndroid(joinUrl)
      await waitForUi(
        (xml) => xml.includes('等待 HRack 桌面端'),
        'phone waiting for desktop'
      )
      await screenshot(testInfo, 'p6-android-waiting.png')

      const launched = await launchApp({
        createDefaultTerminal: false,
        env: {
          HRACK_FIXTURE_OBSERVER: '1',
          // 给 UIAutomator 读取语义树和 adb 截图留出稳定窗口，避免状态在两步之间推进。
          HRACK_FIXTURE_OBSERVER_INTERVAL_MS: '5000'
        }
      })
      app = launched.app
      const hrackPage = launched.window
      const firstName = 'P6 Android snapshot'
      const secondName = 'P6 Android upsert'
      await launchSession(hrackPage, firstName)
      await connectHrack(hrackPage, joinUrl)

      await waitForUi(
        (xml) => xml.includes(firstName) && xml.includes('工作中'),
        'first real session snapshot'
      )
      await launchSession(hrackPage, secondName)
      await waitForUi(
        (xml) =>
          xml.includes(firstName) &&
          xml.includes(secondName) &&
          xml.includes('AI CLI 会话'),
        'second real session upsert'
      )
      await screenshot(testInfo, 'p6-android-sessions.png')

      await waitForUi(
        (xml) => xml.includes('需要你') && xml.includes('1 待处理'),
        'live needs-you projection',
        45_000
      )
      await screenshot(testInfo, 'p6-android-needs-you.png')

      await tapResource('sessions-forget')
      await waitForUi(
        (xml) => boundsFor(xml, 'pairing-manual-toggle') !== null,
        'pairing after disconnect'
      )
      occupyingPhone = await openPhoneSeat(joinUrl)
      await pairAndroid(joinUrl)
      await waitForUi(
        (xml) => xml.includes('这个位置被占用了'),
        'occupied phone seat'
      )
      await screenshot(testInfo, 'p6-android-occupied.png')

      occupyingPhone.close()
      occupyingPhone = undefined
      await tapResource('connection-retry')
      await waitForUi(
        (xml) => xml.includes(firstName) && xml.includes(secondName),
        'sessions after occupied retry'
      )

      await hrackPage.evaluate(() => window.remoteApi.disconnect())
      await waitForUi(
        (xml) =>
          xml.includes('等待 HRack 桌面端') &&
          !xml.includes(firstName) &&
          !xml.includes(secondName),
        'desktop leave clears sessions'
      )
      await screenshot(testInfo, 'p6-android-desktop-offline.png')

      await relayPage.getByTestId('revoke-room').click()
      await expect(relayPage.getByTestId('status')).toHaveText('Room revoked.')
      roomRevoked = true
      await waitForUi(
        (xml) => xml.includes('房间已经关闭'),
        'room revoked'
      )
      await screenshot(testInfo, 'p6-android-revoked.png')
    } finally {
      occupyingPhone?.close()
      if (roomCreated && !roomRevoked) {
        const revoke = relayPage.getByTestId('revoke-room')
        if (await revoke.isVisible().catch(() => false)) {
          await revoke.click().catch(() => {})
        }
      }
      await app?.close().catch(() => {})
      await adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '1').catch(
        () => {}
      )
    }
  })
})

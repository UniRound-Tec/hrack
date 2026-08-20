import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@playwright/test'
import { launchApp } from './helpers'

const execFileAsync = promisify(execFile)
const targetUrl = process.env.HRACK_REMOTE_P7_URL
const adbExecutable = process.env.HRACK_ANDROID_ADB
const appPackage =
  process.env.HRACK_ANDROID_APP_PACKAGE ?? 'app.modplex.hrack.remote'
const uiDumpPath = '/sdcard/hrack-p7-window.xml'

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

async function enterText(resourceId: string, value: string): Promise<void> {
  await tapResource(resourceId)
  await adb('shell', 'input', 'text', value)
  await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
}

async function screenshot(testInfo: TestInfo, name: string): Promise<void> {
  const remotePath = `/sdcard/${name}`
  await adb('shell', 'screencap', '-p', remotePath)
  await adb('pull', remotePath, testInfo.outputPath(name))
}

async function startAndroid(): Promise<void> {
  await adb('shell', 'pm', 'clear', appPackage)
  await adb('shell', 'am', 'start', '-W', '-n', `${appPackage}/.MainActivity`)
  await waitForUi(
    (xml) => boundsFor(xml, 'pairing-manual-toggle') !== null,
    'pairing screen'
  )
}

async function pairAndroid(joinUrl: string): Promise<void> {
  await tapResource('pairing-manual-toggle')
  await tapResource('pairing-url')
  try {
    await adb('shell', 'input', 'text', joinUrl)
  } catch {
    throw new Error('Android failed to enter the pairing URL')
  }
  await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
  await tapResource('pairing-connect')
}

async function connectHrack(page: Page, joinUrl: string): Promise<void> {
  await page.evaluate(() => window.__hrackDebugShell?.navigate('settings'))
  await page.getByTestId('settings-category-remote').click()
  await page.getByTestId('settings-remote-url').fill(joinUrl)
  await page.getByTestId('settings-remote-connect').click()
  await page.getByTestId('settings-remote-confirm-accept').click()
  await expect(page.getByTestId('settings-remote-status')).toHaveAttribute(
    'data-remote-phase',
    'waiting-phone'
  )
}

test.describe('remote P7 Android live relay', () => {
  test.skip(
    !targetUrl || !adbExecutable,
    'set HRACK_REMOTE_P7_URL and HRACK_ANDROID_ADB for the installed App gate'
  )

  test('creates one real Electron PTY from the installed App over public WSS', async ({
    page: relayPage
  }, testInfo) => {
    test.skip(process.platform !== 'win32', 'current Android/Electron gate is Windows')
    test.setTimeout(180_000)
    if (!targetUrl) throw new Error('missing live relay target')

    let app: ElectronApplication | undefined
    let roomCreated = false
    let roomRevoked = false
    try {
      const response = await relayPage.goto(targetUrl)
      if (!response?.ok()) throw new Error('relay generate page did not load')
      await relayPage.getByTestId('create-room').click()
      await expect(relayPage.getByTestId('join-url')).toBeVisible()
      roomCreated = true
      const joinUrl = await relayPage.getByTestId('join-url').innerText()

      const missingWorkspace = `${process.cwd()}\\__hrack_missing_p7_${Date.now()}`
      const launched = await launchApp({
        createDefaultTerminal: false,
        env: {
          HRACK_FIXTURE_OBSERVER: '1',
          HRACK_FIXTURE_OBSERVER_HOLD: '1',
          HRACK_E2E_CLI_EXECUTABLE: resolve(
            __dirname,
            'fixtures/remote/interactive-cli.cmd'
          )
        }
      })
      app = launched.app
      const hrackPage = launched.window
      await hrackPage.evaluate(
        ([workspace, missing]) =>
          window.remoteApi.setRecentWorkspaces([workspace, missing]),
        [process.cwd(), missingWorkspace]
      )
      await connectHrack(hrackPage, joinUrl)

      await adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0')
      await adb('shell', 'settings', 'put', 'system', 'user_rotation', '0')
      await startAndroid()
      await pairAndroid(joinUrl)
      await waitForUi(
        (xml) =>
          boundsFor(xml, 'sessions-create') !== null &&
          xml.includes('0') &&
          xml.includes('AI CLI 会话'),
        'catalog-backed sessions screen'
      )

      await tapResource('sessions-create')
      await waitForUi(
        (xml) =>
          boundsFor(xml, 'creation-submit') !== null &&
          xml.includes(process.cwd()) &&
          xml.includes('Codex'),
        'catalog-backed creation form'
      )
      await screenshot(testInfo, 'p7-android-create-form.png')

      await enterText('creation-arguments', 'p7-mobile-model')
      await tapResource('creation-skip-approval')
      await tapResource('creation-submit')
      await waitForUi(
        (xml) =>
          boundsFor(xml, 'creation-done') !== null &&
          xml.includes('已经在电脑启动'),
        'real creation success'
      )
      await screenshot(testInfo, 'p7-android-create-success.png')

      const created = await hrackPage.evaluate(async () => {
        const active = await window.agentApi.listActive()
        const recoverable = await window.ptyApi.listRecoverable()
        return {
          active: active.map((session) => ({
            sessionId: session.sessionId,
            terminalId: session.terminalId,
            adapterId: session.adapterId
          })),
          recoverable: recoverable.map((pty) => ({
            terminalId: pty.terminalId,
            args: pty.agentSelection?.args ?? []
          })),
          drive: await window.remoteApi.getDriveState()
        }
      })
      expect(created.active).toHaveLength(1)
      const createdPty = created.recoverable.find(
        (pty) => pty.terminalId === created.active[0].terminalId
      )
      expect(createdPty?.args).toEqual(['--yolo', 'p7-mobile-model'])
      expect(created.drive).toMatchObject({ phase: 'idle', sessionId: null })

      await tapResource('creation-done')
      await waitForUi(
        (xml) =>
          boundsFor(xml, 'sessions-create') !== null &&
          xml.includes('Codex') &&
          xml.includes('1'),
        'created session list upsert'
      )
      await screenshot(testInfo, 'p7-android-created-session.png')

      // The newly launched workspace is persisted by AppShell and refreshes the
      // catalog. Re-publish the invalid fixture immediately before this check.
      await hrackPage.evaluate(
        ([workspace, missing]) =>
          window.remoteApi.setRecentWorkspaces([workspace, missing]),
        [process.cwd(), missingWorkspace]
      )
      await tapResource('sessions-create')
      await tapResource('creation-recent-1')
      await tapResource('creation-submit')
      await waitForUi(
        (xml) =>
          boundsFor(xml, 'creation-retry') !== null &&
          xml.includes('电脑找不到这个工作区'),
        'invalid workspace rejection'
      )
      await screenshot(testInfo, 'p7-android-create-rejected.png')

      expect(await hrackPage.evaluate(() => window.agentApi.listActive())).toHaveLength(1)
      expect(await hrackPage.evaluate(() => window.ptyApi.listRecoverable())).toHaveLength(1)

      await relayPage.getByTestId('revoke-room').click()
      await expect(relayPage.getByTestId('status')).toHaveText('Room revoked.')
      roomRevoked = true
      await waitForUi((xml) => xml.includes('房间已经关闭'), 'room revoked')
    } finally {
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

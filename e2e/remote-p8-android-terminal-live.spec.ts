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
const targetUrl = process.env.HRACK_REMOTE_P8_URL
const adbExecutable = process.env.HRACK_ANDROID_ADB
const appPackage =
  process.env.HRACK_ANDROID_APP_PACKAGE ?? 'app.modplex.hrack.remote'
const uiDumpPath = '/sdcard/hrack-p8-window.xml'

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

interface TerminalMetrics {
  renderer: string
  cols: number
  rows: number
  parsedBytes: number
}

function terminalMetrics(xml: string): TerminalMetrics | null {
  const match = xml.match(
    /text="(WEBGL|DOM) · (\d+) × (\d+) · 已解析\s*(\d+) B"/
  )
  if (!match) return null
  return {
    renderer: match[1],
    cols: Number(match[2]),
    rows: Number(match[3]),
    parsedBytes: Number(match[4])
  }
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

async function launchSession(
  page: Page,
  name: string,
  adapterId = 'codex'
): Promise<{
  sessionId: string
  terminalId: string
  ptyId: string
}> {
  await page.evaluate(() => window.__hrackDebugShell?.navigate('home'))
  await expect(page.getByTestId(`home-quick-${adapterId}`)).toBeVisible({
    timeout: 45_000
  })
  await page.getByTestId(`home-quick-${adapterId}`).click()
  await page.getByTestId('cli-session-name').fill(name)
  await page.getByTestId('cli-workspace').fill(process.cwd())
  await page.getByTestId('cli-launch').click()
  await expect
    .poll(
      () =>
        page.evaluate(async (targetName) => {
          const found = (await window.agentApi.listActive()).find(
            (candidate) => candidate.name === targetName
          )
          return found?.sessionId ?? null
        }, name),
      { timeout: 30_000 }
    )
    .not.toBeNull()
  return page.evaluate(async (targetName) => {
    const found = (await window.agentApi.listActive()).find(
      (candidate) => candidate.name === targetName
    )
    if (!found) throw new Error('fixture agent disappeared')
    const pty = (await window.ptyApi.listRecoverable()).find(
      (candidate) => candidate.terminalId === found.terminalId
    )
    if (!pty) throw new Error('fixture PTY disappeared')
    return {
      sessionId: found.sessionId,
      terminalId: found.terminalId,
      ptyId: pty.ptyId
    }
  }, name)
}

async function historyText(page: Page, ptyId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const history = await window.ptyApi.getHistory(id)
    return (
      history?.events
        .filter((event) => event.kind === 'output')
        .map((event) => (event.kind === 'output' ? event.data : ''))
        .join('') ?? ''
    )
  }, ptyId)
}

test.describe('remote P8 Android terminal live relay', () => {
  test.skip(
    !targetUrl || !adbExecutable,
    'set HRACK_REMOTE_P8_URL and HRACK_ANDROID_ADB for the installed App gate'
  )

  test('drives, types, resizes, releases and creates through the installed App', async ({
    page: relayPage
  }, testInfo) => {
    test.skip(process.platform !== 'win32', 'current Android/Electron gate is Windows')
    test.setTimeout(240_000)
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
      const sessionName = 'P8 Android terminal'
      const existing = await launchSession(hrackPage, sessionName)
      const historyMarker = `p8history${Date.now()}`
      await hrackPage.evaluate(
        ({ ptyId, marker }) => window.ptyApi.write(ptyId, `echo ${marker}\r`),
        { ptyId: existing.ptyId, marker: historyMarker }
      )
      await expect
        .poll(() => historyText(hrackPage, existing.ptyId))
        .toContain(historyMarker)

      await hrackPage.evaluate(
        (workspace) => window.remoteApi.setRecentWorkspaces([workspace]),
        process.cwd()
      )
      await connectHrack(hrackPage, joinUrl)

      await adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0')
      await adb('shell', 'settings', 'put', 'system', 'user_rotation', '0')
      await startAndroid()
      await pairAndroid(joinUrl)
      await waitForUi(
        (xml) => xml.includes(sessionName) && boundsFor(xml, 'sessions-create') !== null,
        'real session list'
      )
      await tapResource(`session-${existing.sessionId}`)
      const portraitXml = await waitForUi(
        (xml) =>
          xml.includes('手机正在控制这一个终端') && terminalMetrics(xml) !== null,
        'driven terminal with parsed history'
      )
      const portrait = terminalMetrics(portraitXml)
      if (!portrait) throw new Error('missing portrait terminal metrics')
      expect(portrait.parsedBytes).toBeGreaterThan(0)
      await expect
        .poll(() => hrackPage.evaluate(() => window.remoteApi.getDriveState()))
        .toMatchObject({
          phase: 'driven',
          sessionId: existing.sessionId,
          cols: portrait.cols,
          rows: portrait.rows
        })
      await screenshot(testInfo, 'p8-android-terminal-portrait.png')

      const inputMarker = `p8input${Date.now()}`
      await tapResource('terminal-command-input')
      await adb('shell', 'input', 'text', `echo%s${inputMarker}`)
      await waitForUi(
        (xml) => xml.includes(inputMarker),
        'committed native terminal command'
      )
      await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
      await tapResource('terminal-command-send')
      await expect
        .poll(() => historyText(hrackPage, existing.ptyId), { timeout: 30_000 })
        .toContain(inputMarker)
      const parsedAfterInput = await waitForUi(
        (xml) => {
          const metrics = terminalMetrics(xml)
          return !!metrics && metrics.parsedBytes > portrait.parsedBytes
        },
        'WebView parsed and acked live PTY output'
      )
      expect(terminalMetrics(parsedAfterInput)?.parsedBytes).toBeGreaterThan(
        portrait.parsedBytes
      )

      const beforeBurst = terminalMetrics(parsedAfterInput)?.parsedBytes ?? 0
      const burstMarker = `p8burst${Date.now()}`
      const burstStartedAt = Date.now()
      await hrackPage.evaluate(
        ({ ptyId, marker }) =>
          window.ptyApi.write(
            ptyId,
            `for /L %i in (1,1,6000) do @echo P8BURST0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ%i\r` +
              `echo ${marker}\r`
          ),
        { ptyId: existing.ptyId, marker: burstMarker }
      )
      await expect
        .poll(() => historyText(hrackPage, existing.ptyId), { timeout: 45_000 })
        .toContain(burstMarker)
      const afterBurstXml = await waitForUi(
        (xml) => {
          const metrics = terminalMetrics(xml)
          return !!metrics && metrics.parsedBytes > beforeBurst + 250_000
        },
        'bounded real PTY burst parsed and acked',
        45_000
      )
      const afterBurst = terminalMetrics(afterBurstXml)
      if (!afterBurst) throw new Error('missing terminal metrics after PTY burst')
      console.log(
        `[p8-terminal-burst] renderer=${afterBurst.renderer} bytes=${afterBurst.parsedBytes - beforeBurst} elapsedMs=${Date.now() - burstStartedAt}`
      )

      await adb('shell', 'settings', 'put', 'system', 'user_rotation', '1')
      const landscapeXml = await waitForUi(
        (xml) => {
          const metrics = terminalMetrics(xml)
          return (
            !!metrics &&
            (metrics.cols !== portrait.cols || metrics.rows !== portrait.rows)
          )
        },
        'landscape terminal resize'
      )
      const landscape = terminalMetrics(landscapeXml)
      if (!landscape) throw new Error('missing landscape terminal metrics')
      await expect
        .poll(() => hrackPage.evaluate(() => window.remoteApi.getDriveState()))
        .toMatchObject({
          phase: 'driven',
          sessionId: existing.sessionId,
          cols: landscape.cols,
          rows: landscape.rows
        })
      await screenshot(testInfo, 'p8-android-terminal-landscape.png')

      await tapResource('terminal-back')
      await waitForUi(
        (xml) => xml.includes(sessionName) && boundsFor(xml, 'sessions-create') !== null,
        'session list after undrive'
      )
      await expect
        .poll(() => hrackPage.evaluate(() => window.remoteApi.getDriveState()))
        .toMatchObject({ phase: 'idle', sessionId: null })

      await adb('shell', 'settings', 'put', 'system', 'user_rotation', '0')
      await waitForUi(
        (xml) => boundsFor(xml, 'sessions-create') !== null,
        'portrait session list'
      )
      await tapResource('sessions-create')
      await waitForUi(
        (xml) => boundsFor(xml, 'creation-submit') !== null,
        'creation form before measured create'
      )
      await tapResource('creation-submit')
      await waitForUi(
        (xml) =>
          xml.includes('手机正在控制这一个终端') && terminalMetrics(xml) !== null,
        'newly created measured terminal'
      )
      const createdMetrics = terminalMetrics(await dumpUi())
      if (!createdMetrics) throw new Error('missing created terminal metrics')
      const created = await hrackPage.evaluate(async (firstSessionId) => {
        const sessions = await window.agentApi.listActive()
        const next = sessions.find((session) => session.sessionId !== firstSessionId)
        if (!next) return null
        const pty = (await window.ptyApi.listRecoverable()).find(
          (candidate) => candidate.terminalId === next.terminalId
        )
        return pty
          ? { sessionId: next.sessionId, terminalId: next.terminalId, ptyId: pty.ptyId }
          : null
      }, existing.sessionId)
      expect(created).not.toBeNull()
      await expect
        .poll(() => hrackPage.evaluate(() => window.remoteApi.getDriveState()))
        .toMatchObject({
          phase: 'driven',
          sessionId: created?.sessionId,
          cols: createdMetrics.cols,
          rows: createdMetrics.rows
        })
      await screenshot(testInfo, 'p8-android-created-terminal.png')

      await tapResource('terminal-back')
      await expect
        .poll(() => hrackPage.evaluate(() => window.remoteApi.getDriveState()))
        .toMatchObject({ phase: 'idle', sessionId: null })

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
      await adb('shell', 'settings', 'put', 'system', 'user_rotation', '0').catch(
        () => {}
      )
      await adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '1').catch(
        () => {}
      )
    }
  })

  test('renders real Claude Code and Codex TUIs through the installed App', async ({
    page: relayPage
  }, testInfo) => {
    test.skip(process.platform !== 'win32', 'current Android/Electron gate is Windows')
    test.skip(
      process.env.HRACK_REMOTE_P8_REAL_AI !== '1',
      'set HRACK_REMOTE_P8_REAL_AI=1 to launch installed authenticated AI CLIs'
    )
    test.setTimeout(300_000)
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

      const launched = await launchApp({
        createDefaultTerminal: false,
        cliFixture: false
      })
      app = launched.app
      const hrackPage = launched.window
      const targets = [
        {
          adapterId: 'claude',
          name: 'P8 real Claude Code',
          screenshot: 'p8-android-real-claude.png'
        },
        {
          adapterId: 'codex',
          name: 'P8 real Codex',
          screenshot: 'p8-android-real-codex.png'
        }
      ] as const
      const sessions = []
      for (const target of targets) {
        sessions.push({
          ...target,
          ...(await launchSession(hrackPage, target.name, target.adapterId))
        })
      }

      await hrackPage.evaluate(
        (workspace) => window.remoteApi.setRecentWorkspaces([workspace]),
        process.cwd()
      )
      await connectHrack(hrackPage, joinUrl)

      await adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0')
      await adb('shell', 'settings', 'put', 'system', 'user_rotation', '0')
      await startAndroid()
      await pairAndroid(joinUrl)
      await waitForUi(
        (xml) => sessions.every((session) => xml.includes(session.name)),
        'real Claude Code and Codex session list',
        60_000
      )

      for (const session of sessions) {
        await tapResource(`session-${session.sessionId}`)
        const initialXml = await waitForUi(
          (xml) =>
            xml.includes('手机正在控制这一个终端') && terminalMetrics(xml) !== null,
          `${session.adapterId} driven terminal`,
          60_000
        )
        const initial = terminalMetrics(initialXml)
        if (!initial) throw new Error(`missing ${session.adapterId} metrics`)
        expect(initial.renderer).toBe('DOM')
        expect(initial.parsedBytes).toBeGreaterThan(0)
        await expect
          .poll(() => hrackPage.evaluate(() => window.remoteApi.getDriveState()))
          .toMatchObject({ phase: 'driven', sessionId: session.sessionId })

        await tapResource('terminal-command-input')
        await adb('shell', 'input', 'text', '/help')
        await waitForUi((xml) => xml.includes('/help'), `${session.adapterId} help draft`)
        await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
        await tapResource('terminal-command-send')
        await waitForUi(
          (xml) => {
            const metrics = terminalMetrics(xml)
            return !!metrics && metrics.parsedBytes > initial.parsedBytes
          },
          `${session.adapterId} help output parsed`,
          60_000
        )
        await screenshot(testInfo, session.screenshot)

        await tapResource('terminal-back')
        await waitForUi(
          (xml) =>
            boundsFor(xml, 'sessions-create') !== null &&
            sessions.every((candidate) => xml.includes(candidate.name)),
          `${session.adapterId} returned to list`
        )
        await expect
          .poll(() => hrackPage.evaluate(() => window.remoteApi.getDriveState()))
          .toMatchObject({ phase: 'idle', sessionId: null })
      }

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
      await adb('shell', 'settings', 'put', 'system', 'user_rotation', '0').catch(
        () => {}
      )
      await adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '1').catch(
        () => {}
      )
    }
  })
})

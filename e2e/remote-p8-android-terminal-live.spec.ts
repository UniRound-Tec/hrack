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
const chineseImeDriver = process.env.HRACK_REMOTE_P8_CHINESE_IME ?? ''
if (chineseImeDriver && !['gboard', 'fcitx5'].includes(chineseImeDriver)) {
  throw new Error('HRACK_REMOTE_P8_CHINESE_IME must be gboard or fcitx5')
}
const chineseImeGate =
  chineseImeDriver === 'gboard' || chineseImeDriver === 'fcitx5'
const gboardIme =
  'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME'
const fcitx5Ime = 'org.fcitx.fcitx5.android/.input.FcitxInputMethodService'
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

function textForResource(xml: string, resourceId: string): string | null {
  const node = xml.match(
    new RegExp(`<node[^>]*resource-id="${quoteRegex(resourceId)}"[^>]*>`)
  )?.[0]
  return node?.match(/\btext="([^"]*)"/)?.[1] ?? null
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

async function isImeShown(): Promise<boolean> {
  const state = await adb('shell', 'dumpsys', 'input_method')
  return /mInputShown=true/.test(state)
}

async function ensureGboardSubtype(
  name: 'English (US)' | '简体中文 (拼音)',
  locale: 'en_US' | 'zh_CN'
): Promise<void> {
  const methods = await adb('shell', 'ime', 'list', '-a')
  const subtype = methods.match(
    new RegExp(
      `mSubtypeNameOverride=${quoteRegex(name)}[\\s\\S]{0,300}?mSubtypeId=(\\d+)[\\s\\S]{0,300}?mSubtypeLocale=${locale}`
    )
  )
  if (!subtype) throw new Error(`Gboard ${name} is not installed`)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const selected = (
      await adb(
        'shell',
        'settings',
        'get',
        'secure',
        'selected_input_method_subtype'
      )
    ).trim()
    if (selected === subtype[1]) return
    await adb('shell', 'input', 'keyevent', 'KEYCODE_LANGUAGE_SWITCH')
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  throw new Error(`failed to select Gboard ${name}`)
}

async function ensureEnglishUsSubtype(): Promise<void> {
  await ensureGboardSubtype('English (US)', 'en_US')
}

async function ensureChinesePinyinSubtype(): Promise<void> {
  await ensureGboardSubtype('简体中文 (拼音)', 'zh_CN')
}

async function selectIme(ime: string): Promise<void> {
  const result = await adb('shell', 'ime', 'set', ime)
  if (!result.includes('selected'))
    throw new Error(`failed to select IME: ${ime}`)
  await new Promise((resolveWait) => setTimeout(resolveWait, 700))
}

async function selectChineseIme(): Promise<void> {
  if (chineseImeDriver === 'fcitx5') {
    await selectIme(fcitx5Ime)
    return
  }
  await ensureChinesePinyinSubtype()
}

async function tapPinyinKeyboard(value: 'zhongwen'): Promise<void> {
  const size = await adb('shell', 'wm', 'size')
  if (!size.includes('1080x2400')) {
    throw new Error('Chinese IME gate requires the 1080x2400 Pixel 6 AVD')
  }
  const keys: Record<string, [number, number]> = {
    z: [217, 2022],
    h: [648, 1860],
    o: [918, 1715],
    n: [756, 2022],
    g: [540, 1860],
    w: [163, 1715],
    e: [270, 1715]
  }
  for (const character of value) {
    const point = keys[character]
    if (!point)
      throw new Error(`missing Pinyin keyboard coordinate for ${character}`)
    await adb('shell', 'input', 'tap', String(point[0]), String(point[1]))
  }
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
  if (chineseImeGate) await selectIme(gboardIme)
  await tapResource('pairing-manual-toggle')
  await tapResource('pairing-url')
  if (chineseImeGate) await ensureEnglishUsSubtype()
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
  adapterId = 'codex',
  args = ''
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
  if (args) await page.getByTestId('cli-arguments').fill(args)
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
    test.skip(
      process.platform !== 'win32',
      'current Android/Electron gate is Windows'
    )
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

      await adb(
        'shell',
        'settings',
        'put',
        'system',
        'accelerometer_rotation',
        '0'
      )
      await adb('shell', 'settings', 'put', 'system', 'user_rotation', '0')
      await startAndroid()
      await pairAndroid(joinUrl)
      await waitForUi(
        (xml) =>
          xml.includes(sessionName) &&
          boundsFor(xml, 'sessions-create') !== null,
        'real session list'
      )
      await tapResource(`session-${existing.sessionId}`)
      const portraitXml = await waitForUi(
        (xml) =>
          xml.includes('手机正在控制这一个终端') &&
          terminalMetrics(xml) !== null,
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
      await expect.poll(isImeShown, { timeout: 15_000 }).toBe(true)
      const keyboardXml = await waitForUi((xml) => {
        const metrics = terminalMetrics(xml)
        return (
          !!metrics &&
          metrics.cols === portrait.cols &&
          metrics.rows < portrait.rows
        )
      }, 'terminal resized above the Android soft keyboard')
      const keyboard = terminalMetrics(keyboardXml)
      if (!keyboard) throw new Error('missing soft-keyboard terminal metrics')
      await expect
        .poll(() => hrackPage.evaluate(() => window.remoteApi.getDriveState()))
        .toMatchObject({
          phase: 'driven',
          sessionId: existing.sessionId,
          cols: keyboard.cols,
          rows: keyboard.rows
        })
      await adb('shell', 'input', 'text', `echo%s${inputMarker}`)
      await waitForUi(
        (xml) => xml.includes(inputMarker),
        'committed native terminal command'
      )
      if (chineseImeGate) {
        await adb('shell', 'input', 'text', '%s')
        await selectChineseIme()
        await tapPinyinKeyboard('zhongwen')
        await screenshot(testInfo, 'p8-android-terminal-chinese-probe.png')
        if (chineseImeDriver === 'fcitx5') {
          const composingXml = await dumpUi()
          expect(
            textForResource(composingXml, 'terminal-command-input') ?? ''
          ).not.toContain('zhongwen')
        } else {
          await waitForUi(
            (xml) =>
              textForResource(xml, 'terminal-command-input')?.includes(
                'zhongwen'
              ) === true,
            'Chinese IME composing pinyin in the native draft'
          )
        }
        expect(await historyText(hrackPage, existing.ptyId)).not.toContain(
          'zhongwen'
        )
        await screenshot(testInfo, 'p8-android-terminal-chinese-composing.png')
        await adb(
          'shell',
          'input',
          'tap',
          '150',
          chineseImeDriver === 'fcitx5' ? '1500' : '1580'
        )
        await waitForUi(
          (xml) =>
            textForResource(xml, 'terminal-command-input')?.includes('中文') ===
            true,
          'Chinese IME committed a candidate to the native draft'
        )
        await screenshot(testInfo, 'p8-android-terminal-chinese-committed.png')
      }
      await screenshot(testInfo, 'p8-android-terminal-soft-keyboard.png')
      await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
      await expect.poll(isImeShown, { timeout: 15_000 }).toBe(false)
      const restoredXml = await waitForUi((xml) => {
        const metrics = terminalMetrics(xml)
        return (
          !!metrics &&
          metrics.cols === portrait.cols &&
          metrics.rows > keyboard.rows &&
          metrics.rows >= portrait.rows - 1
        )
      }, 'terminal restored after the Android soft keyboard closed')
      const restored = terminalMetrics(restoredXml)
      if (!restored) throw new Error('missing restored terminal metrics')
      console.log(
        `[p8-terminal-keyboard] portrait=${portrait.cols}x${portrait.rows} keyboard=${keyboard.cols}x${keyboard.rows} restored=${restored.cols}x${restored.rows}`
      )
      await expect
        .poll(() => hrackPage.evaluate(() => window.remoteApi.getDriveState()))
        .toMatchObject({
          phase: 'driven',
          sessionId: existing.sessionId,
          cols: restored.cols,
          rows: restored.rows
        })
      await screenshot(testInfo, 'p8-android-terminal-keyboard-restored.png')
      await tapResource('terminal-command-send')
      await expect
        .poll(() => historyText(hrackPage, existing.ptyId), { timeout: 30_000 })
        .toContain(inputMarker)
      if (chineseImeGate) {
        const committedHistory = await historyText(hrackPage, existing.ptyId)
        expect(committedHistory).toContain('中文')
        expect(committedHistory).not.toContain('zhongwen')
      }
      const parsedAfterInput = await waitForUi((xml) => {
        const metrics = terminalMetrics(xml)
        return !!metrics && metrics.parsedBytes > portrait.parsedBytes
      }, 'WebView parsed and acked live PTY output')
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
      if (!afterBurst)
        throw new Error('missing terminal metrics after PTY burst')
      console.log(
        `[p8-terminal-burst] renderer=${afterBurst.renderer} bytes=${afterBurst.parsedBytes - beforeBurst} elapsedMs=${Date.now() - burstStartedAt}`
      )

      await adb('shell', 'settings', 'put', 'system', 'user_rotation', '1')
      const landscapeXml = await waitForUi((xml) => {
        const metrics = terminalMetrics(xml)
        return (
          !!metrics &&
          (metrics.cols !== portrait.cols || metrics.rows !== portrait.rows)
        )
      }, 'landscape terminal resize')
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
        (xml) =>
          xml.includes(sessionName) &&
          boundsFor(xml, 'sessions-create') !== null,
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
          xml.includes('手机正在控制这一个终端') &&
          terminalMetrics(xml) !== null,
        'newly created measured terminal'
      )
      const createdMetrics = terminalMetrics(await dumpUi())
      if (!createdMetrics) throw new Error('missing created terminal metrics')
      const created = await hrackPage.evaluate(async (firstSessionId) => {
        const sessions = await window.agentApi.listActive()
        const next = sessions.find(
          (session) => session.sessionId !== firstSessionId
        )
        if (!next) return null
        const pty = (await window.ptyApi.listRecoverable()).find(
          (candidate) => candidate.terminalId === next.terminalId
        )
        return pty
          ? {
              sessionId: next.sessionId,
              terminalId: next.terminalId,
              ptyId: pty.ptyId
            }
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
      await adb(
        'shell',
        'settings',
        'put',
        'system',
        'user_rotation',
        '0'
      ).catch(() => {})
      await adb(
        'shell',
        'settings',
        'put',
        'system',
        'accelerometer_rotation',
        '1'
      ).catch(() => {})
    }
  })

  test('renders real Claude Code and Codex TUIs through the installed App', async ({
    page: relayPage
  }, testInfo) => {
    test.skip(
      process.platform !== 'win32',
      'current Android/Electron gate is Windows'
    )
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
          screenshot: 'p8-android-real-claude.png',
          helpEvidence: 'For more help: https://code.claude.co',
          localCommand: '/help',
          args: ''
        },
        {
          adapterId: 'codex',
          name: 'P8 real Codex',
          screenshot: 'p8-android-real-codex.png',
          helpEvidence: '/status',
          localCommand: '/status',
          args: '-c check_for_update_on_startup=false'
        }
      ] as const
      const sessions = []
      for (const target of targets) {
        sessions.push({
          ...target,
          ...(await launchSession(
            hrackPage,
            target.name,
            target.adapterId,
            target.args
          ))
        })
      }

      await hrackPage.evaluate(
        (workspace) => window.remoteApi.setRecentWorkspaces([workspace]),
        process.cwd()
      )
      await connectHrack(hrackPage, joinUrl)

      await adb(
        'shell',
        'settings',
        'put',
        'system',
        'accelerometer_rotation',
        '0'
      )
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
            xml.includes('手机正在控制这一个终端') &&
            terminalMetrics(xml) !== null,
          `${session.adapterId} driven terminal`,
          60_000
        )
        const initial = terminalMetrics(initialXml)
        if (!initial) throw new Error(`missing ${session.adapterId} metrics`)
        expect(initial.renderer).toBe('DOM')
        expect(initial.parsedBytes).toBeGreaterThan(0)
        await expect
          .poll(() =>
            hrackPage.evaluate(() => window.remoteApi.getDriveState())
          )
          .toMatchObject({ phase: 'driven', sessionId: session.sessionId })

        await tapResource('terminal-command-input')
        await adb('shell', 'input', 'text', session.localCommand)
        await waitForUi(
          (xml) => xml.includes(session.localCommand),
          `${session.adapterId} local command draft`
        )
        await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
        await tapResource('terminal-command-send')
        await expect
          .poll(() => historyText(hrackPage, session.ptyId), {
            timeout: 60_000
          })
          .toContain(session.helpEvidence)
        await waitForUi(
          (xml) => {
            const metrics = terminalMetrics(xml)
            return !!metrics && metrics.parsedBytes > initial.parsedBytes
          },
          `${session.adapterId} local command output parsed`,
          60_000
        )
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_500))
        await screenshot(testInfo, session.screenshot)

        await tapResource('terminal-back')
        await waitForUi(
          (xml) =>
            boundsFor(xml, 'sessions-create') !== null &&
            sessions.every((candidate) => xml.includes(candidate.name)),
          `${session.adapterId} returned to list`
        )
        await expect
          .poll(() =>
            hrackPage.evaluate(() => window.remoteApi.getDriveState())
          )
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
      await adb(
        'shell',
        'settings',
        'put',
        'system',
        'user_rotation',
        '0'
      ).catch(() => {})
      await adb(
        'shell',
        'settings',
        'put',
        'system',
        'accelerometer_rotation',
        '1'
      ).catch(() => {})
    }
  })
})

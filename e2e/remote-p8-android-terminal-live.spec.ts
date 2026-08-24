import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { promisify } from 'node:util'
import { PNG } from 'pngjs'
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
const providedJoinUrl = process.env.HRACK_REMOTE_P8_JOIN_URL
const accountCredentialFile =
  process.env.HRACK_REMOTE_P8_ACCOUNT_CREDENTIAL_FILE
const adbExecutable = process.env.HRACK_ANDROID_ADB
const appPackage =
  process.env.HRACK_ANDROID_APP_PACKAGE ?? 'app.modplex.hrack.remote'
const realAiTarget = process.env.HRACK_REMOTE_P8_REAL_AI_TARGET ?? ''
if (realAiTarget && !['claude', 'codex'].includes(realAiTarget)) {
  throw new Error('HRACK_REMOTE_P8_REAL_AI_TARGET must be claude or codex')
}
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

function resourceIsFocused(xml: string, resourceId: string): boolean {
  const node = xml.match(
    new RegExp(`<node[^>]*resource-id="${quoteRegex(resourceId)}"[^>]*>`)
  )?.[0]
  return node?.includes('focused="true"') === true
}

function resourceIsEnabled(xml: string, resourceId: string): boolean {
  const node = xml.match(
    new RegExp(`<node[^>]*resource-id="${quoteRegex(resourceId)}"[^>]*>`)
  )?.[0]
  return node?.includes('enabled="true"') === true
}

interface TerminalMetrics {
  renderer: string
  cols: number
  rows: number
  parsedBytes: number
}

function terminalMetrics(xml: string): TerminalMetrics | null {
  const match = xml.match(
    /text="(WEBGL|DOM) · (\d+) × (\d+) · (?:已解析\s*)?(\d+) B"/
  )
  if (!match) return null
  return {
    renderer: match[1],
    cols: Number(match[2]),
    rows: Number(match[3]),
    parsedBytes: Number(match[4])
  }
}

function preflightMetrics(xml: string): TerminalMetrics | null {
  const match = xml.match(/text="(\d+) × (\d+) cells"/)
  if (!match) return null
  return {
    renderer: 'unknown',
    cols: Number(match[1]),
    rows: Number(match[2]),
    parsedBytes: 0
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

async function expandTerminalHud(label: string): Promise<string> {
  await waitForUi(
    (xml) => boundsFor(xml, 'terminal-hud-details') !== null,
    `${label} HUD`
  )
  await tapResource('terminal-hud-details')
  return waitForUi(
    (xml) => terminalMetrics(xml) !== null,
    `${label} metrics`
  )
}

async function longPressResource(resourceId: string): Promise<void> {
  const xml = await waitForUi(
    (candidate) => boundsFor(candidate, resourceId) !== null,
    resourceId
  )
  const point = boundsFor(xml, resourceId)
  if (!point) throw new Error(`Android resource disappeared: ${resourceId}`)
  await adb(
    'shell',
    'input',
    'swipe',
    String(point[0]),
    String(point[1]),
    String(point[0]),
    String(point[1]),
    '900'
  )
}

async function screenshot(testInfo: TestInfo, name: string): Promise<string> {
  const remotePath = `/sdcard/${name}`
  const localPath = testInfo.outputPath(name)
  await adb('shell', 'screencap', '-p', remotePath)
  await adb('pull', remotePath, localPath)
  return localPath
}

function terminalGlyphGeometry(path: string): {
  components: number
  tallRatio: number
} {
  const image = PNG.sync.read(readFileSync(path))
  const minX = Math.floor(image.width * 0.04)
  const maxX = Math.ceil(image.width * 0.96)
  const minY = Math.floor(image.height * 0.15)
  const maxY = Math.ceil(image.height * 0.83)
  const seen = new Uint8Array(image.width * image.height)
  const heights: number[] = []

  const isTextPixel = (offset: number): boolean => {
    const pixel = offset * 4
    return (
      image.data[pixel] >= 145 &&
      image.data[pixel + 1] >= 145 &&
      image.data[pixel + 2] >= 145
    )
  }

  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      const start = y * image.width + x
      if (seen[start] || !isTextPixel(start)) continue
      const stack = [start]
      seen[start] = 1
      let pixels = 0
      let left = x
      let right = x
      let top = y
      let bottom = y
      while (stack.length > 0) {
        const current = stack.pop()
        if (current === undefined) break
        const currentY = Math.floor(current / image.width)
        const currentX = current - currentY * image.width
        pixels += 1
        left = Math.min(left, currentX)
        right = Math.max(right, currentX)
        top = Math.min(top, currentY)
        bottom = Math.max(bottom, currentY)
        for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
          for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
            if (deltaX === 0 && deltaY === 0) continue
            const nextX = currentX + deltaX
            const nextY = currentY + deltaY
            if (
              nextX < minX ||
              nextX >= maxX ||
              nextY < minY ||
              nextY >= maxY
            ) {
              continue
            }
            const next = nextY * image.width + nextX
            if (seen[next] || !isTextPixel(next)) continue
            seen[next] = 1
            stack.push(next)
          }
        }
      }
      const width = right - left + 1
      const height = bottom - top + 1
      if (pixels >= 3 && pixels < 500 && width < 80 && height < 80) {
        heights.push(height)
      }
    }
  }

  return {
    components: heights.length,
    tallRatio:
      heights.length === 0
        ? 0
        : heights.filter((height) => height >= 20).length / heights.length
  }
}

async function isImeShown(): Promise<boolean> {
  const state = await adb('shell', 'dumpsys', 'input_method')
  return /mInputShown=true/.test(state)
}

async function enableSoftKeyboardWithHardwareKeyboard(): Promise<void> {
  await adb(
    'shell',
    'settings',
    'put',
    'secure',
    'stylus_handwriting_enabled',
    '0'
  )
  await adb(
    'shell',
    'settings',
    'put',
    'secure',
    'show_ime_with_hard_keyboard',
    '1'
  )
  const enabled = await adb(
    'shell',
    'settings',
    'get',
    'secure',
    'show_ime_with_hard_keyboard'
  )
  if (enabled.trim() !== '1') {
    throw new Error('Android soft keyboard is disabled for hardware input')
  }
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
  await new Promise((resolveWait) => setTimeout(resolveWait, 700))
  for (const character of value) {
    const point = keys[character]
    if (!point)
      throw new Error(`missing Pinyin keyboard coordinate for ${character}`)
    await adb('shell', 'input', 'tap', String(point[0]), String(point[1]))
    await new Promise((resolveWait) => setTimeout(resolveWait, 120))
  }
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

async function pairAndroid(joinUrl: string): Promise<void> {
  if (chineseImeGate) await selectIme(gboardIme)
  await tapResource('pairing-manual-toggle')
  await tapResource('pairing-url')
  if (chineseImeGate) await ensureEnglishUsSubtype()
  try {
    for (const chunk of joinUrl.match(/.{1,12}/g) ?? []) {
      const shellQuotedChunk = `'${chunk.replace(/'/g, `'\\''`)}'`
      await adb('shell', 'input', 'text', shellQuotedChunk)
      await new Promise((resolveWait) => setTimeout(resolveWait, 120))
    }
  } catch {
    throw new Error('Android failed to enter the pairing URL')
  }
  if (await isImeShown()) {
    await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    await expect.poll(isImeShown, { timeout: 8_000 }).toBe(false)
  }
  const pairingUi = await dumpUi()
  if (boundsFor(pairingUi, 'pairing-connect') === null) {
    // Re-focus the always-visible URL field when an IME delivers Back to the
    // Activity after dismissing itself. The URL remains in React state.
    await tapResource('pairing-manual-toggle')
  }
  await waitForUi(
    (xml) =>
      textForResource(xml, 'pairing-url') === joinUrl &&
      resourceIsEnabled(xml, 'pairing-connect'),
    'complete pairing URL and enabled connect button',
    8_000
  )
  await tapResource('pairing-connect')
}

async function connectHrack(page: Page, joinUrl: string): Promise<void> {
  await page.evaluate(() => window.__hrackDebugShell?.navigate('settings'))
  await page.getByTestId('settings-category-remote').click()
  await page.getByTestId('settings-remote-url').fill(joinUrl)
  await page.getByTestId('settings-remote-connect').click()
  await page.getByTestId('settings-remote-confirm-accept').click()
  await expect
    .poll(() =>
      page
        .getByTestId('settings-remote-status')
        .getAttribute('data-remote-phase')
    )
    .toMatch(/^(waiting-phone|peer-online)$/)
}

async function getAccountPairingUrl(
  page: Page,
  baseUrl: string
): Promise<string> {
  if (!accountCredentialFile) {
    throw new Error('account credential file is not configured')
  }
  const credential = JSON.parse(
    readFileSync(accountCredentialFile, 'utf8')
  ) as {
    email?: unknown
    password?: unknown
  }
  if (
    typeof credential.email !== 'string' ||
    typeof credential.password !== 'string'
  ) {
    throw new Error(
      'account credential file must contain email and password strings'
    )
  }

  const response = await page.goto(new URL('/auth', baseUrl).href)
  if (!response?.ok()) throw new Error('account login page did not load')
  await page.locator('input[name="email"]').fill(credential.email)
  await page.locator('input[name="password"]').fill(credential.password)
  await page.locator('form button[type="submit"]').click()
  await page.waitForURL((url) => url.pathname === '/dashboard')

  const pairingUrl = page.locator('section input[readonly]')
  if (!(await pairingUrl.isVisible().catch(() => false))) {
    await page.locator('section button[type="button"]').first().click()
  }
  await expect(pairingUrl).toBeVisible()
  return pairingUrl.inputValue()
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

test.describe('remote P8 Android terminal preflight layout', () => {
  test.skip(!adbExecutable, 'set HRACK_ANDROID_ADB for the installed App gate')

  test('refits both axes after rotation', async ({}, testInfo) => {
    test.skip(process.platform !== 'win32', 'current Android gate is Windows')
    test.setTimeout(45_000)
    try {
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
      await longPressResource('pairing-terminal-preflight')
      const portraitXml = await waitForUi(
        (xml) => preflightMetrics(xml) !== null,
        'portrait terminal preflight',
        12_000
      )
      const portrait = preflightMetrics(portraitXml)
      if (!portrait) throw new Error('missing portrait preflight metrics')

      await adb('shell', 'settings', 'put', 'system', 'user_rotation', '1')
      const landscapeXml = await waitForUi(
        (xml) => {
          const metrics = preflightMetrics(xml)
          return (
            !!metrics &&
            metrics.cols > portrait.cols &&
            metrics.rows < portrait.rows
          )
        },
        'stable landscape terminal preflight',
        12_000
      )
      const landscape = preflightMetrics(landscapeXml)
      if (!landscape) throw new Error('missing landscape preflight metrics')
      console.log(
        `[p8-terminal-preflight-rotation] portrait=${portrait.cols}x${portrait.rows} landscape=${landscape.cols}x${landscape.rows}`
      )
      await screenshot(testInfo, 'p8-android-preflight-landscape.png')
    } finally {
      await adb('shell', 'settings', 'put', 'system', 'user_rotation', '0').catch(
        () => {}
      )
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

test.describe('remote P8 Android terminal live relay', () => {
  test.skip(
    !targetUrl || !adbExecutable,
    'set HRACK_REMOTE_P8_URL and HRACK_ANDROID_ADB for the installed App gate'
  )

  test('refits a driven terminal on both axes after rotation', async ({
    page: relayPage
  }, testInfo) => {
    test.skip(
      process.platform !== 'win32',
      'current Android/Electron gate is Windows'
    )
    test.setTimeout(180_000)
    if (!targetUrl) throw new Error('missing live relay target')

    let app: ElectronApplication | undefined
    let roomCreated = false
    let roomRevoked = false
    try {
      let joinUrl: string
      if (providedJoinUrl) {
        const response = await relayPage.goto(targetUrl)
        if (!response?.ok()) throw new Error('relay target did not load')
        joinUrl = providedJoinUrl
      } else if (accountCredentialFile) {
        joinUrl = await getAccountPairingUrl(relayPage, targetUrl)
      } else {
        const response = await relayPage.goto(targetUrl)
        if (!response?.ok()) throw new Error('relay generate page did not load')
        await relayPage.getByTestId('create-room').click()
        await expect(relayPage.getByTestId('join-url')).toBeVisible()
        roomCreated = true
        joinUrl = await relayPage.getByTestId('join-url').innerText()
      }

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
      const sessionName = 'P8 rotation probe'
      const existing = await launchSession(hrackPage, sessionName)
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
      await enableSoftKeyboardWithHardwareKeyboard()
      await selectIme(gboardIme)
      await startAndroid()
      await pairAndroid(joinUrl)
      await waitForUi(
        (xml) =>
          xml.includes(sessionName) &&
          boundsFor(xml, 'sessions-create') !== null,
        'rotation probe session list'
      )
      await tapResource(`session-${existing.sessionId}`)
      const portraitXml = await expandTerminalHud('rotation probe portrait terminal')
      const portrait = terminalMetrics(portraitXml)
      if (!portrait) throw new Error('missing rotation probe portrait metrics')

      // A terminal tap is the primary mobile entry gesture. It must focus the
      // composition-safe native command draft and open the system IME.
      await tapResource('terminal-webview')
      await waitForUi(
        (xml) => resourceIsFocused(xml, 'terminal-command-input'),
        'terminal tap focused the native command input',
        5_000
      )
      await expect.poll(isImeShown, { timeout: 15_000 }).toBe(true)
      await screenshot(testInfo, 'p8-android-rotation-probe-ime.png')
      await waitForUi(
        (xml) => {
          const metrics = terminalMetrics(xml)
          return !!metrics && metrics.rows < portrait.rows
        },
        'rotation probe soft keyboard resize',
        12_000
      )
      await screenshot(testInfo, 'p8-android-rotation-probe-keyboard.png')
      await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
      await expect.poll(isImeShown, { timeout: 15_000 }).toBe(false)
      await waitForUi(
        (xml) => {
          const metrics = terminalMetrics(xml)
          return !!metrics && metrics.rows >= portrait.rows - 1
        },
        'rotation probe soft keyboard restore',
        12_000
      )

      await adb('shell', 'settings', 'put', 'system', 'user_rotation', '1')
      try {
        await waitForUi(
          (xml) => {
            const metrics = terminalMetrics(xml)
            return (
              !!metrics &&
              metrics.cols > portrait.cols &&
              metrics.rows < portrait.rows
            )
          },
          'stable driven landscape terminal',
          30_000
        )
      } catch (error) {
        const current = terminalMetrics(await dumpUi())
        console.log(
          `[p8-terminal-rotation-red] portrait=${portrait.cols}x${portrait.rows} current=${current?.cols ?? 0}x${current?.rows ?? 0}`
        )
        await screenshot(testInfo, 'p8-android-driven-landscape-red.png')
        throw error
      }
      const landscape = terminalMetrics(await dumpUi())
      if (!landscape) throw new Error('missing rotation probe landscape metrics')
      console.log(
        `[p8-terminal-rotation] portrait=${portrait.cols}x${portrait.rows} landscape=${landscape.cols}x${landscape.rows}`
      )

      if (roomCreated) {
        await relayPage.getByTestId('revoke-room').click()
        await expect(relayPage.getByTestId('status')).toHaveText(
          'Room revoked.'
        )
        roomRevoked = true
      }
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

  test('drives, types, resizes, releases and creates through the installed App', async ({
    page: relayPage
  }, testInfo) => {
    test.skip(
      process.platform !== 'win32',
      'current Android/Electron gate is Windows'
    )
    test.setTimeout(360_000)
    if (!targetUrl) throw new Error('missing live relay target')

    let app: ElectronApplication | undefined
    let roomCreated = false
    let roomRevoked = false
    try {
      let joinUrl: string
      if (providedJoinUrl) {
        const response = await relayPage.goto(targetUrl)
        if (!response?.ok()) throw new Error('relay target did not load')
        joinUrl = providedJoinUrl
      } else if (accountCredentialFile) {
        joinUrl = await getAccountPairingUrl(relayPage, targetUrl)
      } else {
        const response = await relayPage.goto(targetUrl)
        if (!response?.ok()) throw new Error('relay generate page did not load')
        await relayPage.getByTestId('create-room').click()
        await expect(relayPage.getByTestId('join-url')).toBeVisible()
        roomCreated = true
        joinUrl = await relayPage.getByTestId('join-url').innerText()
      }

      const launched = await launchApp({
        createDefaultTerminal: false,
        env: {
          HRACK_FIXTURE_OBSERVER: '1',
          HRACK_FIXTURE_OBSERVER_HOLD: '1',
          PATH: `${resolve(__dirname, 'fixtures/remote')}${delimiter}${process.env.PATH ?? ''}`,
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
      await enableSoftKeyboardWithHardwareKeyboard()
      await startAndroid()
      await pairAndroid(joinUrl)
      await waitForUi(
        (xml) =>
          xml.includes(sessionName) &&
          boundsFor(xml, 'sessions-create') !== null,
        'real session list'
      )
      await tapResource(`session-${existing.sessionId}`)
      const portraitXml = await expandTerminalHud(
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
      // The terminal surface is the primary mobile entry gesture. It must
      // focus the composition-safe native draft before accepting input.
      await tapResource('terminal-webview')
      await waitForUi(
        (xml) => resourceIsFocused(xml, 'terminal-command-input'),
        'terminal tap focused the native command input',
        5_000
      )
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

      await tapResource('terminal-command-input')
      await waitForUi(
        (xml) => resourceIsFocused(xml, 'terminal-command-input'),
        'control-key command input',
        5_000
      )
      await adb('shell', 'input', 'text', 'control-key-probe.cmd')
      await waitForUi(
        (xml) => xml.includes('control-key-probe.cmd'),
        'control-key command draft'
      )
      if (await isImeShown()) {
        await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
        await expect.poll(isImeShown, { timeout: 15_000 }).toBe(false)
      }
      await tapResource('terminal-command-send')
      await expect
        .poll(() => historyText(hrackPage, existing.ptyId), { timeout: 30_000 })
        .toContain('HRACK_REMOTE_KEY_PROBE_READY')
      await tapResource('terminal-key-esc')
      await expect
        .poll(() => historyText(hrackPage, existing.ptyId), { timeout: 30_000 })
        .toContain('HRACK_REMOTE_KEY_Escape')

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
      let landscape: TerminalMetrics | null = null
      await expect
        .poll(
          async () => {
            const metrics = terminalMetrics(await dumpUi().catch(() => ''))
            const drive = await hrackPage.evaluate(() =>
              window.remoteApi.getDriveState()
            )
            if (
              metrics &&
              metrics.cols > portrait.cols &&
              metrics.rows < portrait.rows &&
              drive.phase === 'driven' &&
              drive.sessionId === existing.sessionId &&
              drive.cols === metrics.cols &&
              drive.rows === metrics.rows
            ) {
              landscape = metrics
              return true
            }
            return false
          },
          { timeout: 30_000 }
        )
        .toBe(true)
      if (!landscape) throw new Error('missing stable landscape metrics')
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
      await expandTerminalHud('newly created measured terminal')
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

      if (roomCreated) {
        await relayPage.getByTestId('revoke-room').click()
        await expect(relayPage.getByTestId('status')).toHaveText(
          'Room revoked.'
        )
        roomRevoked = true
        await waitForUi((xml) => xml.includes('房间已经关闭'), 'room revoked')
      }
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
          startupScreenshot: 'p8-android-real-claude-startup.png',
          screenshot: 'p8-android-real-claude.png',
          helpEvidence: 'For more help: https://code.claude.co',
          localCommand: '/help',
          args: ''
        },
        {
          adapterId: 'codex',
          name: 'P8 real Codex',
          startupScreenshot: 'p8-android-real-codex-startup.png',
          screenshot: 'p8-android-real-codex.png',
          helpEvidence: '/status',
          localCommand: '/status',
          args: '-c check_for_update_on_startup=false'
        }
      ].filter((target) => !realAiTarget || target.adapterId === realAiTarget)
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
      await enableSoftKeyboardWithHardwareKeyboard()
      await startAndroid()
      await pairAndroid(joinUrl)
      await waitForUi(
        (xml) => sessions.every((session) => xml.includes(session.name)),
        'real Claude Code and Codex session list',
        60_000
      )

      for (const session of sessions) {
        await tapResource(`session-${session.sessionId}`)
        const initialXml = await expandTerminalHud(
          `${session.adapterId} driven terminal`
        )
        const initial = terminalMetrics(initialXml)
        if (!initial) throw new Error(`missing ${session.adapterId} metrics`)
        // Claude/Codex use box and block glyphs that xterm's DOM renderer
        // rasterizes through the font. On Android that visibly breaks the
        // cell grid, so the real-TUI gate must exercise WebGL custom glyphs.
        expect(initial.renderer).toBe('WEBGL')
        expect(initial.parsedBytes).toBeGreaterThan(0)
        await expect
          .poll(() =>
            hrackPage.evaluate(() => window.remoteApi.getDriveState())
          )
          .toMatchObject({ phase: 'driven', sessionId: session.sessionId })
        await new Promise((resolveWait) => setTimeout(resolveWait, 750))
        const startupScreenshotPath = await screenshot(
          testInfo,
          session.startupScreenshot
        )
        const startupGeometry = terminalGlyphGeometry(startupScreenshotPath)
        expect(
          startupGeometry.components,
          `${session.adapterId} startup did not contain enough terminal glyphs`
        ).toBeGreaterThan(50)
        expect(
          startupGeometry.tallRatio,
          `${session.adapterId} startup glyphs were vertically sliced in the final Android composition`
        ).toBeGreaterThan(0.7)

        await tapResource('terminal-command-input')
        await adb('shell', 'input', 'text', session.localCommand)
        await waitForUi(
          (xml) => xml.includes(session.localCommand),
          `${session.adapterId} local command draft`
        )
        await adb('shell', 'input', 'keyevent', 'KEYCODE_ESCAPE')
        await expect.poll(isImeShown, { timeout: 5_000 }).toBe(false)
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
        const screenshotPath = await screenshot(testInfo, session.screenshot)
        const geometry = terminalGlyphGeometry(screenshotPath)
        expect(
          geometry.components,
          `${session.adapterId} screenshot did not contain enough terminal glyphs`
        ).toBeGreaterThan(100)
        expect(
          geometry.tallRatio,
          `${session.adapterId} glyphs were vertically sliced in the final Android composition`
        ).toBeGreaterThan(0.7)

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

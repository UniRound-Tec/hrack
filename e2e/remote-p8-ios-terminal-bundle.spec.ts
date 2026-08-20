import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  chromium,
  expect,
  test,
  webkit,
  type BrowserName,
  type Page
} from '@playwright/test'
import { PNG } from 'pngjs'

const appRoot = process.env.HRACK_REMOTE_APP_ROOT

interface TerminalReadyMessage {
  type: 'ready'
  fontReady: boolean
  blockFixture: boolean
  cjkDoubleWidth: boolean
  renderer: 'webgl' | 'dom' | 'unknown'
  cols: number
  rows: number
}

interface NativeMessage {
  type?: unknown
  sessionId?: unknown
  deliveryId?: unknown
  byteLength?: unknown
  historyOutputBytes?: unknown
  data?: unknown
  kind?: unknown
  message?: unknown
}

function visibleTextMetrics(screenshot: Buffer): {
  bands: number
  maxInkX: number
} {
  const image = PNG.sync.read(screenshot)
  let bands = 0
  let insideBand = false
  let maxInkX = -1
  for (let y = 0; y < image.height; y += 1) {
    let inkPixels = 0
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4
      const red = image.data[offset]
      const green = image.data[offset + 1]
      const blue = image.data[offset + 2]
      if (red > 70 || green > 70 || blue > 70) {
        inkPixels += 1
        maxInkX = Math.max(maxInkX, x)
      }
    }
    const active = inkPixels >= 3
    if (active && !insideBand) bands += 1
    insideBand = active
  }
  return { bands, maxInkX }
}

async function nativeMessages(page: Page): Promise<NativeMessage[]> {
  return page.evaluate(() => {
    const messages = (
      window as typeof window & { __hrackNativeMessages?: unknown[] }
    ).__hrackNativeMessages
    return (messages ?? []) as NativeMessage[]
  })
}

async function installNativeBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const messages: unknown[] = []
    Object.defineProperty(window, '__hrackNativeMessages', {
      configurable: false,
      value: messages
    })
    Object.defineProperty(window, 'ReactNativeWebView', {
      configurable: false,
      value: {
        postMessage(value: string) {
          try {
            messages.push(JSON.parse(value))
          } catch {
            messages.push(value)
          }
        }
      }
    })
  })
}

async function runTerminalBundleGate(
  page: Page,
  browserName: BrowserName,
  screenshotPath: string
): Promise<void> {
  if (!appRoot) throw new Error('missing remote App root')
  const indexPath = resolve(
    appRoot,
    'assets',
    'hrack-terminal-ios',
    'index.html'
  )
  expect(existsSync(indexPath)).toBe(true)

  const networkRequests: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith('file:')) networkRequests.push(request.url())
  })
  await installNativeBridge(page)
  await page.goto(pathToFileURL(indexPath).href)

  await expect
    .poll(
      async () =>
        (await nativeMessages(page)).find(
          (message) => message.type === 'ready'
        ) ?? null,
      { timeout: 20_000 }
    )
    .not.toBeNull()

  const ready = (await nativeMessages(page)).find(
    (message) => message.type === 'ready'
  ) as unknown as TerminalReadyMessage
  expect(ready).toMatchObject({
    type: 'ready',
    fontReady: true,
    blockFixture: true,
    cjkDoubleWidth: true
  })
  expect(['webgl', 'dom']).toContain(ready.renderer)
  if (browserName === 'webkit') expect(ready.renderer).toBe('dom')
  expect(ready.cols).toBeGreaterThan(20)
  expect(ready.rows).toBeGreaterThan(10)

  const sessionId = `ios-${browserName}`
  const historyParts = [
    'history-one\r\n',
    'history-中文\r\n',
    'history-three\r\n'
  ]
  const historyBytes = historyParts.reduce(
    (total, value) => total + Buffer.byteLength(value),
    0
  )
  const liveText = 'live-终端-ready\r\n'
  const liveBytes = Buffer.from(liveText)
  const deliveryId = `${browserName}-live-one`

  await page.evaluate(
    ({
      deliveryId: targetDeliveryId,
      historyBytes: retainedOutputBytes,
      historyParts: parts,
      liveBase64,
      liveByteLength,
      sessionId: targetSessionId
    }) => {
      const terminal = (
        window as typeof window & {
          hrackTerminal?: { receive(command: unknown): void }
        }
      ).hrackTerminal
      if (!terminal) throw new Error('terminal bridge is unavailable')
      terminal.receive({
        type: 'open',
        sessionId: targetSessionId,
        cols: 48,
        rows: 18,
        history: {
          complete: true,
          retainedOutputBytes,
          droppedOutputBytes: 0,
          droppedEvents: 0,
          events: [
            {
              sequence: 30,
              kind: 'output',
              data: parts[2],
              byteLength: new TextEncoder().encode(parts[2]).byteLength
            },
            {
              sequence: 10,
              kind: 'output',
              data: parts[0],
              byteLength: new TextEncoder().encode(parts[0]).byteLength
            },
            {
              sequence: 20,
              kind: 'output',
              data: parts[1],
              byteLength: new TextEncoder().encode(parts[1]).byteLength
            }
          ]
        }
      })
      // This live output must remain queued behind the asynchronous history replay.
      terminal.receive({
        type: 'live',
        sessionId: targetSessionId,
        deliveryId: targetDeliveryId,
        data: liveBase64,
        byteLength: liveByteLength
      })
    },
    {
      deliveryId,
      historyBytes,
      historyParts,
      liveBase64: liveBytes.toString('base64'),
      liveByteLength: liveBytes.byteLength,
      sessionId
    }
  )

  await expect
    .poll(async () => {
      const messages = await nativeMessages(page)
      return {
        historyReady: messages.some(
          (message) =>
            message.type === 'history-ready' &&
            message.sessionId === sessionId
        ),
        liveParsed: messages.some(
          (message) =>
            message.type === 'parsed' && message.deliveryId === deliveryId
        )
      }
    })
    .toEqual({ historyReady: true, liveParsed: true })

  let messages = await nativeMessages(page)
  const historyReadyIndex = messages.findIndex(
    (message) =>
      message.type === 'history-ready' && message.sessionId === sessionId
  )
  const parsedIndex = messages.findIndex(
    (message) =>
      message.type === 'parsed' && message.deliveryId === deliveryId
  )
  expect(historyReadyIndex).toBeGreaterThan(-1)
  expect(parsedIndex).toBeGreaterThan(historyReadyIndex)
  expect(messages[historyReadyIndex]).toMatchObject({
    historyOutputBytes: historyBytes
  })
  expect(messages[parsedIndex]).toMatchObject({
    sessionId,
    deliveryId,
    byteLength: liveBytes.byteLength
  })
  expect(messages.some((message) => message.type === 'fatal')).toBe(false)

  await page.evaluate(() => {
    const terminal = (
      window as typeof window & {
        hrackTerminal?: { receive(command: unknown): void }
      }
    ).hrackTerminal
    terminal?.receive({ type: 'focus' })
  })
  await page.keyboard.type('ios-input')
  await page.keyboard.press('Enter')
  await expect
    .poll(async () =>
      (await nativeMessages(page))
        .filter(
          (message) =>
            message.type === 'input' && message.sessionId === sessionId
        )
        .map((message) => (typeof message.data === 'string' ? message.data : ''))
        .join('')
    )
    .toContain('ios-input\r')

  expect(networkRequests).toEqual([])
  const terminalScreenshot = await page.locator('#terminal').screenshot({
    path: screenshotPath
  })
  const textMetrics = visibleTextMetrics(terminalScreenshot)
  expect(textMetrics.bands).toBeGreaterThanOrEqual(4)
  // All four fixtures are shorter than 20 terminal cells. If xterm's hidden
  // 32-character WebKit font probe leaks into paint, it extends to ~268 px even
  // though the terminal buffer, DOM rows and native bridge are all correct.
  expect(textMetrics.maxInkX).toBeLessThan(200)

  await page.evaluate(() => {
    const terminal = (
      window as typeof window & {
        hrackTerminal?: { receive(command: unknown): void }
      }
    ).hrackTerminal
    terminal?.receive({ type: 'force-fallback' })
  })
  await expect
    .poll(async () =>
      (await nativeMessages(page)).some(
        (message) => message.type === 'renderer' && message.kind === 'dom'
      )
    )
    .toBe(true)
  messages = await nativeMessages(page)
  expect(messages.some((message) => message.type === 'fatal')).toBe(false)
  expect(networkRequests).toEqual([])
}

for (const browserName of ['chromium', 'webkit'] as const) {
  test.describe(`remote P8 iOS terminal bundle in ${browserName}`, () => {
    test.skip(
      !appRoot,
      'set HRACK_REMOTE_APP_ROOT to verify the generated iOS terminal asset'
    )

    test('runs the offline renderer and full native bridge', async ({}, testInfo) => {
      const browserType = browserName === 'webkit' ? webkit : chromium
      const browser = await browserType.launch()
      const page = await browser.newPage()
      try {
        await runTerminalBundleGate(
          page,
          browserName,
          testInfo.outputPath(`p8-ios-${browserName}-terminal.png`)
        )
      } finally {
        await browser.close()
      }
    })
  })
}

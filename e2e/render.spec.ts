import {
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { PNG } from 'pngjs'
import {
  dumpBuffer,
  forceResize,
  launchApp,
  openDefaultTerminal,
  scanSolidColor,
  typeInTerminal
} from './helpers'

type RendererKind = 'webgl' | 'dom'

let app: ElectronApplication
let page: Page

test.setTimeout(120_000)

async function tabIds(): Promise<string[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __vibingDebugTabs: { list(): string[] }
        }
      ).__vibingDebugTabs.list()
  )
}

async function rendererKind(tabId: string): Promise<RendererKind> {
  return page.evaluate(
    (id) =>
      (
        window as unknown as {
          __vibingDebugTabs: {
            forTab(tabId: string): { rendererKind(): RendererKind }
          }
        }
      ).__vibingDebugTabs.forTab(id).rendererKind(),
    tabId
  )
}

async function forceContextLoss(tabId: string): Promise<boolean> {
  return page.evaluate(
    (id) =>
      (
        window as unknown as {
          __vibingDebugTabs: {
            forTab(tabId: string): { forceContextLoss(): boolean }
          }
        }
      ).__vibingDebugTabs.forTab(id).forceContextLoss(),
    tabId
  )
}

async function rendererEvents(
  tabId: string
): Promise<Array<{ kind: RendererKind; reason: string }>> {
  return page.evaluate(
    (id) =>
      (
        window as unknown as {
          __vibingDebugTabs: {
            forTab(tabId: string): {
              rendererEvents(): Array<{
                kind: RendererKind
                reason: string
              }>
            }
          }
        }
      ).__vibingDebugTabs.forTab(id).rendererEvents(),
    tabId
  )
}

async function writeRenderFixture(data: string): Promise<void> {
  await page.evaluate(
    (value) =>
      (
        window as unknown as {
          __vibingDebug: { writeRenderFixture(data: string): Promise<void> }
        }
      ).__vibingDebug.writeRenderFixture(value),
    data
  )
}

async function suspendPtyRendering(): Promise<void> {
  await page.evaluate(() =>
    (
      window as unknown as {
        __vibingDebug: {
          setPtyRenderingSuspended(suspended: boolean): void
        }
      }
    ).__vibingDebug.setPtyRenderingSuspended(true)
  )
}

async function forceDomRenderer(): Promise<void> {
  await page.evaluate(() =>
    (
      window as unknown as {
        __vibingDebug: { forceDomRenderer(): void }
      }
    ).__vibingDebug.forceDomRenderer()
  )
}

function countDifferentPixels(left: Buffer, right: Buffer): number {
  const first = PNG.sync.read(left)
  const second = PNG.sync.read(right)
  expect(second.width).toBe(first.width)
  expect(second.height).toBe(first.height)
  let different = 0
  for (let index = 0; index < first.data.length; index += 4) {
    if (
      first.data[index] !== second.data[index] ||
      first.data[index + 1] !== second.data[index + 1] ||
      first.data[index + 2] !== second.data[index + 2] ||
      first.data[index + 3] !== second.data[index + 3]
    ) {
      different++
    }
  }
  return different
}

test.beforeEach(async () => {
  ;({ app, window: page } = await launchApp())
})

test.afterEach(async () => {
  if (page && !page.isClosed()) {
    await page
      .evaluate(() => {
        ;(
          window as unknown as {
            __vibingDebug?: { resetSettings?(): void }
          }
        ).__vibingDebug?.resetSettings?.()
      })
      .catch(() => {})
  }
  await app
    ?.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1)
    })
    .catch(() => {})
  await app?.close()
})

test('moves the single WebGL renderer to the active terminal tab', async () => {
  const [firstId] = await tabIds()
  await expect.poll(() => rendererKind(firstId)).toBe('webgl')

  await openDefaultTerminal(page)
  await expect.poll(async () => (await tabIds()).length).toBe(2)
  const [, secondId] = await tabIds()

  await expect.poll(() => rendererKind(firstId)).toBe('dom')
  await expect.poll(() => rendererKind(secondId)).toBe('webgl')

  await page.getByTestId('sidebar-terminal-item').first().click()
  await expect.poll(() => rendererKind(firstId)).toBe('webgl')
  await expect.poll(() => rendererKind(secondId)).toBe('dom')
})

test('falls back to DOM after real context loss and retries after tab reactivation', async () => {
  const [firstId] = await tabIds()
  const beforeToken = `BEFORE_CONTEXT_LOSS_${Date.now()}`
  const afterToken = `AFTER_CONTEXT_LOSS_${Date.now()}`

  await expect.poll(() => rendererKind(firstId)).toBe('webgl')
  await typeInTerminal(page, `Write-Output "${beforeToken}"`)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await dumpBuffer(page)).join('\n'))
    .toContain(beforeToken)

  expect(await forceContextLoss(firstId)).toBe(true)
  await expect.poll(() => rendererKind(firstId)).toBe('dom')
  await expect
    .poll(async () => (await rendererEvents(firstId)).at(-1)?.reason)
    .toBe('context-loss')

  await typeInTerminal(page, `Write-Output "${afterToken}"`)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await dumpBuffer(page)).join('\n'))
    .toContain(afterToken)
  expect((await dumpBuffer(page)).join('\n')).toContain(beforeToken)

  await openDefaultTerminal(page)
  await expect.poll(() => rendererKind(firstId)).toBe('dom')
  await page.getByTestId('sidebar-terminal-item').first().click()
  await expect.poll(() => rendererKind(firstId)).toBe('webgl')
  expect((await dumpBuffer(page)).join('\n')).toContain(beforeToken)
  expect((await dumpBuffer(page)).join('\n')).toContain(afterToken)
})

for (const zoom of [1, 1.25, 0.8]) {
  test(`renders a seamless upper-half-block stripe at ${zoom * 100}% zoom`, async () => {
    await expect
      .poll(async () => (await dumpBuffer(page)).join('\n'))
      .toContain('PS ')
    await app.evaluate(
      ({ BrowserWindow }, factor) =>
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor),
      zoom
    )
    await page.waitForTimeout(350)
    await forceResize(page)
    await page.waitForTimeout(150)

    const [tabId] = await tabIds()
    await expect.poll(() => rendererKind(tabId)).toBe('webgl')
    await suspendPtyRendering()
    await writeRenderFixture(
      '\x1b[2J\x1b[4;1H\x1b[38;2;22;27;34m\x1b[48;2;13;17;23m' +
        '▀'.repeat(50) +
        '\x1b[48;2;7;8;9m' +
        ' '.repeat(50) +
        '\x1b[5;1H\x1b[48;2;51;68;85m' +
        ' '.repeat(50) +
        '\x1b[48;2;7;8;9m' +
        ' '.repeat(50) +
        '\x1b[0m'
    )
    await page.waitForTimeout(100)

    const screenshot = await page
      .locator('.xterm:visible .xterm-screen')
      .screenshot()
    const foreground = scanSolidColor(screenshot, [22, 27, 34])
    const referenceBand = scanSolidColor(screenshot, [51, 68, 85])

    expect(foreground.matchingPixels).toBeGreaterThan(1_000)
    expect(referenceBand.longestHorizontalRun).toBeGreaterThan(100)
    expect(foreground.longestHorizontalRun).toBe(
      referenceBand.longestHorizontalRun
    )
  })
}

test('keeps the terminal functional when WebGL falls back to DOM', async () => {
  const [tabId] = await tabIds()
  const token = `DOM_FALLBACK_OK_${Date.now()}`
  await expect.poll(() => rendererKind(tabId)).toBe('webgl')

  await forceDomRenderer()
  await expect.poll(() => rendererKind(tabId)).toBe('dom')
  await typeInTerminal(page, `Write-Output "${token}"`)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await dumpBuffer(page)).join('\n'))
    .toContain(token)

  await suspendPtyRendering()
  await writeRenderFixture(
    '\x1b[2J\x1b[4;1H\x1b[38;2;22;27;34m\x1b[48;2;13;17;23m' +
      '▀'.repeat(50) +
      '\x1b[0m'
  )
  const screenshot = await page
    .locator('.xterm:visible .xterm-screen')
    .screenshot()
  expect(scanSolidColor(screenshot, [22, 27, 34]).matchingPixels).toBeGreaterThan(
    100
  )
})

test('keeps WebGL functional after its grid is resized', async () => {
  const [tabId] = await tabIds()
  await expect.poll(() => rendererKind(tabId)).toBe('webgl')
  await suspendPtyRendering()
  await writeRenderFixture(
    '\x1b[2J\x1b[H\x1b[?25l' +
      Array.from({ length: 80 }, () => 'RESIZE-FLICKER '.repeat(20)).join(
        '\r\n'
      )
  )
  await page.waitForTimeout(100)

  const resized = await page.evaluate(() => {
    const debug = (
      window as unknown as {
        __vibingDebug: {
          setSize(cols: number, rows: number): void
          snapshot(): { cols: number; rows: number } | null
          rendererKind(): string
        }
      }
    ).__vibingDebug
    debug.setSize(70, 30)
    debug.setSize(120, 30)
    const canvas = Array.from(
      document.querySelectorAll<HTMLCanvasElement>('.xterm-screen canvas')
    ).find((candidate) => candidate.getContext('webgl2') !== null)
    return {
      snapshot: debug.snapshot(),
      renderer: debug.rendererKind(),
      canvasWidth: canvas?.width ?? 0,
      canvasHeight: canvas?.height ?? 0
    }
  })

  expect(resized).toMatchObject({
    snapshot: { cols: 120, rows: 30 },
    renderer: 'webgl'
  })
  expect(resized.canvasWidth).toBeGreaterThan(0)
  expect(resized.canvasHeight).toBeGreaterThan(0)
})

test('persists the light terminal theme while GUI uses semantic light tokens', async () => {
  await page.evaluate(() =>
    (
      window as unknown as {
        __vibingDebug: { setTheme(themeId: 'light'): void }
      }
    ).__vibingDebug.setTheme('light')
  )

  const appearance = async () =>
    page.evaluate(() => {
      const debug = (
        window as unknown as {
          __vibingDebug: {
            terminalAppearance(): {
              theme: { background?: string; foreground?: string }
            }
          }
        }
      ).__vibingDebug.terminalAppearance()
      const root = getComputedStyle(document.documentElement)
      return {
        ...debug,
        uiTheme: document.documentElement.dataset.uiTheme,
        appBackground: root.getPropertyValue('--vib-bg-app').trim(),
        tabBarBackground: root.getPropertyValue('--vib-bg-surface-strong').trim()
      }
    })

  await expect.poll(appearance).toMatchObject({
    theme: { background: '#f6f8fa', foreground: '#24292f' },
    uiTheme: 'light',
    appBackground: '#ffffff',
    tabBarBackground: '#f5f5f5'
  })

  await app.close()
  ;({ app, window: page } = await launchApp())
  await expect.poll(appearance).toMatchObject({
    theme: { background: '#f6f8fa', foreground: '#24292f' },
    uiTheme: 'light',
    appBackground: '#ffffff',
    tabBarBackground: '#f5f5f5'
  })
})

test('refits only the active terminal immediately after a font change', async () => {
  await openDefaultTerminal(page)
  const [hiddenId, activeId] = await tabIds()
  await page.waitForTimeout(500)

  const resizeCount = async (tabId: string) =>
    page.evaluate(
      async (id) => {
        const history = await (
          window as unknown as {
            __vibingDebugTabs: {
              forTab(tabId: string): {
                dumpAuthoritativeHistory(): Promise<{
                  events: Array<{ kind: string }>
                } | null>
              }
            }
          }
        ).__vibingDebugTabs.forTab(id).dumpAuthoritativeHistory()
        return (
          history?.events.filter((event) => event.kind === 'resize').length ?? 0
        )
      },
      tabId
    )

  const hiddenBefore = await resizeCount(hiddenId)
  const activeBefore = await resizeCount(activeId)
  const activeSizeBefore = await page.evaluate(
    (id) =>
      (
        window as unknown as {
          __vibingDebugTabs: {
            forTab(tabId: string): {
              snapshot(): { cols: number; rows: number } | null
            }
          }
        }
      ).__vibingDebugTabs.forTab(id).snapshot(),
    activeId
  )

  await page.evaluate(() =>
    (
      window as unknown as {
        __vibingDebug: {
          setFont(fontFamily: string, fontSize: number): void
        }
      }
    ).__vibingDebug.setFont(
      'Cascadia Mono, Consolas, monospace',
      22
    )
  )

  await expect.poll(() => resizeCount(activeId)).toBe(activeBefore + 1)
  expect(await resizeCount(hiddenId)).toBe(hiddenBefore)
  const activeSizeAfter = await page.evaluate(
    (id) =>
      (
        window as unknown as {
          __vibingDebugTabs: {
            forTab(tabId: string): {
              snapshot(): { cols: number; rows: number } | null
            }
          }
        }
      ).__vibingDebugTabs.forTab(id).snapshot(),
    activeId
  )
  expect(activeSizeAfter?.cols).toBeLessThan(activeSizeBefore?.cols ?? 0)

  await page.getByTestId('sidebar-terminal-item').first().click()
  await expect.poll(() => resizeCount(hiddenId)).toBe(hiddenBefore + 1)
})

test('loads bundled Maple Mono, shapes ligatures, and keeps terminal text exact', async () => {
  const [tabId] = await tabIds()
  await expect.poll(() => rendererKind(tabId)).toBe('webgl')
  await suspendPtyRendering()

  const fontState = await page.evaluate(async () => {
    await document.fonts.ready
    const debug = (
      window as unknown as {
        __vibingDebug: {
          terminalAppearance(): {
            fontFamily: string
            fontSize: number
            ligatures: boolean
          }
          ligatureRanges(text: string): Array<[number, number]>
        }
      }
    ).__vibingDebug
    return {
      loaded: document.fonts.check('400 16px "Maple Mono"'),
      appearance: debug.terminalAppearance(),
      ranges: debug.ligatureRanges('a => b [TODO] c')
    }
  })
  expect(fontState.loaded).toBe(true)
  expect(fontState.appearance).toMatchObject({
    fontSize: 16,
    ligatures: true
  })
  expect(fontState.appearance.fontFamily).toContain('"Maple Mono"')
  expect(fontState.appearance.fontFamily).toContain('"Microsoft JhengHei UI"')
  expect(fontState.appearance.fontFamily).toContain('"PingFang TC"')
  expect(fontState.appearance.fontFamily).toContain(
    '"Noto Sans Mono CJK TC"'
  )
  expect(fontState.ranges).toEqual([
    [2, 4],
    [7, 13]
  ])

  await page.evaluate(() =>
    (
      window as unknown as {
        __vibingDebug: { setLigatures(enabled: boolean): void }
      }
    ).__vibingDebug.setLigatures(false)
  )
  const fixture = '=== != -> => <=> :: [TODO]'
  await writeRenderFixture(`\x1b[2J\x1b[H\x1b[?25l${fixture}\r\n`)
  await page.waitForTimeout(100)
  const screen = page.locator('.xterm:visible .xterm-screen')
  const withoutLigatures = await screen.screenshot()

  await page.evaluate(() =>
    (
      window as unknown as {
        __vibingDebug: { setLigatures(enabled: boolean): void }
      }
    ).__vibingDebug.setLigatures(true)
  )
  await page.waitForTimeout(100)
  const withLigatures = await screen.screenshot()

  expect(countDifferentPixels(withoutLigatures, withLigatures)).toBeGreaterThan(
    30
  )
  expect((await dumpBuffer(page)).join('\n')).toContain(fixture)
  expect(
    await page.evaluate((text) => {
      const debug = (
        window as unknown as {
          __vibingDebug: {
            selectText(text: string): boolean
            selectionText(): string
          }
        }
      ).__vibingDebug
      return debug.selectText(text) && debug.selectionText() === text
    }, fixture)
  ).toBe(true)

  await forceDomRenderer()
  await expect.poll(() => rendererKind(tabId)).toBe('dom')
  await page.evaluate(() =>
    (
      window as unknown as {
        __vibingDebug: { setLigatures(enabled: boolean): void }
      }
    ).__vibingDebug.setLigatures(false)
  )
  await writeRenderFixture(`\x1b[2J\x1b[H\x1b[?25l${fixture}\r\n`)
  await page.waitForTimeout(100)
  const domWithoutLigatures = await screen.screenshot()
  await page.evaluate(() =>
    (
      window as unknown as {
        __vibingDebug: { setLigatures(enabled: boolean): void }
      }
    ).__vibingDebug.setLigatures(true)
  )
  await page.waitForTimeout(100)
  const domWithLigatures = await screen.screenshot()
  expect(
    countDifferentPixels(domWithoutLigatures, domWithLigatures)
  ).toBeGreaterThan(30)
})

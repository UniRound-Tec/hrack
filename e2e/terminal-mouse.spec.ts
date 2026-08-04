import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { resolve } from 'path'
import { dumpBuffer, launchApp, typeInTerminal } from './helpers'

let app: ElectronApplication
let window: Page

test.beforeAll(async () => {
  ;({ app, window } = await launchApp())
})

test.afterAll(async () => {
  await app.close()
})

test('forwards a real pointer click to a TUI that enabled SGR mouse reporting', async () => {
  const fixture = resolve(__dirname, 'fixtures/mouse-report.cjs')
  await typeInTerminal(window, `node "${fixture}"`)
  await window.keyboard.press('Enter')

  await expect
    .poll(async () => (await dumpBuffer(window)).join('\n'))
    .toContain('CLICK_INSIDE_TUI')

  const screen = await window.locator('.xterm-screen:visible').boundingBox()
  expect(screen).not.toBeNull()
  await window.mouse.click(screen!.x + screen!.width / 2, screen!.y + screen!.height / 2)

  await expect
    .poll(async () => (await dumpBuffer(window)).join('\n'), { timeout: 10_000 })
    .toContain('MOUSE_REPORT_OK:')
})

test.describe('real TUI mouse mode', () => {
  test.skip(
    process.env.VIBING_E2E_REAL_OPENCODE !== '1',
    'Set VIBING_E2E_REAL_OPENCODE=1 to run installed OpenCode'
  )

  test('OpenCode keeps mouse reporting enabled while its composer is visible', async () => {
    const real = await launchApp({
      cliFixture: false,
      createDefaultTerminal: false
    })
    try {
      const quick = real.window.getByTestId('home-quick-opencode')
      await expect(quick).toBeVisible({ timeout: 90_000 })
      await quick.click()
      const windowsInstallation = real.window.getByTestId(
        'cli-installation-windows'
      )
      if (await windowsInstallation.count()) await windowsInstallation.click()
      await real.window.getByTestId('cli-launch').click()

      await expect
        .poll(
          () =>
            real.window.evaluate(() =>
              (window.__vibingDebug?.dumpBuffer() ?? []).join('\n')
            ),
          { timeout: 60_000 }
        )
        .toContain('Ask anything')

      await expect
        .poll(() =>
          real.window.evaluate(() => ({
            mode: window.__vibingDebug?.mouseTrackingMode(),
            cursor: getComputedStyle(
              [...document.querySelectorAll<HTMLElement>('.xterm')].find(
                (element) => element.offsetParent !== null
              )!
            ).cursor
          }))
        )
        .toEqual({ mode: 'any', cursor: 'default' })
    } finally {
      await real.app.close()
    }
  })
})

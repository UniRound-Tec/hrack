import {
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { UI_COLOR_TOKENS, uiTokenToCssVariable } from '../shared/theme-schema'
import { launchApp } from './helpers'

let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  ;({ app, window: page } = await launchApp())
})

test.afterEach(async () => {
  await app?.close().catch(() => {})
})

test('renders platform-appropriate title-bar controls and applies every GUI token', async () => {
  await expect(page.getByTestId('titlebar')).toBeVisible()
  await expect(page.getByTestId('titlebar-new')).toBeEnabled()

  const platform = await page.evaluate(() => window.windowApi.platform)
  if (platform === 'darwin') {
    await expect(page.getByTestId('window-controls')).toHaveCount(0)
  } else {
    await expect(page.getByTestId('window-controls')).toBeVisible()
  }

  const themeState = await page.evaluate((tokens) => {
    const styles = getComputedStyle(document.documentElement)
    return {
      id: document.documentElement.dataset.uiTheme,
      missing: tokens.filter(
        (token) =>
          styles
            .getPropertyValue(`--vib-${token.replaceAll('.', '-')}`)
            .trim().length === 0
      )
    }
  }, UI_COLOR_TOKENS)
  expect(themeState).toEqual({ id: 'light', missing: [] })
  expect(uiTokenToCssVariable('bg.app')).toBe('--vib-bg-app')
})

test('toggles maximize from the custom control', async () => {
  const platform = await page.evaluate(() => window.windowApi.platform)
  test.skip(platform === 'darwin', 'macOS uses the native traffic lights')

  const toggle = page.getByTestId('window-toggle-maximize')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-label', '还原')
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isMaximized()
      )
    )
    .toBe(true)
})

test('marks the title-bar center draggable and keeps controls clickable', async () => {
  const platform = await page.evaluate(() => window.windowApi.platform)
  test.skip(platform === 'darwin', 'macOS keeps its native hidden-inset title bar')

  const regions = await page.evaluate(() => ({
    drag: getComputedStyle(
      document.querySelector('[data-testid="titlebar-drag-region"]')!
    ).getPropertyValue('-webkit-app-region'),
    action: getComputedStyle(
      document.querySelector('[data-testid="titlebar-new"]')!
    ).getPropertyValue('-webkit-app-region'),
    control: getComputedStyle(
      document.querySelector('[data-testid="window-minimize"]')!
    ).getPropertyValue('-webkit-app-region')
  }))
  expect(regions).toEqual({ drag: 'drag', action: 'no-drag', control: 'no-drag' })
})

test('minimizes and closes through the narrowed window API', async () => {
  const platform = await page.evaluate(() => window.windowApi.platform)
  test.skip(platform === 'darwin', 'macOS uses the native traffic lights')

  await page.getByTestId('window-minimize').click()
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isMinimized()
      )
    )
    .toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())

  const closed = page.waitForEvent('close')
  await page.getByTestId('window-close').click()
  await closed
})

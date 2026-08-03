import {
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { dumpBuffer, launchApp, typeInTerminal } from './helpers'

let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  ;({ app, window: page } = await launchApp())
  await page.evaluate(() => {
    window.__vibingDebugShell?.setNavMode('sidebar')
    window.__vibingDebugShell?.navigate('home')
  })
})

test.afterEach(async () => {
  await app?.close()
})

test('routes Home, settings and a keep-alive terminal from the sidebar', async () => {
  await expect(page.getByTestId('home-page')).toBeVisible()
  await expect(page.locator('.xterm')).toHaveCount(1)
  await expect(page.locator('.xterm:visible')).toHaveCount(0)

  const terminalItem = page.getByTestId('sidebar-terminal-item').first()
  await terminalItem.click()
  await expect(page.getByTestId('terminal-page')).toBeVisible()
  await expect(page.locator('.xterm:visible')).toHaveCount(1)
  await expect
    .poll(async () => (await dumpBuffer(page)).join('\n'))
    .toContain('PS ')

  const token = `SHELL_KEEP_ALIVE_${Date.now()}`
  await typeInTerminal(page, `Write-Output "${token}"`)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await dumpBuffer(page)).join('\n'))
    .toContain(token)

  await page.getByTestId('nav-home').click()
  await expect(page.getByTestId('home-page')).toBeVisible()
  await expect(page.locator('.xterm:visible')).toHaveCount(0)
  await terminalItem.click()
  await expect(page.locator('.xterm:visible')).toHaveCount(1)
  expect((await dumpBuffer(page)).join('\n')).toContain(token)

  await page.getByTestId('titlebar-settings').click()
  await expect(page.getByTestId('settings-page')).toBeVisible()
  await expect(page.locator('.xterm')).toHaveCount(1)
})

test('switches sidebar, rail and scrolling top-tab navigation', async () => {
  await page.getByTestId('sidebar-collapse').click()
  await expect(page.getByTestId('icon-rail')).toBeVisible()
  await expect(page.getByTestId('sidebar')).toHaveCount(0)

  await page.getByTestId('rail-expand').click()
  await expect(page.getByTestId('sidebar')).toBeVisible()

  await page.getByTestId('titlebar-settings').click()
  await page.getByTestId('settings-nav-tabs').click()
  await expect(page.getByTestId('top-tab-bar')).toBeVisible()
  await expect(page.getByTestId('sidebar')).toHaveCount(0)
  await expect(page.getByTestId('toptab-session-item')).toHaveCount(0)
  await expect(page.getByTestId('toptab-terminal-item')).toHaveCount(1)
  await expect(page.getByTestId('toptab-new-session')).toBeVisible()

  await page.evaluate(() =>
    window.__vibingDebugShell?.setNavMode('sidebar')
  )
})

test('opens the new-session overlay without changing page and closes the final terminal to Home', async () => {
  await page.keyboard.press('Control+Shift+T')
  await expect(page.getByTestId('new-session-overlay')).toBeVisible()
  await expect(page.getByTestId('home-page')).toBeVisible()
  await page.getByTestId('new-session-close').click()
  await expect(page.getByTestId('new-session-overlay')).toHaveCount(0)

  await page.getByTestId('sidebar-terminal-item').first().click()
  await expect(page.locator('.xterm:visible')).toHaveCount(1)
  await page.keyboard.press('Control+Shift+W')

  await expect(page.getByTestId('home-page')).toBeVisible()
  await expect(page.getByTestId('sidebar-terminal-item')).toHaveCount(0)
  expect(page.isClosed()).toBe(false)
})

test('cycles between opened terminals and closes to the active neighbor', async () => {
  const terminals = page.getByTestId('sidebar-terminal-item')
  await terminals.first().click()

  await page.keyboard.press('Control+Shift+T')
  await page.getByTestId('new-session-terminal').click()
  await expect(terminals).toHaveCount(2)
  await expect(terminals.nth(1)).toHaveAttribute('aria-current', 'page')

  await page.keyboard.press('Control+Shift+Tab')
  await expect(terminals.nth(0)).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Control+Tab')
  await expect(terminals.nth(1)).toHaveAttribute('aria-current', 'page')

  await page.keyboard.press('Control+Shift+W')
  await expect(terminals).toHaveCount(1)
  await expect(terminals.first()).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.xterm:visible')).toHaveCount(1)
})

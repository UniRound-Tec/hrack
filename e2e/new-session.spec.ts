import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { buildCliLaunch, cliOptions, parseCommandLine } from '../src/app/launchOptions'
import { launchApp } from './helpers'

test('splits quoted CLI arguments and assembles Windows/WSL launches', () => {
  expect(parseCommandLine('--flag "two words" C:\\work\\demo')).toEqual([
    '--flag',
    'two words',
    'C:\\work\\demo'
  ])
  const option = cliOptions[0]
  expect(buildCliLaunch({ option, name: 'Codex', workspace: 'C:\\repo', args: '--full-auto "two words"', runtime: 'windows' })).toEqual({
    shell: 'codex',
    args: ['--full-auto', 'two words'],
    cwd: 'C:\\repo'
  })
  expect(buildCliLaunch({ option, name: 'Codex', workspace: 'C:\\repo', args: '--full-auto', runtime: 'wsl' })).toEqual({
    shell: 'wsl.exe',
    args: ['-e', 'codex', '--full-auto'],
    cwd: 'C:\\repo'
  })
})

test.describe('new session flow', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeEach(async () => {
    ;({ app, window: page } = await launchApp())
    await page.evaluate(() => {
      window.__vibingDebugShell?.setNavMode('sidebar')
      window.__vibingDebugShell?.navigate('home')
    })
  })

  test.afterEach(async () => app?.close())

  test('opens terminal picker and starts the selected real shell', async () => {
    const terminals = page.getByTestId('sidebar-terminal-item')
    await page.keyboard.press('Control+Shift+T')
    await page.getByTestId('new-session-terminal-options').click()
    await expect(page.getByTestId('terminal-picker')).toBeVisible()
    const choices = page.locator('[data-testid^="terminal-option-"]')
    await expect(choices).not.toHaveCount(0)
    await choices.first().click()
    await expect(terminals).toHaveCount(2)
    await expect(page.locator('.xterm:visible')).toHaveCount(1)
  })

  test('opens CLI configuration from Home and binds all draft fields', async () => {
    await page.getByTestId('home-quick-codex').click()
    await expect(page.getByTestId('cli-config')).toBeVisible()
    await expect(page.getByTestId('cli-session-name')).toHaveValue('Codex')
    await page.getByTestId('cli-session-name').fill('Repo agent')
    await page.getByTestId('cli-workspace').fill('C:\\repo')
    await page.getByTestId('cli-arguments').fill('--full-auto "two words"')
    await page.getByTestId('cli-runtime-wsl').click()
    await expect(page.getByTestId('cli-runtime-wsl')).toHaveClass(/bg-button-primary/)
  })
})

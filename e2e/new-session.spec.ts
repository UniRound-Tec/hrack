import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { buildCliLaunchSelection, parseCommandLine } from '../src/app/launchOptions'
import type { LaunchableCli } from '../shared/ipc-contract'
import { launchApp } from './helpers'

test('splits quoted CLI arguments and builds an installation-bound selection', () => {
  expect(parseCommandLine('--flag "two words" C:\\work\\demo')).toEqual([
    '--flag',
    'two words',
    'C:\\work\\demo'
  ])
  const option = {
    definition: {
      id: 'codex', adapterId: 'codex', displayName: 'Codex',
      hint: 'OpenAI coding agent', iconId: 'codex'
    },
    installations: [{
      id: 'codex:windows', definitionId: 'codex',
      runtime: { kind: 'host', platform: 'windows' },
      resolvedExecutable: 'C:\\bin\\codex.exe', detectedVia: 'path',
      verification: 'verified'
    }]
  } satisfies LaunchableCli
  expect(buildCliLaunchSelection({
    option,
    installationId: 'codex:windows',
    name: 'Codex',
    workspace: 'C:\\repo',
    args: '--flag "two words"'
  })).toEqual({
    installationId: 'codex:windows',
    args: ['--flag', 'two words'],
    workspace: 'C:\\repo'
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
    await expect(page.getByTestId('new-session-overlay')).toHaveCount(0)
    await expect(page.getByTestId('cli-session-name')).toHaveValue('Codex')
    await page.getByTestId('cli-session-name').fill('Repo agent')
    await page.getByTestId('cli-workspace').fill('C:\\repo')
    await page.getByTestId('cli-arguments').fill('--model "two words"')
    await page.getByTestId('cli-installation-wsl-Ubuntu-Test').click()
    await expect(page.getByTestId('cli-installation-wsl-Ubuntu-Test')).toHaveClass(/bg-button-primary/)
    const exitStayedMounted = await page.evaluate(() => {
      const backdrop = document.querySelector<HTMLElement>('[data-testid="cli-config-backdrop"]')
      backdrop?.click()
      return Boolean(document.querySelector('[data-testid="cli-config"]'))
    })
    expect(exitStayedMounted).toBe(true)
    await expect(page.getByTestId('cli-config')).toHaveCount(0)
    await expect(page.getByTestId('new-session-overlay')).toHaveCount(0)
  })

  test('uses the selected WSL installation when picking a CLI workspace', async () => {
    await page.getByTestId('home-quick-codex').click()
    await page.getByTestId('cli-workspace').fill('C:\\previous-windows-repo')
    await page.getByTestId('cli-installation-wsl-Ubuntu-Test').click()

    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1)
        ;(globalThis as Record<string, unknown>).__pickedDirectoryOptions = options
        return {
          canceled: false,
          filePaths: ['\\\\wsl.localhost\\Ubuntu-Test\\home\\jesse\\project'],
          bookmarks: []
        }
      }
    })

    await page.getByTestId('cli-pick-workspace').click()

    await expect(page.getByTestId('cli-workspace')).toHaveValue('/home/jesse/project')
    expect(
      await app.evaluate(() =>
        (globalThis as Record<string, unknown>).__pickedDirectoryOptions
      )
    ).toMatchObject({
      defaultPath: '\\\\wsl.localhost\\Ubuntu-Test\\',
      properties: ['openDirectory']
    })
  })
})

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './helpers'

test('settings controls write through to the live application state', async () => {
  const { app, window: page } = await launchApp()
  try {
    await page.evaluate(() => window.__vibingDebugShell?.setNavMode('sidebar'))
    await page.getByTestId('titlebar-settings').click()
    await expect(page.getByTestId('settings-page')).toBeVisible()

    const size = page.getByTestId('settings-font-size')
    const before = Number.parseInt((await size.textContent()) ?? '16', 10)
    await page.getByTestId('settings-font-increase').click()
    await expect(size).toHaveText(`${Math.min(24, before + 1)}px`)

    const ligatures = page.getByTestId('settings-ligatures')
    const wasEnabled = await ligatures.getAttribute('aria-checked')
    await ligatures.click()
    await expect(ligatures).toHaveAttribute('aria-checked', wasEnabled === 'true' ? 'false' : 'true')

    await page.getByTestId('settings-terminal-theme').click()
    await expect(page.locator('[data-testid^="settings-terminal-theme-group-"]')).toHaveCount(2)
    expect(await page.locator('[data-testid^="settings-terminal-theme-group-"]').evaluateAll((groups) =>
      groups.map((group) => group.getAttribute('data-testid'))
    )).toEqual([
      'settings-terminal-theme-group-light',
      'settings-terminal-theme-group-dark'
    ])
    await page.getByTestId('settings-terminal-theme-option-light').click()
    await expect(page.getByTestId('settings-terminal-theme')).toHaveAttribute('data-value', 'light')
    await expect(page.getByTestId('terminal-theme-preview').locator('span')).toHaveCount(16)

    await page.getByTestId('settings-ui-theme').click()
    await expect(page.locator('[data-testid^="settings-ui-theme-group-"]')).toHaveCount(2)
    expect(await page.locator('[data-testid^="settings-ui-theme-group-"]').evaluateAll((groups) =>
      groups.map((group) => group.getAttribute('data-testid'))
    )).toEqual([
      'settings-ui-theme-group-light',
      'settings-ui-theme-group-dark'
    ])
    await page.getByTestId('settings-ui-theme-option-catppuccin-latte').click()
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'catppuccin-latte')
    await page.getByTestId('settings-terminal-theme').click()
    await page.getByTestId('settings-terminal-theme-option-catppuccin-latte').click()
    await expect
      .poll(() =>
        page.evaluate(() => window.__vibingDebug.terminalAppearance().theme.background)
      )
      .toBe('#eff1f5')

    await page.getByTestId('settings-nav-rail').click()
    await expect(page.getByTestId('icon-rail')).toBeVisible()
    const attentionPriority = page.getByTestId('settings-attention-priority')
    await expect(attentionPriority).toHaveAttribute('aria-checked', 'false')
    await attentionPriority.click()
    await expect(attentionPriority).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('settings-default-terminal')).toBeEnabled()
  } finally {
    await app.close()
  }
})

test('language switch hot-applies settings copy', async () => {
  const { app, window: page } = await launchApp()
  try {
    await page.evaluate(() => window.__vibingDebugShell?.setNavMode('sidebar'))
    await page.getByTestId('titlebar-settings').click()
    await expect(page.getByTestId('settings-page')).toBeVisible()

    const heading = page.locator('[data-testid="settings-page"] h1')
    await expect(heading).toHaveText('设置')

    // 切到英文：h1 与语言下拉即时变化。
    await page.getByTestId('settings-language').click()
    await page.getByTestId('settings-language-list').getByText('English').click()
    await expect(heading).toHaveText('Settings')
    await expect(page.getByTestId('settings-language')).toContainText('English')

    // 切到日文再切回：热切换无刷新。
    await page.getByTestId('settings-language').click()
    await page.getByTestId('settings-language-list').getByText('日本語').click()
    await expect(heading).toHaveText('設定')
    await page.getByTestId('settings-language').click()
    await page.getByTestId('settings-language-list').getByText('简体中文').click()
    await expect(heading).toHaveText('设置')
  } finally {
    await app.close()
  }
})

test('font family input applies instantly and restores the default', async () => {
  const { app, window: page } = await launchApp()
  try {
    await page.getByTestId('titlebar-settings').click()
    const input = page.getByTestId('settings-font-input')
    await input.fill('Consolas')
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as {
            __vibingDebug: { terminalAppearance(): { fontFamily: string } }
          }).__vibingDebug.terminalAppearance()
        )
      )
      .toMatchObject({ fontFamily: 'Consolas' })
    await page.getByTestId('settings-font-reset').click()
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as {
            __vibingDebug: { terminalAppearance(): { fontFamily: string } }
          }).__vibingDebug.terminalAppearance()
        )
      )
      .not.toMatchObject({ fontFamily: 'Consolas' })
  } finally {
    await app.close()
  }
})

test('global shortcut toggle writes through to the store', async () => {
  const { app, window: page } = await launchApp()
  try {
    await page.getByTestId('titlebar-settings').click()
    const toggle = page.getByTestId('settings-global-shortcut')
    const wasEnabled = (await toggle.getAttribute('aria-checked')) === 'true'
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', wasEnabled ? 'false' : 'true')
  } finally {
    await app.close()
  }
})

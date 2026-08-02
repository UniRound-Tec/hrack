import { expect, test } from '@playwright/test'
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

    await page.getByTestId('settings-terminal-theme-light').click()
    await expect(page.getByTestId('settings-terminal-theme-light')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('terminal-theme-preview').locator('span')).toHaveCount(16)

    await page.getByTestId('settings-nav-rail').click()
    await expect(page.getByTestId('icon-rail')).toBeVisible()
    await expect(page.getByTestId('settings-default-terminal')).toBeEnabled()
  } finally {
    await app.close()
  }
})

import { expect, test } from '@playwright/test'
import { launchApp } from './helpers'

test('Home stays fresh with ordinary terminals and exposes CLI rescan', async () => {
  const { app, window: page } = await launchApp()
  try {
    await page.evaluate(() => {
      window.__vibingDebugShell?.setNavMode('sidebar')
      window.__vibingDebugShell?.navigate('home')
    })
    await expect(page.getByTestId('home-page')).toHaveAttribute('data-home-state', 'fresh')
    await expect(page.getByTestId('sidebar-terminal-item')).toHaveCount(1)
    await expect(page.getByTestId('cli-scan-refresh')).toBeVisible()

    await page.getByTestId('home-quick-terminal').click()
    await expect(page.locator('.xterm:visible')).toHaveCount(1)
    await expect(page.getByTestId('sidebar-terminal-item')).toHaveCount(2)

    await page.evaluate(() => window.__vibingDebugShell?.navigate('home'))
    await expect(page.getByTestId('home-page')).toHaveAttribute('data-home-state', 'fresh')
  } finally {
    await app.close()
  }
})

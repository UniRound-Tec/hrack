import { expect, test } from '@playwright/test'
import { launchApp } from './helpers'

test('Home switches between dense and fresh states around the final terminal', async () => {
  const { app, window: page } = await launchApp()
  try {
    await page.evaluate(() => {
      window.__vibingDebugShell?.setNavMode('sidebar')
      window.__vibingDebugShell?.setMockSessions(false)
      window.__vibingDebugShell?.navigate('home')
    })
    await expect(page.getByTestId('home-page')).toHaveAttribute('data-home-state', 'dense')
    const item = page.getByTestId('sidebar-terminal-item').first()
    await item.hover()
    await page.getByTestId('sidebar-terminal-close').first().click()
    await expect(page.getByTestId('home-page')).toHaveAttribute('data-home-state', 'fresh')
    await page.getByTestId('home-quick-terminal').click()
    await expect(page.locator('.xterm:visible')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

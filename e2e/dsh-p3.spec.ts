import { expect, test } from '@playwright/test'
import { launchApp } from './helpers'

test('dsh p3 delegates product settings to the official Web surface', async () => {
  test.setTimeout(240_000)
  const { app, window } = await launchApp({ createDefaultTerminal: false })
  try {
    await expect(window.getByTestId('home-page')).toBeVisible({ timeout: 20_000 })
    await window.getByTestId('home-quick-dsh').click()
    await expect(window.getByTestId('dsh-page')).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(
        async () =>
          window.evaluate(async () => (await window.dshApi.getStatus()).state),
        { timeout: 120_000, intervals: [500, 1000, 2000] }
      )
      .toBe('ready')

    const before = await window.evaluate(() => window.dshApi.getConfig())
    expect(before.homeMode).toBe('shared')
    expect(before.envOverride).toBe(true)
    expect(before.activeHome.replace(/\\/g, '/')).toContain('dsh-home')
    expect(before.retention).toEqual({ kind: 'all' })
    await expect(window.getByTestId('dsh-page')).toHaveAttribute(
      'data-dsh-surface-phase',
      'ready',
      { timeout: 30_000 }
    )
    await expect(window.getByTestId('dsh-lobby')).toHaveCount(0)
    await expect(window.getByTestId('dsh-host-settings')).toHaveCount(0)
    await window.screenshot({ path: '.dev-shots/dsh-p3-official-settings.png' })
  } finally {
    await app.close()
  }
})

import { expect, test } from '@playwright/test'
import { launchApp } from './helpers'

test('dsh p3 persists home mode and retention from lobby settings', async () => {
  test.setTimeout(240_000)
  const { app, window } = await launchApp({ createDefaultTerminal: false })
  try {
    await window.evaluate(() => {
      ;(
        window as unknown as { __vibingDebugShell: { navigate(page: string): void } }
      ).__vibingDebugShell.navigate('dsh:home')
    })
    await expect(window.getByTestId('dsh-lobby')).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(
        async () =>
          window.evaluate(async () => (await window.dshApi.getStatus()).state),
        { timeout: 120_000, intervals: [500, 1000, 2000] }
      )
      .toBe('ready')

    const before = await window.evaluate(() => window.dshApi.getConfig())
    expect(before.homeMode).toBe('isolated')
    expect(before.activeHome.replace(/\\/g, '/')).toContain('dsh-home')
    expect(before.retention).toEqual({ kind: 'all' })

    await window.getByTestId('dsh-lobby-settings').click()
    await expect(window.getByTestId('dsh-host-settings')).toBeVisible({
      timeout: 60_000
    })
    await expect(window.getByTestId('dsh-home-path')).toContainText('dsh-home')
    await window.screenshot({ path: '.dev-shots/dsh-p3-settings.png' })

    await window.getByTestId('dsh-retention-kind').selectOption('days')
    await expect(window.getByTestId('dsh-retention-days')).toBeVisible()
    await window.getByTestId('dsh-retention-days').fill('14')
    await expect
      .poll(async () => {
        const config = await window.evaluate(() => window.dshApi.getConfig())
        return JSON.stringify(config.retention)
      })
      .toBe(JSON.stringify({ kind: 'days', days: 14 }))

    await window.screenshot({ path: '.dev-shots/dsh-p3-retention.png' })
  } finally {
    await app.close()
  }
})

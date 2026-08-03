import { expect, test } from '@playwright/test'
import { launchApp } from './helpers'

test('discovery report only exposes verified, installation-bound CLIs', async () => {
  const { app, window } = await launchApp()
  try {
    const report = await window.evaluate(() => window.cliApi.scan())
    expect(report.finishedAt).toBeGreaterThanOrEqual(report.startedAt)
    expect(report.launchable.map((cli) => cli.definition.id)).toEqual(['codex'])
    const installations = report.launchable.flatMap((cli) => cli.installations)
    expect(installations).toHaveLength(2)
    expect(installations.every((item) => item.verification === 'verified')).toBe(true)
    expect(installations.map((item) => item.runtime)).toEqual([
      { kind: 'host', platform: 'windows' },
      { kind: 'wsl', distro: 'Ubuntu-Test' }
    ])
  } finally {
    await app.close()
  }
})

test('Home and New Session consume the same discovery result', async () => {
  const { app, window } = await launchApp()
  try {
    await window.evaluate(() => {
      window.__vibingDebugShell?.setNavMode('sidebar')
      window.__vibingDebugShell?.navigate('home')
    })
    await expect(window.getByTestId('home-quick-codex')).toBeVisible()
    await window.keyboard.press('Control+Shift+T')
    await expect(window.getByTestId('new-session-cli-codex')).toBeVisible()
    await expect(
      window.locator('button[data-testid^="new-session-cli-"]:not([data-testid="new-session-cli-refresh"])')
    ).toHaveCount(1)
  } finally {
    await app.close()
  }
})

import { expect, test } from '@playwright/test'
import { launchApp } from './helpers'

test('renames an AI session and creates its child terminal from the top tab', async () => {
  const { app, window } = await launchApp({
    createDefaultTerminal: false,
    env: {
      VIBING_FIXTURE_OBSERVER: '1',
      VIBING_FIXTURE_OBSERVER_HOLD: '1'
    }
  })
  try {
    await window.getByTestId('home-quick-codex').click()
    await window.getByTestId('cli-installation-windows').click()
    await window.getByTestId('cli-launch').click()
    await expect(window.getByTestId('sidebar-session-item')).toBeVisible({
      timeout: 15_000
    })

    await window.evaluate(() => window.__vibingDebugShell?.setNavMode('tabs'))
    const sessionTab = window.getByTestId('toptab-session-item')
    await expect(sessionTab).toBeVisible()
    const sessionId = await sessionTab.getAttribute('data-session-id')
    expect(sessionId).toBeTruthy()

    await sessionTab.click({ button: 'right' })
    await expect(
      window.getByTestId('toptab-session-actions-popover')
    ).toBeVisible()
    await expect(
      window.getByTestId('toptab-session-child-terminal')
    ).toBeVisible()
    await window.getByTestId('toptab-session-rename').click()

    const renameInput = window.getByTestId('toptab-session-rename-input')
    await renameInput.fill('')
    await window.getByTestId('toptab-home').click()
    await expect(window.getByRole('alert')).toBeVisible()

    await renameInput.fill('Top Session')
    await window.getByTestId('toptab-home').click()
    await expect(sessionTab).toContainText('Top Session')
    await expect(
      window.getByTestId('toptab-session-actions-popover')
    ).toHaveCount(0)

    await sessionTab.click({ button: 'right' })
    await window.getByTestId('toptab-session-child-terminal').click()
    await expect(window.getByTestId('toptab-terminal-item')).toHaveCount(1)
    await expect
      .poll(() =>
        window.evaluate(async (parentSessionId) => {
          const recoverable = await window.ptyApi.listRecoverable()
          return recoverable.some(
            (entry) =>
              entry.kind === 'terminal' &&
              entry.parentSessionId === parentSessionId
          )
        }, sessionId)
      )
      .toBe(true)
  } finally {
    await app.close()
  }
})

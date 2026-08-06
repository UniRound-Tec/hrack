import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { launchApp } from './helpers'

const workspace = resolve(__dirname, 'fixtures/workspace-reader')

test('clones the complete AI launch recipe from sidebar and top tabs', async () => {
  const { app, window } = await launchApp({
    createDefaultTerminal: false,
    env: {
      VIBING_FIXTURE_OBSERVER: '1',
      VIBING_FIXTURE_OBSERVER_HOLD: '1'
    }
  })
  try {
    await window.getByTestId('home-quick-codex').click()
    await window.getByTestId('cli-session-name').fill('Clone Source')
    await window.getByTestId('cli-workspace').fill(workspace)
    await window.getByTestId('cli-arguments').fill('/q')
    await window.getByTestId('cli-installation-windows').click()
    await window.getByTestId('cli-launch').click()

    const sidebarSessions = window.getByTestId('sidebar-session-item')
    await expect(sidebarSessions).toHaveCount(1, { timeout: 15_000 })
    await sidebarSessions.first().click({ button: 'right' })
    await expect(window.getByTestId('sidebar-session-clone')).toBeVisible()
    await window.getByTestId('sidebar-session-clone').click()
    await expect(sidebarSessions).toHaveCount(2, { timeout: 15_000 })
    await expect(window.getByTestId('sidebar-child-terminal-item')).toHaveCount(0)

    const expectedSelection = await window.evaluate(async () => {
      const recoverable = await window.ptyApi.listRecoverable()
      return recoverable.find((entry) => entry.kind === 'agent')?.agentSelection
    })
    expect(expectedSelection).toEqual({
      installationId: expect.any(String),
      workspace,
      args: ['/q']
    })
    await expect
      .poll(() =>
        window.evaluate(async (selection) => {
          const recoverable = await window.ptyApi.listRecoverable()
          const agents = recoverable.filter((entry) => entry.kind === 'agent')
          return agents.length === 2 &&
            agents.every((entry) =>
              JSON.stringify(entry.agentSelection) === JSON.stringify(selection)
            )
        }, expectedSelection)
      )
      .toBe(true)

    await window.reload()
    await window.waitForFunction(() => Boolean(window.__vibingDebugShell))
    await window.evaluate(() => window.__vibingDebugShell?.setNavMode('tabs'))
    const topSessions = window.getByTestId('toptab-session-item')
    await expect(topSessions).toHaveCount(2)
    await topSessions.first().click({ button: 'right' })
    await expect(window.getByTestId('toptab-session-clone')).toBeVisible()
    await window.getByTestId('toptab-session-clone').click()
    await expect(topSessions).toHaveCount(3, { timeout: 15_000 })
    await expect
      .poll(() =>
        window.evaluate(async (selection) => {
          const recoverable = await window.ptyApi.listRecoverable()
          const agents = recoverable.filter((entry) => entry.kind === 'agent')
          return agents.length === 3 &&
            agents.every((entry) =>
              JSON.stringify(entry.agentSelection) === JSON.stringify(selection)
            )
        }, expectedSelection)
      )
      .toBe(true)
  } finally {
    await app.close()
  }
})

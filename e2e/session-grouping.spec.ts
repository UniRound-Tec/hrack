import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { launchApp } from './helpers'

const workspace = resolve(__dirname, 'fixtures/workspace-reader')

test('groups two AI sessions by dwell drag and keeps top tabs flat after reload', async () => {
  const { app, window } = await launchApp({
    createDefaultTerminal: false,
    env: {
      VIBING_FIXTURE_OBSERVER: '1',
      VIBING_FIXTURE_OBSERVER_HOLD: '1'
    }
  })
  try {
    await window.getByTestId('home-quick-codex').click()
    await window.getByTestId('cli-session-name').fill('Group Source')
    await window.getByTestId('cli-workspace').fill(workspace)
    await window.getByTestId('cli-installation-windows').click()
    await window.getByTestId('cli-launch').click()

    const sessions = window.getByTestId('sidebar-session-item')
    await expect(sessions).toHaveCount(1, { timeout: 15_000 })
    await sessions.first().click({ button: 'right' })
    await window.getByTestId('sidebar-session-clone').click()
    await expect(sessions).toHaveCount(2, { timeout: 15_000 })

    const sourceBox = await sessions.nth(1).boundingBox()
    const targetBox = await sessions.nth(0).boundingBox()
    expect(sourceBox).not.toBeNull()
    expect(targetBox).not.toBeNull()
    await window.mouse.move(
      sourceBox!.x + sourceBox!.width / 2,
      sourceBox!.y + sourceBox!.height / 2
    )
    await window.mouse.down()
    await window.waitForTimeout(40)
    await window.mouse.move(
      targetBox!.x + targetBox!.width / 2,
      targetBox!.y + targetBox!.height / 2,
      { steps: 8 }
    )
    await expect(window.getByTestId('sidebar-session-drag-overlay')).toBeVisible()
    await window.waitForTimeout(850)
    await window.mouse.up()

    const group = window.getByTestId('sidebar-session-group')
    await expect(group).toHaveCount(1)
    await expect(group.getByTestId('sidebar-session-item')).toHaveCount(2)

    await group.getByTestId('sidebar-session-group-menu').click()
    await window.getByTestId('sidebar-session-group-rename').click()
    const rename = window.getByTestId('sidebar-session-group-rename-input')
    await rename.fill('Backend agents')
    await rename.press('Enter')
    await expect(group.getByText('Backend agents')).toBeVisible()

    await window.reload()
    await window.waitForFunction(() => Boolean(window.__vibingDebugShell))
    await expect(window.getByTestId('sidebar-session-group')).toHaveCount(1)
    await expect(window.getByText('Backend agents')).toBeVisible()

    await window.evaluate(() => window.__vibingDebugShell?.setNavMode('tabs'))
    await expect(window.getByTestId('toptab-session-item')).toHaveCount(2)
    await expect(window.getByTestId('sidebar-session-group')).toHaveCount(0)

    await window.evaluate(() => window.__vibingDebugShell?.setNavMode('sidebar'))
    await expect(window.getByTestId('sidebar')).toBeVisible()
    await window.waitForTimeout(350)
    const restoredGroup = window.getByTestId('sidebar-session-group')
    await restoredGroup.getByTestId('sidebar-session-item').first().click({
      button: 'right'
    })
    await window.getByTestId('sidebar-session-remove-from-group').click()
    await expect(restoredGroup.getByTestId('sidebar-session-item')).toHaveCount(1)
    await expect(window.getByTestId('sidebar-session-item')).toHaveCount(2)

    await restoredGroup.getByTestId('sidebar-session-group-menu').click()
    await window.getByTestId('sidebar-session-group-dissolve').click()
    await expect(window.getByTestId('sidebar-session-group')).toHaveCount(0)
    await expect(window.getByTestId('sidebar-session-item')).toHaveCount(2)
  } finally {
    await app.close()
  }
})

test('quick drag reorders root sessions without creating a group and survives reload', async () => {
  const { app, window } = await launchApp({
    createDefaultTerminal: false,
    env: {
      VIBING_FIXTURE_OBSERVER: '1',
      VIBING_FIXTURE_OBSERVER_HOLD: '1'
    }
  })
  try {
    await window.getByTestId('home-quick-codex').click()
    await window.getByTestId('cli-workspace').fill(workspace)
    await window.getByTestId('cli-installation-windows').click()
    await window.getByTestId('cli-launch').click()
    const sessions = window.getByTestId('sidebar-session-item')
    await expect(sessions).toHaveCount(1, { timeout: 15_000 })
    await sessions.first().click({ button: 'right' })
    await window.getByTestId('sidebar-session-clone').click()
    await expect(sessions).toHaveCount(2, { timeout: 15_000 })
    await sessions.first().click({ button: 'right' })
    await window.getByTestId('sidebar-session-clone').click()
    await expect(sessions).toHaveCount(3, { timeout: 15_000 })

    const originalIds = await sessions.evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-session-id'))
    )
    const sourceBox = await sessions.nth(2).boundingBox()
    const targetBox = await sessions.nth(0).boundingBox()
    await window.mouse.move(
      sourceBox!.x + sourceBox!.width / 2,
      sourceBox!.y + sourceBox!.height / 2
    )
    await window.mouse.down()
    await window.waitForTimeout(30)
    await window.mouse.move(
      targetBox!.x + targetBox!.width / 2,
      targetBox!.y + 2,
      { steps: 6 }
    )
    await window.mouse.up()

    await expect(window.getByTestId('sidebar-session-group')).toHaveCount(0)
    await expect
      .poll(() =>
        sessions.evaluateAll((items) =>
          items.map((item) => item.getAttribute('data-session-id'))
        )
      )
      .toEqual([originalIds[2], originalIds[0], originalIds[1]])

    await window.reload()
    await window.waitForFunction(() => Boolean(window.__vibingDebugShell))
    await expect
      .poll(() =>
        sessions.evaluateAll((items) =>
          items.map((item) => item.getAttribute('data-session-id'))
        )
      )
      .toEqual([originalIds[2], originalIds[0], originalIds[1]])
  } finally {
    await app.close()
  }
})

test('creates a group only after a menu-launched CLI produces its first projection', async () => {
  const { app, window } = await launchApp({
    createDefaultTerminal: false,
    env: {
      VIBING_FIXTURE_OBSERVER: '1',
      VIBING_FIXTURE_OBSERVER_HOLD: '1'
    }
  })
  try {
    await window.getByTestId('home-quick-codex').click()
    await window.getByTestId('cli-session-name').fill('Existing agent')
    await window.getByTestId('cli-workspace').fill(workspace)
    await window.getByTestId('cli-installation-windows').click()
    await window.getByTestId('cli-launch').click()
    const sessions = window.getByTestId('sidebar-session-item')
    await expect(sessions).toHaveCount(1, { timeout: 15_000 })

    await sessions.first().click({ button: 'right' })
    await window.getByTestId('sidebar-session-launch-into-group').click()
    await expect(window.getByTestId('new-session-overlay')).toBeVisible()
    await window.getByTestId('new-session-close').click()
    await expect(window.getByTestId('sidebar-session-group')).toHaveCount(0)
    await expect(sessions).toHaveCount(1)

    await sessions.first().click({ button: 'right' })
    await window.getByTestId('sidebar-session-launch-into-group').click()
    await window.getByTestId('new-session-cli-codex').click()
    await expect(window.getByTestId('cli-workspace')).toHaveValue(workspace)
    await window.getByTestId('cli-installation-windows').click()
    await window.getByTestId('cli-launch').click()

    const group = window.getByTestId('sidebar-session-group')
    await expect(group).toHaveCount(1, { timeout: 15_000 })
    await expect(group.getByTestId('sidebar-session-item')).toHaveCount(2)
  } finally {
    await app.close()
  }
})

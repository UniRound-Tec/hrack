import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { launchApp } from './helpers'

const workspace = resolve(__dirname, 'fixtures/workspace-reader')

test('drag reorders sessions after a long hover and survives reload', async () => {
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
    const sourceText = (await sessions.nth(0).innerText()).trim()
    const sourceBox = await sessions.nth(0).boundingBox()
    const targetBox = await sessions.nth(2).boundingBox()
    await window.mouse.move(
      sourceBox!.x + sourceBox!.width / 2,
      sourceBox!.y + sourceBox!.height / 2
    )
    await window.mouse.down()
    await window.waitForTimeout(30)
    await window.mouse.move(
      targetBox!.x + targetBox!.width / 2,
      targetBox!.y + targetBox!.height + 4,
      { steps: 6 }
    )
    await window.waitForTimeout(900)

    const overlay = window.getByTestId('sidebar-session-drag-overlay')
    expect((await overlay.innerText()).replace(/\s+/g, '')).toBe(
      sourceText.replace(/\s+/g, '')
    )
    const overlayBox = await overlay.boundingBox()
    expect(Math.abs(overlayBox!.width - sourceBox!.width)).toBeLessThan(2)
    expect(Math.abs(overlayBox!.height - sourceBox!.height)).toBeLessThan(2)
    const sessionList = window.getByTestId('sidebar-session-list')
    await expect(sessionList).toHaveAttribute('data-session-drop-end', 'true')
    const endIndicator = await sessionList.evaluate((element) => {
      const style = getComputedStyle(element, '::after')
      return { height: style.height, shadow: style.boxShadow }
    })
    expect(endIndicator.height).toBe('3px')
    expect(endIndicator.shadow).not.toBe('none')
    await window.mouse.up()

    await expect
      .poll(() =>
        sessions.evaluateAll((items) =>
          items.map((item) => item.getAttribute('data-session-id'))
        )
      )
      .toEqual([originalIds[1], originalIds[2], originalIds[0]])

    await window.reload()
    await window.waitForFunction(() => Boolean(window.__vibingDebugShell))
    await expect
      .poll(() =>
        sessions.evaluateAll((items) =>
          items.map((item) => item.getAttribute('data-session-id'))
        )
      )
      .toEqual([originalIds[1], originalIds[2], originalIds[0]])

    await sessions.first().click({ button: 'right' })
    await expect(
      window.getByTestId('sidebar-session-launch-into-group')
    ).toHaveCount(0)
  } finally {
    await app.close()
  }
})

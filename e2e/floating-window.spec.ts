import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './helpers'

async function floatingWindow(app: ElectronApplication): Promise<Page | undefined> {
  return app.windows().find((candidate) =>
    candidate.url().includes('surface=floating')
  )
}

async function enableFloatingWindow(main: Page, app: ElectronApplication) {
  await main.getByTestId('titlebar-settings').click()
  const toggle = main.getByTestId('settings-floating-window')
  await toggle.click()
  await expect.poll(() => app.windows().length).toBe(2)
  await expect.poll(() => floatingWindow(app)).not.toBeUndefined()
  return (await floatingWindow(app))!
}

async function launchFixtureAgent(main: Page, name: string) {
  await main.evaluate(() => window.__vibingDebugShell?.navigate('home'))
  await main.getByTestId('home-quick-codex').click()
  await main.getByTestId('cli-config').waitFor()
  await main.getByTestId('cli-session-name').fill(name)
  await main.getByTestId('cli-launch').click()
}

test('floating-window setting owns one independent window without creating a PTY', async () => {
  const { app, window: main } = await launchApp({
    createDefaultTerminal: false
  })
  try {
    await main.getByTestId('titlebar-settings').click()
    const toggle = main.getByTestId('settings-floating-window')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect
      .poll(() => main.evaluate(() => window.ptyApi.listRecoverable()))
      .toEqual([])

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => app.windows().length).toBe(2)

    await expect.poll(() => floatingWindow(app)).not.toBeUndefined()
    const floating = await floatingWindow(app)
    expect(floating).toBeDefined()
    await expect(floating!.getByTestId('floating-window')).toBeVisible()
    await expect(floating!.getByTestId('floating-empty')).toBeVisible()
    const shadowGeometry = await floating!.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(
        '[data-testid="floating-window"]'
      )!
      const rect = panel.getBoundingClientRect()
      const backgrounds = [
        document.documentElement,
        document.body,
        document.getElementById('root')!
      ].map((element) => getComputedStyle(element).backgroundColor)
      return {
        left: rect.left,
        top: rect.top,
        right: window.innerWidth - rect.right,
        bottom: window.innerHeight - rect.bottom,
        boxShadow: getComputedStyle(panel).boxShadow,
        backgrounds
      }
    })
    expect(shadowGeometry.boxShadow).not.toBe('none')
    expect(shadowGeometry.backgrounds).toEqual([
      'rgba(0, 0, 0, 0)',
      'rgba(0, 0, 0, 0)',
      'rgba(0, 0, 0, 0)'
    ])
    expect(shadowGeometry.left).toBeGreaterThanOrEqual(8)
    expect(shadowGeometry.top).toBeGreaterThanOrEqual(8)
    expect(shadowGeometry.right).toBeGreaterThanOrEqual(8)
    expect(shadowGeometry.bottom).toBeGreaterThanOrEqual(8)
    await expect
      .poll(() => main.evaluate(() => window.ptyApi.listRecoverable()))
      .toEqual([])

    // 重复开启必须保持单例。
    await main.evaluate(() => window.floatingWindowApi.setEnabled(true))
    await expect.poll(() => app.windows().length).toBe(2)

    await floating!.getByTestId('floating-close').click()
    await expect.poll(() => app.windows().length).toBe(1)
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect
      .poll(() => main.evaluate(() => window.ptyApi.listRecoverable()))
      .toEqual([])
  } finally {
    await app.close()
  }
})

test('floating window follows the real Agent projection and removes exited sessions', async () => {
  const { app, window: main } = await launchApp({
    createDefaultTerminal: false,
    env: { VIBING_FIXTURE_OBSERVER: '1' }
  })
  try {
    const floating = await enableFloatingWindow(main, app)
    await launchFixtureAgent(main, 'Floating fixture')

    const item = floating.getByTestId('floating-session-item')
    await expect(item).toBeVisible({ timeout: 15_000 })
    await expect(item).toContainText('Floating fixture')
    await expect(item.locator('.bg-status-working-dot')).toBeVisible({
      timeout: 15_000
    })
    await main.evaluate(() => window.windowApi.close())
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const mainWindow = BrowserWindow.getAllWindows().find(
            (win) => !win.webContents.getURL().includes('surface=floating')
          )
          return Boolean(mainWindow?.isVisible())
        })
      )
      .toBe(false)
    await expect(item.locator('.bg-status-needs-you-dot')).toBeVisible({
      timeout: 15_000
    })
    await expect(floating.getByTestId('floating-attention-count')).toHaveText(
      '1'
    )

    await expect(item).toHaveCount(0, { timeout: 15_000 })
    await expect(floating.getByTestId('floating-empty')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('floating window keeps the newest three sessions collapsed and expands all', async () => {
  const { app, window: main } = await launchApp({
    createDefaultTerminal: false,
    env: {
      VIBING_FIXTURE_OBSERVER: '1',
      VIBING_FIXTURE_OBSERVER_HOLD: '1'
    }
  })
  try {
    const floating = await enableFloatingWindow(main, app)
    for (let index = 1; index <= 4; index++) {
      await launchFixtureAgent(main, `Queue ${index}`)
      await expect
        .poll(() => main.evaluate(() => window.agentApi.listActive().then((v) => v.length)))
        .toBe(index)
    }

    const items = floating.getByTestId('floating-session-item')
    await expect(items).toHaveCount(3)
    await expect(items.nth(0)).toContainText('Queue 4')
    await expect(items.nth(1)).toContainText('Queue 3')
    await expect(items.nth(2)).toContainText('Queue 2')
    await expect(floating.getByTestId('floating-expand')).toBeVisible()

    await floating.getByTestId('floating-expand').click()
    await expect(items).toHaveCount(4)
    await expect(items.nth(3)).toContainText('Queue 1')
    expect(
      await floating.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    ).toBe(true)
  } finally {
    await app.close()
  }
})

test('clicking a floating session restores the main window and original terminal', async () => {
  const { app, window: main } = await launchApp({
    createDefaultTerminal: false,
    env: {
      VIBING_FIXTURE_OBSERVER: '1',
      VIBING_FIXTURE_OBSERVER_HOLD: '1'
    }
  })
  try {
    const floating = await enableFloatingWindow(main, app)
    await launchFixtureAgent(main, 'Focus target')
    await expect
      .poll(() => main.evaluate(() => window.agentApi.listActive().then((v) => v.length)))
      .toBe(1)
    const [projection] = await main.evaluate(() => window.agentApi.listActive())
    expect(projection).toBeDefined()
    await expect(floating.getByTestId('floating-session-item')).toBeVisible()

    await main.evaluate(() => window.__vibingDebugShell?.navigate('home'))
    await main.evaluate(() => window.windowApi.close())
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const mainWindow = BrowserWindow.getAllWindows().find(
            (win) => !win.webContents.getURL().includes('surface=floating')
          )
          return Boolean(mainWindow?.isVisible())
        })
      )
      .toBe(false)

    await floating.getByTestId('floating-session-item').click()
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const mainWindow = BrowserWindow.getAllWindows().find(
            (win) => !win.webContents.getURL().includes('surface=floating')
          )
          return {
            visible: Boolean(mainWindow?.isVisible()),
            focused: Boolean(mainWindow?.isFocused())
          }
        })
      )
      .toEqual({ visible: true, focused: true })
    await expect(
      main.locator(
        `[data-testid="terminal-page"][data-terminal-id="${projection.terminalId}"]`
      )
    ).toBeVisible()
    await expect(main.locator('.xterm:visible')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('floating preference survives restart and follows the main window theme', async () => {
  const first = await launchApp({ createDefaultTerminal: false })
  const { userDataDir } = first
  try {
    const floating = await enableFloatingWindow(first.window, first.app)
    const lightOverlay = await floating.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue(
        '--vib-bg-overlay'
      )
    )
    await first.window.getByTestId('settings-ui-theme-dark').click()
    await expect
      .poll(() =>
        floating.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue(
            '--vib-bg-overlay'
          )
        )
      )
      .not.toBe(lightOverlay)
    await first.window.getByTestId('settings-language').click()
    await first.window
      .getByTestId('settings-language-list')
      .getByText('English')
      .click()
    await expect(floating.getByTestId('floating-empty')).toHaveText(
      'No active sessions'
    )
  } finally {
    await first.app.close()
  }

  const second = await launchApp({
    userDataDir,
    createDefaultTerminal: false
  })
  try {
    await expect.poll(() => second.app.windows().length).toBe(2)
    const floating = await floatingWindow(second.app)
    expect(floating).toBeDefined()
    await second.window.getByTestId('titlebar-settings').click()
    await expect(
      second.window.getByTestId('settings-floating-window')
    ).toHaveAttribute('aria-checked', 'true')
    await expect
      .poll(() => second.window.evaluate(() => window.ptyApi.listRecoverable()))
      .toEqual([])
  } finally {
    await second.app.close()
  }
})

test('floating window restores its last visible position after toggling', async () => {
  const { app, window: main } = await launchApp({
    createDefaultTerminal: false
  })
  try {
    await enableFloatingWindow(main, app)
    const expected = await app.evaluate(({ BrowserWindow, screen }) => {
      const floating = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes('surface=floating')
      )!
      const workArea = screen.getPrimaryDisplay().workArea
      const x = workArea.x + 60
      const y = workArea.y + 70
      floating.setPosition(x, y)
      return { x, y }
    })
    await main.waitForTimeout(350)
    await main.evaluate(() => window.floatingWindowApi.setEnabled(false))
    await expect.poll(() => app.windows().length).toBe(1)
    await main.evaluate(() => window.floatingWindowApi.setEnabled(true))
    await expect.poll(() => app.windows().length).toBe(2)
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const floating = BrowserWindow.getAllWindows().find((win) =>
            win.webContents.getURL().includes('surface=floating')
          )
          const bounds = floating?.getBounds()
          return bounds ? { x: bounds.x, y: bounds.y } : null
        })
      )
      .toEqual(expected)
  } finally {
    await app.close()
  }
})

test('renaming an active session is projected into the floating window', async () => {
  const { app, window: main } = await launchApp({
    createDefaultTerminal: false,
    env: {
      VIBING_FIXTURE_OBSERVER: '1',
      VIBING_FIXTURE_OBSERVER_HOLD: '1'
    }
  })
  try {
    const floating = await enableFloatingWindow(main, app)
    await launchFixtureAgent(main, 'Before rename')
    await expect(floating.getByTestId('floating-session-item')).toContainText(
      'Before rename'
    )

    await main.getByTestId('sidebar-session-menu').click()
    await main.getByTestId('sidebar-session-rename').click()
    const input = main.getByRole('textbox', { name: '重命名' })
    await input.fill('After rename')
    await input.press('Enter')

    await expect(floating.getByTestId('floating-session-item')).toContainText(
      'After rename'
    )
    await floating.getByTestId('floating-close').click()
    await expect.poll(() => app.windows().length).toBe(1)
    await expect
      .poll(() => main.evaluate(() => window.agentApi.listActive().then((v) => v.length)))
      .toBe(1)
  } finally {
    await app.close()
  }
})

import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { launchApp } from './helpers'

const workspace = resolve(__dirname, 'fixtures/workspace-reader')

test('creates an ordinary terminal from the AI session context menu', async () => {
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

    const session = window.getByTestId('sidebar-session-item')
    await expect(session).toBeVisible({ timeout: 15_000 })
    await session.click({ button: 'right' })
    const menu = window.getByTestId('sidebar-session-actions-popover')
    await expect(menu).toBeVisible()
    await expect(window.getByTestId('sidebar-session-rename')).toBeVisible()
    await window.getByTestId('sidebar-session-child-terminal').click()

    const sessionId = await session.getAttribute('data-session-id')
    expect(sessionId).toBeTruthy()
    const child = window.getByTestId('sidebar-child-terminal-item')
    await expect(child).toHaveCount(1)
    await expect(window.getByTestId('sidebar-terminal-item')).toHaveCount(0)
    await expect
      .poll(() =>
        window.evaluate(async ({ cwd, parentSessionId }) => {
          const recoverable = await window.ptyApi.listRecoverable()
          return recoverable.some(
            (entry) =>
              entry.kind === 'terminal' &&
              entry.cwd === cwd &&
              entry.parentSessionId === parentSessionId
          )
        }, { cwd: workspace, parentSessionId: sessionId })
      )
      .toBe(true)
    await expect(window.getByTestId('sidebar-session-item')).toHaveCount(1)

    const toggle = window.getByTestId('sidebar-session-child-toggle')
    await toggle.click()
    await expect(child).toHaveCount(0)
    await toggle.click()
    await expect(child).toHaveCount(1)

    await window.reload()
    await window.waitForFunction(() =>
      Boolean(
        (window as unknown as Record<string, unknown>)['__vibingDebugShell']
      )
    )
    await expect(window.getByTestId('sidebar-session-child-toggle')).toBeVisible()
    await expect(window.getByTestId('sidebar-terminal-item')).toHaveCount(0)
    await window.getByTestId('sidebar-session-child-toggle').click()
    await expect(window.getByTestId('sidebar-child-terminal-item')).toHaveCount(1)

    await window.getByTestId('sidebar-session-item').hover()
    await window.getByTestId('sidebar-session-close').click()
    await window.getByTestId('close-session-confirm-submit').click()
    await expect(window.getByTestId('sidebar-session-item')).toHaveCount(0)
    await expect(window.getByTestId('sidebar-child-terminal-item')).toHaveCount(0)
    await expect
      .poll(() => window.evaluate(() => window.ptyApi.listRecoverable()))
      .toEqual([])
  } finally {
    await app.close()
  }
})

test('uses the runtime home when the AI workspace is left empty', async () => {
  const { app, window } = await launchApp({
    createDefaultTerminal: false,
    env: {
      VIBING_FIXTURE_OBSERVER: '1',
      VIBING_FIXTURE_OBSERVER_HOLD: '1'
    }
  })
  try {
    const home = await app.evaluate(({ app: electronApp }) => electronApp.getPath('home'))

    await window.getByTestId('home-quick-codex').click()
    await window.getByTestId('cli-workspace').fill('')
    await window.getByTestId('cli-installation-windows').click()
    await window.getByTestId('cli-launch').click()

    const session = window.getByTestId('sidebar-session-item')
    await expect(session).toBeVisible({ timeout: 15_000 })
    const sessionId = await session.getAttribute('data-session-id')
    expect(sessionId).toBeTruthy()
    await expect
      .poll(() =>
        window.evaluate(async ({ cwd }) => {
          const recoverable = await window.ptyApi.listRecoverable()
          return recoverable.some((entry) => entry.kind === 'agent' && entry.cwd === cwd)
        }, { cwd: home })
      )
      .toBe(true)

    await session.click({ button: 'right' })
    await window.getByTestId('sidebar-session-child-terminal').click()
    await expect(window.getByTestId('sidebar-child-terminal-item')).toHaveCount(1)
    await expect
      .poll(() =>
        window.evaluate(async ({ cwd, parentSessionId }) => {
          const recoverable = await window.ptyApi.listRecoverable()
          return recoverable.some(
            (entry) =>
              entry.kind === 'terminal' &&
              entry.cwd === cwd &&
              entry.parentSessionId === parentSessionId
          )
        }, { cwd: home, parentSessionId: sessionId })
      )
      .toBe(true)
  } finally {
    await app.close()
  }
})

test('keeps AI session rows aligned when only one session has child terminals', async () => {
  const { app, window } = await launchApp({
    createDefaultTerminal: false,
    env: {
      VIBING_FIXTURE_OBSERVER: '1',
      VIBING_FIXTURE_OBSERVER_HOLD: '1'
    }
  })
  try {
    for (let index = 0; index < 2; index++) {
      if (index > 0) await window.getByTestId('nav-home').click()
      await window.getByTestId('home-quick-codex').click()
      await window.getByTestId('cli-installation-windows').click()
      await window.getByTestId('cli-launch').click()
      await expect(window.getByTestId('sidebar-session-item')).toHaveCount(
        index + 1,
        { timeout: 15_000 }
      )
    }

    const sessions = window.getByTestId('sidebar-session-item')
    await sessions.nth(1).click({ button: 'right' })
    await window.getByTestId('sidebar-session-child-terminal').click()
    await expect(window.getByTestId('sidebar-child-terminal-item')).toHaveCount(1)

    const iconLefts = await sessions.evaluateAll((items) =>
      items.map((item) => item.querySelector('svg')?.getBoundingClientRect().left)
    )
    expect(iconLefts).toHaveLength(2)
    expect(Math.abs(Number(iconLefts[0]) - Number(iconLefts[1]))).toBeLessThan(1)
  } finally {
    await app.close()
  }
})

test('expands the session section for child terminals while the sidebar has free height', async () => {
  const { app, window } = await launchApp({
    createDefaultTerminal: false,
    env: {
      VIBING_FIXTURE_OBSERVER: '1',
      VIBING_FIXTURE_OBSERVER_HOLD: '1'
    }
  })
  try {
    for (let index = 0; index < 4; index++) {
      if (index > 0) await window.getByTestId('nav-home').click()
      await window.getByTestId('home-quick-codex').click()
      await window.getByTestId('cli-installation-windows').click()
      await window.getByTestId('cli-launch').click()
      await expect(window.getByTestId('sidebar-session-item')).toHaveCount(index + 1, {
        timeout: 15_000
      })
    }

    const sessions = window.getByTestId('sidebar-session-item')
    for (const index of [0, 1]) {
      await sessions.nth(index).click({ button: 'right' })
      await window.getByTestId('sidebar-session-child-terminal').click()
      await expect(window.getByTestId('sidebar-child-terminal-item')).toHaveCount(index + 1)
    }

    const dimensions = await window.getByTestId('sidebar-session-list').evaluate((list) => ({
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
      availableHeight: list.parentElement?.parentElement?.clientHeight ?? 0
    }))
    expect(dimensions.availableHeight).toBeGreaterThan(dimensions.scrollHeight)
    expect(dimensions.clientHeight).toBe(dimensions.scrollHeight)
  } finally {
    await app.close()
  }
})

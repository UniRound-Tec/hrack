import {
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import type { RecoverablePty } from '../shared/ipc-contract'
import { launchApp } from './helpers'

async function waitForRenderer(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      Boolean(
        window.__vibingDebugShell &&
        (window as unknown as Record<string, unknown>)['__vibingDebugTabs']
      ),
    null,
    { polling: 100, timeout: 30_000 }
  )
  await page.evaluate(() => window.__vibingDebugShell?.setNavMode('sidebar'))
}

async function recoverable(page: Page): Promise<RecoverablePty[]> {
  return page.evaluate(() => window.ptyApi.listRecoverable())
}

async function launchFixtureAgent(page: Page): Promise<void> {
  await page.evaluate(() => window.__vibingDebugShell?.navigate('home'))
  await page.getByTestId('home-quick-codex').click()
  await page.getByTestId('cli-config').waitFor()
  await page.getByTestId('cli-launch').click()
  await page.getByTestId('sidebar-session-item').waitFor({ timeout: 15_000 })
}

test.describe('renderer reload instance lifecycle', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeEach(async () => {
    ;({ app, window: page } = await launchApp({
      env: { VIBING_FIXTURE_OBSERVER: '1' }
    }))
  })

  test.afterEach(async () => app?.close())

  test('closing an agent then reloading keeps the original ordinary terminal', async () => {
    const [ordinaryBefore] = await recoverable(page)
    expect(ordinaryBefore).toMatchObject({ kind: 'terminal', exited: false })

    await launchFixtureAgent(page)
    await page.getByTestId('sidebar-session-item').hover()
    await page.getByTestId('sidebar-session-close').click()

    await expect
      .poll(() => page.evaluate(() => window.agentApi.listActive()))
      .toEqual([])
    await expect.poll(() => recoverable(page)).toHaveLength(1)

    await page.reload()
    await waitForRenderer(page)

    const [ordinaryAfter] = await recoverable(page)
    expect(ordinaryAfter).toEqual(ordinaryBefore)
    await expect(page.getByTestId('sidebar-terminal-item')).toHaveCount(1)
    await expect(page.getByTestId('sidebar-session-item')).toHaveCount(0)
  })

  test('reloading a running agent reattaches its original PTY and terminal', async () => {
    await launchFixtureAgent(page)
    const beforePtys = await recoverable(page)
    const [beforeSession] = await page.evaluate(() =>
      window.agentApi.listActive()
    )
    const agentBefore = beforePtys.find((pty) => pty.kind === 'agent')
    expect(agentBefore).toBeTruthy()
    expect(beforeSession.terminalId).toBe(agentBefore?.terminalId)

    await page.reload()
    await waitForRenderer(page)

    await expect.poll(() => recoverable(page)).toEqual(beforePtys)
    const [afterSession] = await page.evaluate(() =>
      window.agentApi.listActive()
    )
    expect(afterSession.sessionId).toBe(beforeSession.sessionId)
    await expect(page.getByTestId('sidebar-terminal-item')).toHaveCount(1)
    await expect(page.getByTestId('sidebar-session-item')).toHaveCount(1)

    await page.getByTestId('sidebar-session-item').click()
    await expect(page.getByTestId('unavailable-terminal-page')).toHaveCount(0)
    await expect(
      page.locator(
        `[data-testid="terminal-page"][data-terminal-id="${agentBefore?.terminalId}"]`
      )
    ).toBeVisible()
    await expect(page.locator('.xterm:visible')).toHaveCount(1)
  })
})

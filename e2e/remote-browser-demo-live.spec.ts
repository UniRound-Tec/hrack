import {
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { launchApp } from './helpers'

async function createAgent(page: Page): Promise<{
  sessionId: string
  terminalId: string
  ptyId: string
}> {
  await page.getByTestId('home-quick-codex').click()
  await page.getByTestId('cli-session-name').fill('Remote browser demo fixture')
  await page.getByTestId('cli-workspace').fill(process.cwd())
  await page.getByTestId('cli-launch').click()
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const session = (await window.agentApi.listActive()).find(
            (item) => item.name === 'Remote browser demo fixture'
          )
          return session?.sessionId ?? null
        }),
      { timeout: 30_000 }
    )
    .not.toBeNull()
  return page.evaluate(async () => {
    const session = (await window.agentApi.listActive()).find(
      (item) => item.name === 'Remote browser demo fixture'
    )
    if (!session) throw new Error('real fixture session disappeared')
    const pty = (await window.ptyApi.listRecoverable()).find(
      (item) => item.terminalId === session.terminalId
    )
    if (!pty) throw new Error('real fixture PTY disappeared')
    return {
      sessionId: session.sessionId,
      terminalId: session.terminalId,
      ptyId: pty.ptyId
    }
  })
}

const targetUrl = process.env.HRACK_REMOTE_DEMO_URL

test.describe('remote browser controller live relay', () => {
  test.skip(
    !targetUrl,
    'set HRACK_REMOTE_DEMO_URL to a real relay generate page to run this gate'
  )

  test('browser page drives and releases a real Electron PTY', async ({
    page: relayPage,
    context
  }) => {
    test.skip(process.platform !== 'win32', 'interactive CLI fixture uses cmd.exe')
    test.setTimeout(60_000)
    if (!targetUrl) throw new Error('missing live relay target')

    let app: ElectronApplication | undefined
    let demoPage: Page | undefined
    let roomCreated = false
    let roomRevoked = false
    try {
      const response = await relayPage.goto(targetUrl)
      if (!response?.ok()) throw new Error('relay generate page did not load')
      await relayPage.getByTestId('create-room').click()
      await expect(relayPage.getByTestId('demo-link')).toBeVisible()
      roomCreated = true
      const demoUrl = await relayPage.getByTestId('demo-link').getAttribute('href')
      if (!demoUrl) throw new Error('relay did not provide a browser demo URL')

      const launched = await launchApp({
        createDefaultTerminal: false,
        env: {
          HRACK_FIXTURE_OBSERVER: '1',
          HRACK_FIXTURE_OBSERVER_HOLD: '1'
        }
      })
      app = launched.app
      const hrackPage = launched.window
      const agent = await createAgent(hrackPage)
      const joinUrl = await relayPage.getByTestId('join-url').innerText()

      await hrackPage.evaluate(() => window.__hrackDebugShell?.navigate('settings'))
      await hrackPage.getByTestId('settings-category-remote').click()
      await hrackPage.getByTestId('settings-remote-url').fill(joinUrl)
      await hrackPage.getByTestId('settings-remote-connect').click()
      await hrackPage.getByTestId('settings-remote-confirm-accept').click()
      await expect(hrackPage.getByTestId('settings-remote-status')).toHaveAttribute(
        'data-remote-phase',
        'waiting-phone'
      )

      demoPage = await context.newPage()
      await demoPage.goto(new URL(demoUrl, targetUrl).href)
      await demoPage.getByTestId('demo-connect').click()
      await expect(demoPage.getByTestId('demo-status')).toHaveAttribute(
        'data-phase',
        'peer-online'
      )
      const session = demoPage
        .getByTestId('demo-session')
        .filter({ hasText: 'Remote browser demo fixture' })
      await expect(session).toBeVisible()
      await session.click()
      await expect(demoPage.getByTestId('demo-terminal-view')).toBeVisible()
      await expect(demoPage.getByTestId('demo-status')).toHaveAttribute(
        'data-phase',
        'driving'
      )

      await hrackPage.evaluate((terminalId) => {
        window.__hrackDebugShell?.navigate(`terminal:${terminalId}`)
      }, agent.terminalId)
      await expect(hrackPage.getByTestId('terminal-remote-overlay')).toBeVisible()

      const marker = `HRACK_BROWSER_DEMO_${Date.now()}`
      await demoPage.locator('.xterm-helper-textarea').focus()
      await demoPage.keyboard.type(`echo ${marker}`)
      await demoPage.keyboard.press('Enter')
      await expect
        .poll(() =>
          hrackPage.evaluate(async (ptyId) => {
            const history = await window.ptyApi.getHistory(ptyId)
            return history?.events
              .filter((event) => event.kind === 'output')
              .map((event) => (event.kind === 'output' ? event.data : ''))
              .join('')
          }, agent.ptyId)
        )
        .toContain(marker)
      await expect(demoPage.locator('.xterm-rows')).toContainText(marker)

      await demoPage.getByTestId('demo-return').click()
      await expect(demoPage.getByTestId('demo-session-list')).toBeVisible()
      await expect(hrackPage.getByTestId('terminal-remote-overlay')).toHaveCount(0)

      await relayPage.getByTestId('revoke-room').click()
      await expect(relayPage.getByTestId('status')).toHaveText('Room revoked.')
      roomRevoked = true
    } finally {
      if (roomCreated && !roomRevoked) {
        const revoke = relayPage.getByTestId('revoke-room')
        if (await revoke.isVisible().catch(() => false)) {
          await revoke.click().catch(() => {})
        }
      }
      await demoPage?.close().catch(() => {})
      await app?.close().catch(() => {})
    }
  })
})

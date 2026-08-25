import {
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { launchApp } from './helpers'
import {
  parseJoinUrl,
  parseRemoteFrame,
  type RemoteMessage
} from '../shared/remote-protocol'

interface PhoneFixture {
  ws: WebSocket
  messages: RemoteMessage[]
}

async function openPhone(joinUrl: string): Promise<PhoneFixture> {
  const parsed = parseJoinUrl(joinUrl)
  if (!parsed.ok) throw new Error('relay generated an invalid join URL')
  const messages: RemoteMessage[] = []
  const ws = new WebSocket(parsed.value.wsUrl)
  ws.addEventListener('message', (event) => {
    const frame = parseRemoteFrame(String(event.data))
    if (frame.ok) messages.push(frame.value)
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener(
      'error',
      () => reject(new Error('phone WSS connection failed')),
      { once: true }
    )
  })
  ws.send(
    JSON.stringify({
      v: 1,
      type: 'hello',
      role: 'phone',
      roomId: parsed.value.roomId
    })
  )
  return { ws, messages }
}

async function createAgent(page: Page): Promise<{
  sessionId: string
  terminalId: string
  ptyId: string
}> {
  await page.getByTestId('home-quick-codex').click()
  await page.getByTestId('cli-session-name').fill('Remote P4 live fixture')
  await page.getByTestId('cli-workspace').fill(process.cwd())
  await page.getByTestId('cli-launch').click()
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const session = (await window.agentApi.listActive()).find(
            (item) => item.name === 'Remote P4 live fixture'
          )
          return session?.sessionId ?? null
        }),
      { timeout: 30_000 }
    )
    .not.toBeNull()
  return page.evaluate(async () => {
    const session = (await window.agentApi.listActive()).find(
      (item) => item.name === 'Remote P4 live fixture'
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

const targetUrl = process.env.HRACK_REMOTE_P4_URL

test.describe('remote P4 live relay', () => {
  test.skip(
    !targetUrl,
    'set HRACK_REMOTE_P4_URL to a real relay generate page to run this gate'
  )

  test('drives and reclaims a real Electron PTY through the deployed relay', async ({
    page: relayPage
  }) => {
    test.skip(process.platform !== 'win32', 'interactive CLI fixture uses cmd.exe')
    test.setTimeout(60_000)
    if (!targetUrl) throw new Error('missing live relay target')

    let app: ElectronApplication | undefined
    let phone: PhoneFixture | undefined
    let roomCreated = false
    let roomRevoked = false
    try {
      const response = await relayPage.goto(targetUrl)
      if (!response?.ok()) throw new Error('relay generate page did not load')
      await relayPage.getByTestId('create-room').click()
      await expect(relayPage.getByTestId('join-url')).toBeVisible()
      roomCreated = true
      const joinUrl = await relayPage.getByTestId('join-url').innerText()

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

      await hrackPage.evaluate(() => window.__hrackDebugShell?.navigate('settings'))
      await hrackPage.getByTestId('settings-category-remote').click()
      await hrackPage.getByTestId('settings-remote-url').fill(joinUrl)
      await hrackPage.getByTestId('settings-remote-connect').click()
      await hrackPage.getByTestId('settings-remote-confirm-accept').click()
      await expect(hrackPage.getByTestId('settings-remote-status')).toHaveAttribute(
        'data-remote-phase',
        'waiting-phone'
      )

      phone = await openPhone(joinUrl)
      await expect
        .poll(() => phone?.messages.some((message) => message.type === 'hello-ok'))
        .toBe(true)
      phone.ws.send(
        JSON.stringify({
          v: 1,
          type: 'drive',
          requestId: 'p4-live-drive',
          sessionId: agent.sessionId,
          cols: 44,
          rows: 19
        })
      )
      await expect
        .poll(() =>
          phone?.messages.find(
            (message) =>
              message.type === 'drive-ok' &&
              message.requestId === 'p4-live-drive'
          )
        )
        .toMatchObject({
          type: 'drive-ok',
          sessionId: agent.sessionId,
          cols: 44,
          rows: 19
        })

      const marker = `HRACK_P4_LIVE_${Date.now()}`
      phone.ws.send(
        JSON.stringify({
          v: 1,
          type: 'pty-in',
          sessionId: agent.sessionId,
          data: `echo ${marker}\r`
        })
      )
      await expect
        .poll(() =>
          phone?.messages
            .filter(
              (message) =>
                message.type === 'pty-out' &&
                message.sessionId === agent.sessionId
            )
            .map((message) =>
              message.type === 'pty-out'
                ? Buffer.from(message.data, 'base64').toString('utf8')
                : ''
            )
            .join('')
        )
        .toContain(marker)
      for (const message of phone.messages) {
        if (message.type !== 'pty-out') continue
        phone.ws.send(
          JSON.stringify({
            v: 1,
            type: 'pty-ack',
            sessionId: agent.sessionId,
            bytes: message.byteLength
          })
        )
      }
      await expect
        .poll(() =>
          hrackPage.evaluate(async (ptyId) => {
            const resize = (await window.ptyApi.getHistory(ptyId))?.events
              .filter((event) => event.kind === 'resize')
              .at(-1)
            return resize?.kind === 'resize'
              ? { cols: resize.cols, rows: resize.rows }
              : null
          }, agent.ptyId)
        )
        .toEqual({ cols: 44, rows: 19 })

      await hrackPage.evaluate((terminalId) => {
        window.__hrackDebugShell?.navigate(`terminal:${terminalId}`)
      }, agent.terminalId)
      await expect(hrackPage.getByTestId('terminal-remote-overlay')).toBeVisible()
      await hrackPage.getByTestId('terminal-remote-reclaim').click()
      await expect
        .poll(() =>
          phone?.messages.find(
            (message) =>
              message.type === 'undriven' &&
              message.sessionId === agent.sessionId
          )
        )
        .toMatchObject({ type: 'undriven', reason: 'reclaim' })

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
      phone?.ws.close()
      await app?.close().catch(() => {})
    }
  })
})

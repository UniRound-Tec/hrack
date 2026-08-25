import {
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import { launchApp } from './helpers'
import {
  parseJoinUrl,
  parseRemoteFrame,
  type RemoteMessage
} from '../shared/remote-protocol'

const decodeQr = jsQR as unknown as (
  data: Uint8ClampedArray,
  width: number,
  height: number
) => { data: string } | null

interface PhoneFixture {
  ws: WebSocket
  messages: RemoteMessage[]
}

async function openPhone(joinUrl: string): Promise<PhoneFixture> {
  const parsedJoin = parseJoinUrl(joinUrl)
  if (!parsedJoin.ok) throw new Error('relay generated an invalid join URL')

  const messages: RemoteMessage[] = []
  const ws = new WebSocket(parsedJoin.value.wsUrl)
  ws.addEventListener('message', (event) => {
    const parsed = parseRemoteFrame(String(event.data))
    if (parsed.ok) messages.push(parsed.value)
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
      roomId: parsedJoin.value.roomId
    })
  )
  return { ws, messages }
}

async function openRemoteSettings(page: Page): Promise<void> {
  await page.evaluate(() => window.__hrackDebugShell?.navigate('settings'))
  await page.getByTestId('settings-category-remote').click()
  await expect(page.getByTestId('settings-remote')).toBeVisible()
}

const targetUrl = process.env.HRACK_REMOTE_P3_URL

test.describe('remote P3 live relay', () => {
  test.skip(
    !targetUrl,
    'set HRACK_REMOTE_P3_URL to a real relay generate page to run this gate'
  )

  test('generated room carries a real Electron session snapshot and exact HRack QR', async ({
    page: relayPage
  }) => {
    test.skip(process.platform !== 'win32', 'interactive CLI fixture uses cmd.exe')
    if (!targetUrl) throw new Error('missing live relay target')

    let app: ElectronApplication | undefined
    let phone: PhoneFixture | undefined
    let roomCreated = false
    let roomRevoked = false

    try {
      const response = await relayPage.goto(targetUrl)
      if (!response?.ok()) throw new Error('relay generate page did not load')
      await expect(relayPage.getByTestId('create-room')).toBeVisible()
      await relayPage.getByTestId('create-room').click()
      await expect(relayPage.getByTestId('join-url')).toBeVisible()
      roomCreated = true

      const joinUrl = await relayPage.getByTestId('join-url').innerText()
      const parsedJoin = parseJoinUrl(joinUrl)
      if (!parsedJoin.ok) throw new Error('relay generated an invalid join URL')

      const launched = await launchApp({
        createDefaultTerminal: false,
        env: {
          HRACK_FIXTURE_OBSERVER: '1',
          HRACK_FIXTURE_OBSERVER_HOLD: '1'
        }
      })
      app = launched.app
      const hrackPage = launched.window

      await hrackPage.getByTestId('home-quick-codex').click()
      await hrackPage.getByTestId('cli-session-name').fill('Remote P3 live fixture')
      await hrackPage.getByTestId('cli-workspace').fill(process.cwd())
      await hrackPage.getByTestId('cli-launch').click()
      await expect
        .poll(
          () =>
            hrackPage.evaluate(async () => {
              const session = (await window.agentApi.listActive()).find(
                (item) => item.name === 'Remote P3 live fixture'
              )
              return session?.sessionId ?? null
            }),
          { timeout: 30_000 }
        )
        .not.toBeNull()
      const sessionId = await hrackPage.evaluate(async () => {
        const session = (await window.agentApi.listActive()).find(
          (item) => item.name === 'Remote P3 live fixture'
        )
        if (!session) throw new Error('real fixture session disappeared')
        return session.sessionId
      })

      await openRemoteSettings(hrackPage)
      await hrackPage.getByTestId('settings-remote-url').fill(joinUrl)
      const qrScreenshot = await hrackPage
        .getByTestId('settings-remote-qr')
        .screenshot()
      const qrImage = PNG.sync.read(qrScreenshot)
      const decodedQr = decodeQr(
        Uint8ClampedArray.from(qrImage.data),
        qrImage.width,
        qrImage.height
      )
      if (decodedQr?.data !== joinUrl) {
        throw new Error('HRack QR did not decode to the exact generated join URL')
      }

      await hrackPage.getByTestId('settings-remote-connect').click()
      await expect(hrackPage.getByTestId('settings-remote-confirm')).toBeVisible()
      await hrackPage.getByTestId('settings-remote-confirm-accept').click()
      await expect
        .poll(() =>
          hrackPage
            .getByTestId('settings-remote-status')
            .getAttribute('data-remote-phase')
        )
        .toBe('waiting-phone')

      phone = await openPhone(joinUrl)
      await expect
        .poll(() => phone?.messages.some((message) => message.type === 'hello-ok'))
        .toBe(true)
      await expect
        .poll(() =>
          phone?.messages.find(
            (message) =>
              message.type === 'sessions-snapshot' &&
              message.sessions.some(
                (session) =>
                  session.sessionId === sessionId &&
                  session.name === 'Remote P3 live fixture' &&
                  session.workspace === process.cwd()
              )
          )
        )
        .toBeTruthy()
      await expect(hrackPage.getByTestId('settings-remote-status')).toHaveAttribute(
        'data-remote-phase',
        'peer-online'
      )

      await relayPage.getByTestId('revoke-room').click()
      await expect(relayPage.getByTestId('status')).toHaveText('Room revoked.')
      roomRevoked = true
      await expect
        .poll(() => phone?.messages.some((message) => message.type === 'revoked'))
        .toBe(true)
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

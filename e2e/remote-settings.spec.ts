import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { dumpBuffer, launchApp, typeInTerminal } from './helpers'
import { RemoteTestRelay } from './helpers/remoteTestRelay'
import {
  parseRemoteFrame,
  type RemoteMessage
} from '../shared/remote-protocol'

async function openPhone(
  relay: RemoteTestRelay,
  roomId: string
): Promise<{ ws: WebSocket; messages: RemoteMessage[] }> {
  const messages: RemoteMessage[] = []
  const ws = new WebSocket(`${relay.origin}${relay.base}/v1/ws`)
  ws.addEventListener('message', (event) => {
    const parsed = parseRemoteFrame(String(event.data))
    if (parsed.ok) messages.push(parsed.value)
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('phone socket failed')))
  })
  ws.send(JSON.stringify({ v: 1, type: 'hello', role: 'phone', roomId }))
  return { ws, messages }
}

test.describe('remote settings', () => {
  let app: ElectronApplication
  let page: Page
  let relay: RemoteTestRelay
  let userDataDir: string

  test.beforeEach(async () => {
    relay = await RemoteTestRelay.listen(0, '/remote')
    relay.openRoom('aK3')
    ;({ app, window: page, userDataDir } = await launchApp({
      createDefaultTerminal: false,
      env: {
        HRACK_FIXTURE_OBSERVER: '1',
        HRACK_FIXTURE_OBSERVER_HOLD: '1'
      }
    }))
    await page.evaluate(() => {
      window.__hrackDebugShell?.navigate('settings')
    })
    await page.getByTestId('settings-category-remote').click()
  })

  test.afterEach(async () => {
    await app?.close()
    await relay?.close()
  })

  test('confirms the join URL then hellos the test relay as desktop', async () => {
    const joinUrl = relay.joinUrl('aK3')
    await expect(page.getByTestId('settings-remote-create-url')).toHaveAttribute(
      'href',
      'https://hrack.dev/'
    )
    await page.getByTestId('settings-remote-url').fill(joinUrl)
    await expect(page.getByTestId('settings-remote-qr')).toHaveAttribute(
      'data-qr-url',
      joinUrl
    )
    await page.getByTestId('settings-remote-connect').click()
    await expect(page.getByTestId('settings-remote-confirm')).toBeVisible()
    await expect(page.getByTestId('settings-remote-confirm')).toContainText(
      '127.0.0.1'
    )
    await page.getByTestId('settings-remote-confirm-accept').click()
    await expect
      .poll(async () =>
        page.getByTestId('settings-remote-status').getAttribute('data-remote-phase')
      )
      .toBe('waiting-phone')
    await expect(page.getByTestId('settings-remote-status')).toHaveText(
      '已连接，等待手机'
    )
    await expect(page.getByTestId('settings-remote-indicator')).toHaveClass(
      /bg-status-done/
    )
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await window.remoteApi.getState()).latencyMs ?? -1
        )
      )
      .toBeGreaterThanOrEqual(0)
    await expect(page.getByTestId('settings-remote-latency')).toContainText(
      'ms'
    )
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const state = await window.remoteApi.getState()
          return [state.uploadedBytes, state.downloadedBytes]
        })
      )
      .toEqual([expect.any(Number), expect.any(Number)])
    const traffic = await page.evaluate(async () => {
      const state = await window.remoteApi.getState()
      return {
        uploaded: state.uploadedBytes,
        downloaded: state.downloadedBytes
      }
    })
    expect(traffic.uploaded).toBeGreaterThan(0)
    expect(traffic.downloaded).toBeGreaterThan(0)
    await expect(page.getByTestId('settings-remote-traffic')).toContainText('↑')
    await expect(page.getByTestId('settings-remote-traffic')).toContainText('↓')
    await expect.poll(() => relay.hellos).toEqual([
      { role: 'desktop', roomId: 'aK3' }
    ])
  })

  test('DSH remote access is enabled by default without a settings toggle', async () => {
    await expect(page.getByTestId('settings-remote-dsh')).toHaveCount(0)
    await expect(page.getByTestId('settings-remote-dsh-status')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.remoteApi.getDshState()))
      .toMatchObject({ enabled: true, relaySupported: false })
  })

  test('persists the join URL and reconnects automatically after restart', async () => {
    const joinUrl = relay.joinUrl('aK3')
    await page.getByTestId('settings-remote-url').fill(joinUrl)
    await page.getByTestId('settings-remote-connect').click()
    await page.getByTestId('settings-remote-confirm-accept').click()
    await expect.poll(() => relay.hellos.filter(({ role }) => role === 'desktop').length)
      .toBe(1)

    const phone = await openPhone(relay, 'aK3')
    await app.close()
    await expect.poll(() => phone.messages.some(
      (message) => message.type === 'peer-leave' && message.role === 'desktop'
    )).toBe(true)

    const restarted = await launchApp({
      userDataDir,
      createDefaultTerminal: false,
      env: {
        HRACK_FIXTURE_OBSERVER: '1',
        HRACK_FIXTURE_OBSERVER_HOLD: '1'
      }
    })
    app = restarted.app
    page = restarted.window

    await expect.poll(() => relay.hellos.filter(({ role }) => role === 'desktop').length)
      .toBe(2)
    await expect.poll(() => page.evaluate(() => window.remoteApi.getState()))
      .toMatchObject({ phase: 'peer-online', href: joinUrl })

    await page.evaluate(() => window.__hrackDebugShell?.navigate('settings'))
    await page.getByTestId('settings-category-remote').click()
    await expect(page.getByTestId('settings-remote-url')).toHaveValue(joinUrl)
    await expect(page.getByTestId('settings-remote-status')).toHaveText(
      '手机已连接'
    )
  })

  test('real Electron session stays exited remotely until explicit close, then disconnects', async () => {
    test.skip(process.platform !== 'win32', 'interactive CLI fixture uses cmd.exe')
    const joinUrl = relay.joinUrl('aK3')
    await page.getByTestId('settings-remote-url').fill(joinUrl)
    await page.getByTestId('settings-remote-connect').click()
    await page.getByTestId('settings-remote-confirm-accept').click()
    await expect
      .poll(async () =>
        page.getByTestId('settings-remote-status').getAttribute('data-remote-phase')
      )
      .toBe('waiting-phone')

    await page.evaluate(() => window.__hrackDebugShell?.navigate('home'))
    await page.getByTestId('home-quick-codex').click()
    await page.getByTestId('cli-session-name').fill('Remote real fixture')
    await page.getByTestId('cli-workspace').fill(process.cwd())
    await page.getByTestId('cli-launch').click()
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const session = (await window.agentApi.listActive()).find(
              (item) => item.name === 'Remote real fixture'
            )
            return session?.sessionId ?? null
          }),
        { timeout: 30_000 }
      )
      .not.toBeNull()
    const sessionId = await page.evaluate(async () => {
      const session = (await window.agentApi.listActive()).find(
        (item) => item.name === 'Remote real fixture'
      )
      if (!session) throw new Error('real fixture session disappeared')
      return session.sessionId
    })

    const phone = await openPhone(relay, 'aK3')
    await expect
      .poll(() =>
        phone.messages.find(
          (message) =>
            message.type === 'sessions-snapshot' &&
            message.sessions.some((session) => session.sessionId === sessionId)
        )
      )
      .toBeTruthy()
    await expect.poll(async () => (await dumpBuffer(page)).join('\n')).toContain('>')

    await typeInTerminal(page, 'exit')
    await page.keyboard.press('Enter')
    await expect
      .poll(() =>
        phone.messages.find(
          (message) =>
            message.type === 'session-upsert' &&
            message.session.sessionId === sessionId &&
            message.session.status === 'exited'
        )
      )
      .toBeTruthy()
    await page.waitForTimeout(300)
    expect(
      phone.messages.some(
        (message) =>
          message.type === 'session-removed' && message.sessionId === sessionId
      )
    ).toBe(false)
    await expect(page.getByTestId('sidebar-session-item')).toHaveCount(1)

    await page.getByTestId('sidebar-session-item').hover()
    await page.getByTestId('sidebar-session-close').click()
    await page.getByTestId('close-session-confirm-submit').click()
    await expect
      .poll(() =>
        phone.messages.some(
          (message) =>
            message.type === 'session-removed' && message.sessionId === sessionId
        )
      )
      .toBe(true)

    await page.evaluate(() => window.__hrackDebugShell?.navigate('settings'))
    await page.getByTestId('settings-category-remote').click()
    await expect(page.getByTestId('settings-remote-revoke')).toHaveCount(0)
    await page.getByTestId('settings-remote-disconnect').click()
    await expect(page.getByTestId('settings-remote-status')).toHaveAttribute(
      'data-remote-phase',
      'idle'
    )
    expect(relay.revokes).toEqual([])
  })
})

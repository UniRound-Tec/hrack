import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './helpers'
import { RemoteTestRelay } from './helpers/remoteTestRelay'

test.describe('remote settings', () => {
  let app: ElectronApplication
  let page: Page
  let relay: RemoteTestRelay

  test.beforeEach(async () => {
    relay = await RemoteTestRelay.listen()
    relay.openRoom('aK3')
    ;({ app, window: page } = await launchApp())
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
    await expect.poll(() => relay.hellos).toEqual([
      { role: 'desktop', roomId: 'aK3' }
    ])
  })
})

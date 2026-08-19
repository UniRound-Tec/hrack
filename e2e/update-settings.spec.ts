import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp, openSettings } from './helpers'

let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  ;({ app, window: page } = await launchApp({ createDefaultTerminal: false }))
})

test.afterEach(async () => {
  await app.close()
})

test('shows the current version and keeps network updates disabled in development builds', async () => {
  await openSettings(page, 'update')

  await expect(page.getByTestId('settings-update-version')).toContainText('0.3.0')
  await expect(page.getByTestId('settings-update-status')).toContainText(
    '开发版本不连接更新服务'
  )
  await expect(page.getByTestId('settings-update-action')).toBeDisabled()
})


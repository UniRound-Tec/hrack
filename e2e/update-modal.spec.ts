import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './helpers'

let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  ;({ app, window: page } = await launchApp({ createDefaultTerminal: false }))
})

test.afterEach(async () => {
  await app?.close().catch(() => {})
})

async function forceUpdateAvailable(
  app: ElectronApplication,
  version = '9.9.9',
  releaseNotes = 'Test release notes'
): Promise<void> {
  const ok = await app.evaluate(
    (_electron, args) =>
      (
        globalThis as unknown as {
          __hrackMainDebug: {
            forceUpdateAvailable(version: string, notes: string): boolean
          }
        }
      ).__hrackMainDebug.forceUpdateAvailable(args.version, args.notes),
    { version, notes: releaseNotes }
  )
  expect(ok).toBe(true)
}

test('shows update modal with release notes and can ignore this version', async () => {
  await forceUpdateAvailable(app)

  const modal = page.getByTestId('update-available-modal')
  await expect(modal).toBeVisible()
  await expect(modal).toContainText('9.9.9')
  await expect(modal).toContainText('Test release notes')

  await page.getByTestId('update-available-ignore').click()
  await expect(modal).toBeHidden()
  await expect(page.getByTestId('titlebar-update')).toHaveCount(0)
})

test('renders markdown release notes instead of raw text', async () => {
  await forceUpdateAvailable(
    app,
    '9.9.9',
    [
      '# What is new',
      '',
      '- **Fixed** crash on startup',
      '',
      'See the [changelog](https://example.com/changelog)'
    ].join('\n')
  )

  const modal = page.getByTestId('update-available-modal')
  const notes = modal.getByTestId('update-release-notes')
  await expect(notes).toBeVisible()
  // 标题渲染为 h1，而不是字面 “#”。
  await expect(notes.locator('h1')).toHaveText('What is new')
  // 列表项与加粗渲染。
  await expect(notes.locator('ul li')).toContainText('crash on startup')
  await expect(notes.locator('ul li strong')).toHaveText('Fixed')
  // 链接只展示不导航（外链交给系统浏览器的策略不变）。
  await expect(notes.locator('span[title="https://example.com/changelog"]')).toHaveText(
    'changelog'
  )
})

test('later keeps the update entry visible for a future retry', async () => {
  await forceUpdateAvailable(app)

  const modal = page.getByTestId('update-available-modal')
  await expect(modal).toBeVisible()

  await page.getByTestId('update-available-later').click()
  await expect(modal).toBeHidden()
  await expect(page.getByTestId('titlebar-update')).toBeVisible()
})

test('never stops future update modals from appearing', async () => {
  await forceUpdateAvailable(app, '9.9.9', 'First notes')

  const modal = page.getByTestId('update-available-modal')
  await expect(modal).toBeVisible()
  await page.getByTestId('update-available-never').click()
  await expect(modal).toBeHidden()

  await forceUpdateAvailable(app, '10.0.0', 'Second notes')
  await expect(page.getByTestId('update-available-modal')).toHaveCount(0)
  // 只关闭弹窗，不隐藏手动更新入口。
  await expect(page.getByTestId('titlebar-update')).toBeVisible()
})

test('update action closes the modal and starts the download path', async () => {
  await forceUpdateAvailable(app)

  const modal = page.getByTestId('update-available-modal')
  await expect(modal).toBeVisible()

  await page.getByTestId('update-available-submit').click()
  await expect(modal).toBeHidden()
})

import {
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { resolve } from 'path'
import {
  dumpBuffer,
  launchApp,
  typeInTerminal,
  waitForShellRoundTrip
} from './helpers'

/**
 * OpenCode TUI 退出回归：发送消息后 Ctrl+C 必须回到 shell，
 * 而不是让整个 pty 退出并显示 [process exited with code undefined]。
 * 默认用本地 raw-mode fixture 保持门禁确定性；真实 OpenCode/网络 smoke
 * 仅在 VIBING_E2E_REAL_OPENCODE=1 时运行。
 */

let app: ElectronApplication
let page: Page

test.setTimeout(180_000)
const realOpenCode = process.env['VIBING_E2E_REAL_OPENCODE'] === '1'
const fixturePath = resolve(__dirname, '../scripts/fixtures/opencode-tui.mjs')

async function bufferText(): Promise<string> {
  return (await dumpBuffer(page)).join('\n')
}

async function waitForBufferText(text: string, timeout = 30_000): Promise<void> {
  await expect
    .poll(() => bufferText(), {
      timeout,
      message: `终端 buffer 应包含 ${text}`
    })
    .toContain(text)
}

async function launchTui(command: string): Promise<void> {
  await waitForShellRoundTrip(page)
  await typeInTerminal(page, command)
  await page.keyboard.press('Enter')
  await waitForBufferText('Ask anything', 60_000)
}

async function launchFixture(): Promise<void> {
  await launchTui(`node ${JSON.stringify(fixturePath)}`)
}

async function sendFixtureMessage(): Promise<void> {
  await typeInTerminal(page, 'hi')
  await page.keyboard.press('Enter')
  await waitForBufferText('Fixture reply complete: hi', 15_000)
}

test.beforeEach(async () => {
  ;({ app, window: page } = await launchApp())
})

test.afterEach(async () => {
  await app?.close().catch(() => {})
})

test('OpenCode TUI fixture：未发消息时 Ctrl+C 返回 shell', async () => {
  await launchFixture()
  await page.keyboard.press('Control+c')
  await waitForShellRoundTrip(page, 30_000)
  expect(await bufferText()).not.toContain('[process exited with code')
})

test('OpenCode TUI fixture：发送消息后 Ctrl+C 返回 shell', async () => {
  await launchFixture()
  await sendFixtureMessage()
  await page.keyboard.press('Control+c')
  await waitForShellRoundTrip(page, 30_000)
  expect(await bufferText()).not.toContain('[process exited with code')
})

test('OpenCode real smoke：真实 CLI 退出后返回 shell', async () => {
  test.skip(!realOpenCode, 'set VIBING_E2E_REAL_OPENCODE=1 to run the real smoke')
  await launchTui('opencode')
  await typeInTerminal(page, 'hi')
  await page.keyboard.press('Enter')
  await waitForBufferText('hi', 15_000)
  await page.waitForTimeout(12_000)
  await page.keyboard.press('Control+c')
  await waitForShellRoundTrip(page, 30_000)
  expect(await bufferText()).not.toContain('[process exited with code')
})

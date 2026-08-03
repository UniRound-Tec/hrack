import {
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import {
  dumpBuffer,
  launchApp,
  typeInTerminal
} from './helpers'

/**
 * opencode TUI 退出回归：发送真实消息后 Ctrl+C 必须回到 shell 提示符，
 * 而不是让整个 pty 退出并显示 [process exited with code undefined]。
 * 依赖本机已登录 opencode 与可用的模型提供方（真实消息走真实网络）。
 */

let app: ElectronApplication
let page: Page

test.setTimeout(180_000)

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

async function lastNonEmptyLine(): Promise<string> {
  const lines = await dumpBuffer(page)
  return [...lines].reverse().find((line) => line.trim().length > 0) ?? ''
}

async function waitForCompletePrompt(timeout = 20_000): Promise<void> {
  await expect
    .poll(lastNonEmptyLine, {
      timeout,
      message: '最后一行应恢复成完整的 PowerShell 提示符'
    })
    .toMatch(/PS .+>\s*$/)
}

/** 启动 opencode TUI 并等到主界面出现。 */
async function launchOpencode(): Promise<void> {
  await waitForCompletePrompt()
  await typeInTerminal(page, 'opencode')
  await page.keyboard.press('Enter')
  await waitForBufferText('Ask anything', 60_000)
}

/** 发送一条真实消息并等待模型回复结束（buffer 文本开始包含回复内容）。 */
async function sendRealMessage(): Promise<void> {
  await typeInTerminal(page, 'hi')
  await page.keyboard.press('Enter')
  // 先等输入回显，再等模型回复完成（DeepSeek 对本消息回复很快）。
  await waitForBufferText('hi', 15_000)
  await page.waitForTimeout(12_000)
}

test.beforeEach(async () => {
  ;({ app, window: page } = await launchApp())
})

test.afterEach(async () => {
  await app?.close().catch(() => {})
})

test('opencode：未发消息时 Ctrl+C 退出后回到 shell 提示符', async () => {
  await launchOpencode()
  await page.keyboard.press('Control+c')
  await waitForCompletePrompt(30_000)
  const text = await bufferText()
  expect(text).not.toContain('[process exited with code')
})

test('opencode：发送真实消息后 Ctrl+C 退出必须回到 shell 提示符', async () => {
  await launchOpencode()
  await sendRealMessage()
  await page.keyboard.press('Control+c')
  await waitForCompletePrompt(30_000)
  const text = await bufferText()
  expect(text).not.toContain('[process exited with code')
})

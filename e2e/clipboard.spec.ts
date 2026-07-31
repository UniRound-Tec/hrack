import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  dragSelectTerminalText,
  dumpBuffer,
  launchApp,
  selectTerminalText,
  terminalSelection,
  typeInTerminal
} from './helpers'

let app: ElectronApplication
let window: Page
let originalClipboardText = ''

test.beforeAll(async () => {
  ;({ app, window } = await launchApp())
  originalClipboardText = await app.evaluate(({ clipboard }) =>
    clipboard.readText()
  )
})

test.afterAll(async () => {
  if (app) {
    await app.evaluate(
      ({ clipboard }, text) => clipboard.writeText(text),
      originalClipboardText
    )
  }
  await app?.close()
})

test('right click copies the current terminal selection', async () => {
  const token = `RIGHT_CLICK_COPY_${Date.now()}`
  await app.evaluate(({ clipboard }) => clipboard.clear())

  await expect
    .poll(async () => (await dumpBuffer(window)).join('\n'))
    .toContain('PS ')
  await typeInTerminal(window, `Write-Output "${token}"`)
  await window.keyboard.press('Enter')
  await expect
    .poll(async () => (await dumpBuffer(window)).join('\n'))
    .toContain(token)
  expect(await selectTerminalText(window, token)).toBe(true)

  await window.locator('.xterm').click({ button: 'right' })

  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(token)
  await expect
    .poll(() => terminalSelection(window))
    .toBe('')

  const toast = window.getByTestId('copy-toast')
  await expect(toast).toBeVisible()
  await expect(toast).toHaveText(/^(已复制|已複製|Copied|コピーしました|복사됨)$/)
  await expect(toast).toBeHidden({ timeout: 3_000 })
})

test('keeps pointer selection available after a TUI exits with mouse tracking enabled', async () => {
  const token = `SELECT_AFTER_EXIT_${Date.now()}`
  await typeInTerminal(window, `Write-Output "${token}"`)
  await window.keyboard.press('Enter')
  await expect
    .poll(async () => (await dumpBuffer(window)).join('\n'))
    .toContain(token)

  const terminalState = () =>
    window.evaluate(() => {
      const api = (
        window as unknown as {
          __vibingDebug: {
            mouseTrackingMode(): string
            snapshot(): { bufferType: string } | null
          }
        }
      ).__vibingDebug
      return {
        mouseTrackingMode: api.mouseTrackingMode(),
        bufferType: api.snapshot()?.bufferType
      }
    })
  const writeFixture = (data: string) =>
    window.evaluate(
      (value) =>
        (
          window as unknown as {
            __vibingDebug: { writeRenderFixture(data: string): Promise<void> }
          }
        ).__vibingDebug.writeRenderFixture(value),
      data
    )

  await writeFixture('\x1b[?1049h\x1b[?1003hTUI_ACTIVE')
  expect(await terminalState()).toEqual({
    mouseTrackingMode: 'any',
    bufferType: 'alternate'
  })
  await writeFixture('\x1b[?1049l')
  expect(await terminalState()).toEqual({
    mouseTrackingMode: 'none',
    bufferType: 'normal'
  })

  expect(await dragSelectTerminalText(window, token)).toContain(token)
})

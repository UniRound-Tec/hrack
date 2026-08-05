import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { terminalImagePasteSequence } from '../src/terminal/clipboardPaste'
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

test('selects the verified image-paste sequence without changing other TUIs', () => {
  expect(terminalImagePasteSequence('win32', 'claude-code')).toBe('\x1bv')
  expect(terminalImagePasteSequence('win32', 'opencode')).toBe('\x16')
  expect(terminalImagePasteSequence('linux', 'claude-code')).toBe('\x16')
})

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

test('preserves image-only Ctrl+V for an unrecognized TUI', async () => {
  const fixture = resolve(__dirname, 'fixtures/image-paste-input.cjs')
  await typeInTerminal(window, `node "${fixture}"`)
  await window.keyboard.press('Enter')
  await expect
    .poll(async () => (await dumpBuffer(window)).join('\n'))
    .toContain('IMAGE_PASTE_READY')

  const imageBase64 = readFileSync(
    resolve(__dirname, '../resources/tray/vibingTemplate-16.png')
  ).toString('base64')
  await app.evaluate(({ clipboard, nativeImage }, encoded) => {
    const image = nativeImage.createFromBuffer(Buffer.from(encoded, 'base64'))
    if (image.isEmpty()) throw new Error('image fixture did not decode')
    clipboard.clear()
    clipboard.writeImage(image)
    if (clipboard.readImage().isEmpty()) {
      throw new Error('image fixture did not reach the native clipboard')
    }
  }, imageBase64)
  await window.locator('.xterm:visible').click()
  await window.keyboard.press('Control+V')

  await expect
    .poll(async () => (await dumpBuffer(window)).join('\n'), {
      timeout: 5_000,
      message: '图片剪贴板的 Ctrl+V 应把粘贴手势交给 TUI'
    })
    .toContain('INPUT_HEX:16')
})

test('keeps Ctrl+V text clipboard paste intact', async () => {
  const fixture = resolve(__dirname, 'fixtures/image-paste-input.cjs')
  const text = 'TEXT_PASTE_OK'
  await typeInTerminal(window, `node "${fixture}"`)
  await window.keyboard.press('Enter')
  await expect
    .poll(async () => (await dumpBuffer(window)).join('\n'))
    .toContain('IMAGE_PASTE_READY')

  await app.evaluate(({ clipboard }, value) => {
    clipboard.clear()
    clipboard.writeText(value)
  }, text)
  await window.locator('.xterm:visible').click()
  await window.keyboard.press('Control+V')

  await expect
    .poll(async () => (await dumpBuffer(window)).join('\n'))
    .toContain(`INPUT_HEX:${Buffer.from(text).toString('hex')}`)
})

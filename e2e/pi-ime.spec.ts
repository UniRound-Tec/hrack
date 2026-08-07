import { expect, test } from '@playwright/test'
import { dumpBuffer, launchApp } from './helpers'

const enabled = process.env.VIBING_E2E_REAL_PI_IME === '1'

test.describe('terminal IME compatibility', () => {
  test('anchors pre-edit at a TUI-rendered caret when the VT cursor is hidden and parked', async () => {
    const { app, window } = await launchApp()
    try {
      await window.evaluate(() =>
        (window as unknown as {
          __vibingDebug: { writeRenderFixture(data: string): Promise<void> }
        }).__vibingDebug.writeRenderFixture(
          '\x1b[5;13H\x1b[7m \x1b[27m\x1b[1;999H\x1b[?25l'
        )
      )
      const parked = await window.evaluate(() =>
        (window as unknown as {
          __vibingDebug: {
            snapshot(): {
              cols: number
              rows: number
              cursorX: number
              showCursor: boolean
            }
          }
        }).__vibingDebug.snapshot()
      )
      expect(parked.showCursor).toBe(false)
      expect(parked.cursorX).toBeGreaterThanOrEqual(parked.cols - 1)
      const textarea = window.locator(
        '.xterm:visible .xterm-helper-textarea'
      )
      await textarea.focus()
      const cdp = await app.context().newCDPSession(window)
      await cdp.send('Input.imeSetComposition', {
        text: 'ni',
        selectionStart: 2,
        selectionEnd: 2,
        replacementStart: 0,
        replacementEnd: 0
      })
      await window.waitForTimeout(10)
      const positions = await textarea.evaluate((element) => {
        const root = element.closest('.xterm')
        const screen = root?.querySelector('.xterm-screen')?.getBoundingClientRect()
        const composition = root
          ?.querySelector('.composition-view')
          ?.getBoundingClientRect()
        return {
          screenLeft: screen?.left ?? -1,
          screenWidth: screen?.width ?? -1,
          screenTop: screen?.top ?? -1,
          screenHeight: screen?.height ?? -1,
          compositionLeft: composition?.left ?? -1,
          compositionTop: composition?.top ?? -1
        }
      })
      const cellWidth = positions.screenWidth / parked.cols
      expect(positions.compositionLeft).toBeCloseTo(
        positions.screenLeft + 12 * cellWidth,
        0
      )
      expect(positions.compositionTop).toBeCloseTo(
        positions.screenTop + 4 * (positions.screenHeight / parked.rows),
        0
      )
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('keeps xterm cursor positioning when the real VT cursor is visible', async () => {
    const { app, window } = await launchApp()
    try {
      await window.evaluate(() =>
        (window as unknown as {
          __vibingDebug: { writeRenderFixture(data: string): Promise<void> }
        }).__vibingDebug.writeRenderFixture('\x1b[?25h\x1b[1;21H')
      )
      const textarea = window.locator(
        '.xterm:visible .xterm-helper-textarea'
      )
      await textarea.focus()
      const cdp = await app.context().newCDPSession(window)
      await cdp.send('Input.imeSetComposition', {
        text: 'ni',
        selectionStart: 2,
        selectionEnd: 2,
        replacementStart: 0,
        replacementEnd: 0
      })
      await window.waitForTimeout(10)
      const positions = await textarea.evaluate((element) => {
        const root = element.closest('.xterm')
        const screen = root?.querySelector('.xterm-screen')?.getBoundingClientRect()
        const composition = root
          ?.querySelector('.composition-view')
          ?.getBoundingClientRect()
        return {
          screenLeft: screen?.left ?? -1,
          screenWidth: screen?.width ?? -1,
          compositionLeft: composition?.left ?? -1
        }
      })
      expect(positions.compositionLeft).toBeGreaterThan(
        positions.screenLeft + positions.screenWidth * 0.1
      )
      expect(positions.compositionLeft).toBeLessThan(
        positions.screenLeft + positions.screenWidth * 0.25
      )
    } finally {
      await app.close().catch(() => {})
    }
  })
})

test.describe('Pi IME composition positioning', () => {
  test.setTimeout(120_000)
  test.skip(!enabled, 'Set VIBING_E2E_REAL_PI_IME=1 to run installed Windows Pi')

  test('keeps Chinese pre-edit beside Pi caret after typing and cursor movement', async () => {
    const { app, window } = await launchApp({
      cliFixture: false,
      createDefaultTerminal: false
    })
    try {
      const quick = window.getByTestId('home-quick-pi')
      await expect(quick).toBeVisible({ timeout: 60_000 })
      await quick.click()
      const installation = window.getByTestId('cli-installation-windows')
      await expect(installation).toBeVisible({ timeout: 30_000 })
      await installation.click()
      await window.getByTestId('cli-session-name').fill('Pi IME regression')
      await window.getByTestId('cli-launch').click()

      await expect
        .poll(async () => (await dumpBuffer(window)).join('\n'), {
          timeout: 30_000,
          message: 'Pi TUI should finish startup before IME composition begins'
        })
        .toContain('0.0%/1.0M')

      const textarea = window.locator(
        '.xterm:visible .xterm-helper-textarea'
      )
      await expect(textarea).toBeVisible({ timeout: 30_000 })
      await textarea.focus()
      await window.waitForTimeout(500)

      await window.keyboard.type('abc')
      await window.waitForTimeout(300)
      await window.keyboard.press('ArrowLeft')
      await window.waitForTimeout(300)

      const cdp = await app.context().newCDPSession(window)
      await cdp.send('Input.imeSetComposition', {
        text: 'ni',
        selectionStart: 2,
        selectionEnd: 2,
        replacementStart: 0,
        replacementEnd: 0
      })
      await window.waitForTimeout(10)

      const geometry = await textarea.evaluate((element) => {
        const target = element as HTMLTextAreaElement
        const screen = target.closest('.xterm')?.querySelector('.xterm-screen')
        const composition = target
          .closest('.xterm')
          ?.querySelector('.composition-view')
        const rect = (node: Element | null | undefined) => {
          const value = node?.getBoundingClientRect()
          return value
            ? {
                left: value.left,
                top: value.top,
                width: value.width,
                height: value.height
              }
            : null
        }
        return {
          screen: rect(screen),
          textarea: rect(target),
          composition: rect(composition)
        }
      })

      const snapshot = await window.evaluate(() =>
        (window as unknown as {
          __vibingDebug: {
            snapshot(): {
              cols: number
              cursorX: number
              cursorY: number
              showCursor: boolean
            }
          }
        }).__vibingDebug.snapshot()
      )

      expect(geometry.screen).not.toBeNull()
      expect(geometry.composition).not.toBeNull()
      expect(snapshot.showCursor).toBe(false)
      expect(snapshot.cursorX).toBeGreaterThanOrEqual(snapshot.cols - 1)
      expect(geometry.composition!.left).toBeCloseTo(
        geometry.screen!.left + 2 * (geometry.screen!.width / snapshot.cols),
        0
      )
    } finally {
      await app.close().catch(() => {})
    }
  })
})

import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { launchApp } from './helpers'

test.skip(
  process.env.VIBING_E2E_REAL_CLAUDE_IMAGE !== '1',
  'Set VIBING_E2E_REAL_CLAUDE_IMAGE=1 to verify installed Claude image paste.'
)

for (const target of ['windows', 'wsl'] as const) {
  test(`pastes a native clipboard image into real Claude Code on ${target}`, async () => {
    test.setTimeout(90_000)
    const { app, window } = await launchApp({
      cliFixture: false,
      createDefaultTerminal: false
    })
    const originalText = await app.evaluate(({ clipboard }) => clipboard.readText())

    try {
      await expect(window.getByTestId('home-quick-claude')).toBeVisible({
        timeout: 45_000
      })
      await window.getByTestId('home-quick-claude').click()
      const installation =
        target === 'windows'
          ? window.getByTestId('cli-installation-windows')
          : window.locator('[data-testid^="cli-installation-wsl-"]').first()
      await expect(installation).toBeVisible()
      await installation.click()
      await window.getByTestId('cli-launch').click()

      await expect
        .poll(
          () =>
            window.evaluate(() =>
              (window.__vibingDebug?.dumpViewport() ?? []).join('\n')
            ),
          { timeout: 30_000 }
        )
        .toMatch(/Claude Code|Welcome back!|Try "/)

      const imageBase64 = readFileSync(
        resolve(__dirname, '../resources/tray/vibingTemplate-16.png')
      ).toString('base64')
      await app.evaluate(({ clipboard, nativeImage }, encoded) => {
        const image = nativeImage.createFromBuffer(Buffer.from(encoded, 'base64'))
        if (image.isEmpty()) throw new Error('image fixture did not decode')
        clipboard.clear()
        clipboard.writeImage(image)
      }, imageBase64)

      await window.locator('.xterm-helper-textarea:visible').focus()
      await window.keyboard.press('Control+V')
      await expect
        .poll(
          () =>
            window.evaluate(() =>
              (window.__vibingDebug?.dumpViewport() ?? []).join('\n')
            ),
          { timeout: 15_000 }
        )
        .toContain('[Image #1]')
    } finally {
      await app.evaluate(
        ({ clipboard }, text) => {
          clipboard.clear()
          clipboard.writeText(text)
        },
        originalText
      )
      await app.close()
    }
  })
}

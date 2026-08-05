import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import { launchApp } from './helpers'

function changedPixelRatio(before: Buffer, after: Buffer): number {
  const first = PNG.sync.read(before)
  const second = PNG.sync.read(after)
  expect(second.width).toBe(first.width)
  expect(second.height).toBe(first.height)
  const comparedHeight = Math.min(first.height, 260)
  let changed = 0
  let total = 0
  for (let y = 0; y < comparedHeight; y++) {
    for (let x = 0; x < first.width; x++) {
      const offset = (y * first.width + x) * 4
      const delta =
        Math.abs(first.data[offset] - second.data[offset]) +
        Math.abs(first.data[offset + 1] - second.data[offset + 1]) +
        Math.abs(first.data[offset + 2] - second.data[offset + 2])
      if (delta > 48) changed++
      total++
    }
  }
  return changed / Math.max(1, total)
}

test.skip(process.platform !== 'win32', 'real Claude startup layout is Windows-specific')

test('keeps the real Claude TUI geometry stable after its first output', async () => {
  test.setTimeout(60_000)
  const { app, window } = await launchApp({
    cliFixture: false,
    createDefaultTerminal: false
  })

  try {
    await expect(window.getByTestId('home-quick-claude')).toBeVisible({
      timeout: 30_000
    })
    await window.getByTestId('home-quick-claude').click()
    const windowsInstallation = window.getByTestId('cli-installation-windows')
    if (await windowsInstallation.count()) await windowsInstallation.click()

    const startupGeometry = window.evaluate(async () => {
      const samples: Array<{ at: number; cols: number; rows: number }> = []
      const startedAt = performance.now()
      while (performance.now() - startedAt < 8_000) {
        const snapshot = window.__vibingDebug?.snapshot()
        if (snapshot && snapshot.lastNonEmptyLine >= 0) {
          const previous = samples.at(-1)
          if (
            !previous ||
            previous.cols !== snapshot.cols ||
            previous.rows !== snapshot.rows
          ) {
            samples.push({
              at: Math.round(performance.now() - startedAt),
              cols: snapshot.cols,
              rows: snapshot.rows
            })
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 16))
      }
      return samples
    })

    await window.getByTestId('cli-launch').click()

    await window.waitForFunction(
      () => {
        const lines = window.__vibingDebug?.dumpViewport() ?? []
        const text = lines.join('\n')
        return text.includes('Welcome back!') && text.includes("What's new")
      },
      null,
      { polling: 10, timeout: 15_000 }
    )
    const screen = window.locator('.xterm-screen:visible')
    const firstSnapshot = await window.evaluate(() =>
      window.__vibingDebug?.snapshot()
    )
    const firstHistory = await window.evaluate(() =>
      window.__vibingDebug?.dumpAuthoritativeHistory()
    )
    const firstPaint = await screen.screenshot()
    await window.waitForTimeout(1_200)
    const stablePaint = await screen.screenshot()

    const samples = await startupGeometry
    expect(samples.length).toBeGreaterThan(0)
    expect(
      samples,
      'Claude TUI geometry changed after it had already started drawing'
    ).toHaveLength(1)
    const initialResize = firstHistory?.events.find(
      (event) => event.kind === 'resize'
    )
    expect(initialResize).toMatchObject({
      cols: firstSnapshot?.cols,
      rows: firstSnapshot?.rows
    })
    expect(
      changedPixelRatio(firstPaint, stablePaint),
      'Claude startup banner visibly changes after its buffer is already complete'
    ).toBeLessThan(0.01)
  } finally {
    await app.close()
  }
})

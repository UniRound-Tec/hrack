import { expect, test } from '@playwright/test'
import { launchApp } from './helpers'

test('DSH surface keeps the top-left rounded corner without padding', async () => {
  const { app, window } = await launchApp({ localDsh: true })
  try {
    const content = window.getByTestId('app-content')
    const contentBounds = await content.boundingBox()
    expect(contentBounds).not.toBeNull()
    await window.evaluate(() => {
      window.__hrackDebugShell?.navigate('home')
    })
    await window.getByTestId('home-quick-dsh').click()
    const surface = window.getByTestId('dsh-page')
    await expect(surface).toBeVisible({ timeout: 20_000 })
    const nativeFrame = window.getByTestId('dsh-surface-frame')
    const nativeBounds = await nativeFrame.boundingBox()
    expect(nativeBounds).not.toBeNull()
    expect(nativeBounds!.x - contentBounds!.x).toBeCloseTo(0, 1)
    expect(nativeBounds!.y - contentBounds!.y).toBeCloseTo(0, 1)
    await expect.poll(
      () => app.evaluate(() => {
        const inspection = (
          globalThis as unknown as {
            __hrackMainDebug: {
              dshSurfaceInspect(): Promise<{
                bounds?: { x: number; y: number; width: number; height: number }
              }> | null
            }
          }
        ).__hrackMainDebug.dshSurfaceInspect()
        return inspection?.then((value) => value?.bounds ?? null) ?? null
      }),
      { timeout: 20_000, intervals: [50, 100, 250] }
    ).toMatchObject({
      x: Math.round(nativeBounds!.x),
      y: Math.round(nativeBounds!.y),
      width: Math.round(nativeBounds!.width),
      height: Math.round(nativeBounds!.height)
    })
    const frame = await surface.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        radius: Number.parseFloat(style.borderTopLeftRadius),
        overflowX: style.overflowX,
        overflowY: style.overflowY
      }
    })
    expect(frame.radius).toBeGreaterThan(0)
    expect(frame.overflowX).toBe('hidden')
    expect(frame.overflowY).toBe('hidden')
  } finally {
    await app.close()
  }
})

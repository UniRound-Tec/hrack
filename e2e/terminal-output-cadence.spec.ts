import { expect, test } from '@playwright/test'
import {
  dumpBuffer,
  launchApp,
  typeInTerminal,
  waitForShellRoundTrip
} from './helpers'

interface CadenceSample {
  at: number
  baseY: number
}

interface CadenceProbe {
  frames: number[]
  changes: CadenceSample[]
  stop(): void
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

test('continuous PTY output advances the viewport at 30 FPS or better', async () => {
  const { app, window } = await launchApp()
  try {
    await waitForShellRoundTrip(window)
    const marker = `CADENCE_DONE_${Date.now()}`

    await window.evaluate(() => {
      const debugWindow = window as unknown as {
        __vibingDebug: { snapshot(): { baseY: number } | null }
        __terminalCadenceProbe?: CadenceProbe
      }
      const frames: number[] = []
      const changes: CadenceSample[] = []
      let previousBaseY = debugWindow.__vibingDebug.snapshot()?.baseY ?? -1
      let running = true
      const tick = (now: number): void => {
        frames.push(now)
        const baseY = debugWindow.__vibingDebug.snapshot()?.baseY ?? previousBaseY
        if (baseY !== previousBaseY) {
          changes.push({ at: now, baseY })
          previousBaseY = baseY
        }
        if (running) requestAnimationFrame(tick)
      }
      debugWindow.__terminalCadenceProbe = {
        frames,
        changes,
        stop() {
          running = false
        }
      }
      requestAnimationFrame(tick)
    })

    await typeInTerminal(
      window,
      `1..120 | % { "CADENCE_$($_)"; Start-Sleep -Milliseconds 8 }; echo ${marker}`
    )
    await window.keyboard.press('Enter')
    await expect
      .poll(async () => (await dumpBuffer(window)).join('\n'), { timeout: 20_000 })
      .toContain(marker)
    await window.waitForTimeout(100)

    const probe = await window.evaluate(() => {
      const debugWindow = window as unknown as {
        __terminalCadenceProbe: CadenceProbe
      }
      debugWindow.__terminalCadenceProbe.stop()
      return {
        frames: debugWindow.__terminalCadenceProbe.frames,
        changes: debugWindow.__terminalCadenceProbe.changes
      }
    })
    const frameGaps = probe.frames.slice(1).map((at, index) => at - probe.frames[index])
    const updateGaps = probe.changes.slice(1).map((entry, index) => entry.at - probe.changes[index].at)
    const rafP95 = percentile(frameGaps, 0.95)
    const updateP50 = percentile(updateGaps, 0.5)
    const updateP95 = percentile(updateGaps, 0.95)
    console.log(
      `TERMINAL_OUTPUT_CADENCE ${JSON.stringify({ rafP95, updateP50, updateP95 })}`
    )

    expect(probe.changes.length).toBeGreaterThan(10)
    expect(rafP95, '浏览器 animation frame 本身不应被节流').toBeLessThan(25)
    expect(updateP50, '持续输出的典型刷新间隔应达到 30 FPS').toBeLessThanOrEqual(34)
    expect(updateP95, '偶发调度抖动不应让输出长期低于 30 FPS').toBeLessThanOrEqual(42)
  } finally {
    await app.close()
  }
})

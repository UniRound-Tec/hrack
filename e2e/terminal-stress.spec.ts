import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import {
  clearSeqLog,
  dumpAuthoritativeHistory,
  dumpBuffer,
  dumpLogicalBuffer,
  dumpViewport,
  flowControl,
  launchApp,
  resetClearSeqLog,
  scrollLines,
  scrollToBottom,
  scrollToTop,
  setPtyAckDelay,
  snapshot,
  typeInTerminal,
  waitForShellRoundTrip
} from './helpers'

interface TerminalSnapshot {
  cols: number
  rows: number
  bufferType: 'normal' | 'alternate'
  length: number
  baseY: number
  viewportY: number
  cursorX: number
  cursorY: number
  lastNonEmptyLine: number
}

interface WindowState {
  width: number
  height: number
  zoomFactor: number
}

let app: ElectronApplication
let page: Page
let original: WindowState

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

async function readSnapshot(): Promise<TerminalSnapshot> {
  const value = await snapshot(page)
  expect(value).toBeTruthy()
  return value as TerminalSnapshot
}

async function waitForBufferText(text: string, timeout = 15_000): Promise<void> {
  await expect
    .poll(async () => (await dumpBuffer(page)).join('\n'), {
      timeout,
      message: `终端 buffer 应包含 ${text}`
    })
    .toContain(text)
}

async function waitForCompletePrompt(): Promise<void> {
  await waitForShellRoundTrip(page)
}

async function setWindowSize(width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setSize(value.width, value.height),
    { width, height }
  )
}

async function setZoomFactor(factor: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(value),
    factor
  )
}

function expectedTokens(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}_${index + 1}`)
}

function missingTokens(text: string, expected: string[]): string[] {
  return expected.filter((token) => !text.includes(token))
}

async function resizeEventCount(): Promise<number> {
  const history = await dumpAuthoritativeHistory(page)
  return history?.events.filter((event) => event.kind === 'resize').length ?? 0
}

test.beforeEach(async () => {
  ;({ app, window: page } = await launchApp())
  // Stress the terminal viewport, not the 280px expanded navigation. At the
  // 260px window floor an expanded sidebar leaves almost no terminal width,
  // multiplying soft-wrapped rows until normal xterm scrollback is evicted.
  await page.evaluate(() => window.__vibingDebugShell?.setNavMode('rail'))
  original = await app.evaluate(({ BrowserWindow }) => {
    const current = BrowserWindow.getAllWindows()[0]
    const [width, height] = current.getSize()
    return {
      width,
      height,
      zoomFactor: current.webContents.getZoomFactor()
    }
  })
  await waitForCompletePrompt()
})

test.afterEach(async () => {
  if (!app) return
  try {
    await setZoomFactor(original.zoomFactor)
    await setWindowSize(original.width, original.height)
  } catch {
    // 测试若已经让应用退出，直接走 close 清理即可。
  }
  await app.close()
})

test('idle repeated resize is not delayed by ConPTY redraw traffic', async () => {
  const observedCols = new Set<number>()
  for (let step = 1; step <= 10; step++) {
    await setWindowSize(original.width - step * 24, original.height)
    await page.waitForTimeout(25)
    observedCols.add((await readSnapshot()).cols)
  }
  expect(
    observedCols.size,
    '拖动未停止时 xterm cols 应持续变化，而不是等待 trailing debounce 后一次跳变'
  ).toBeGreaterThanOrEqual(5)

  // 启动提示符属于真实输出，先越过保护窗口；之后只测 resize 自身产生的重画。
  await page.waitForTimeout(600)
  const before = await resizeEventCount()

  await setWindowSize(original.width - 140, original.height)
  await expect
    .poll(resizeEventCount, {
      timeout: 400,
      message: '空闲终端的第一次 ConPTY resize 应快速执行'
    })
    .toBeGreaterThan(before)

  const afterFirst = await resizeEventCount()
  // 给 ConPTY 足够时间回吐并过滤第一帧重画，再发第二次 resize。
  await page.waitForTimeout(100)
  await setWindowSize(original.width - 280, original.height)
  await expect
    .poll(resizeEventCount, {
      timeout: 400,
      message: '被过滤的重画不应让下一次 resize 再等待 500ms'
    })
    .toBeGreaterThan(afterFirst)

  await waitForCompletePrompt()
})

test('sustained output is backpressured without exceeding the delivery memory limit', async () => {
  const lineCount = 1024
  const payloadBytes = 2048
  const firstToken = 'BACKPRESSURE_LINE_1_'
  const lastToken = `BACKPRESSURE_LINE_${lineCount}_`
  const doneToken = 'BACKPRESSURE_DONE'

  // xterm 仍会正常解析每个 chunk，只把“消费完成”ack 延后，确定性制造慢消费者。
  await setPtyAckDelay(page, 75)
  await typeInTerminal(
    page,
    `$payload="b"*${payloadBytes}; 1..${lineCount} | % { ` +
      `[Console]::WriteLine("BACKPRESSURE_LINE_$($_)_$payload") }; ` +
      `[Console]::WriteLine("${doneToken}")`
  )
  await page.keyboard.press('Enter')

  await expect
    .poll(async () => (await flowControl(page))?.pauseCount ?? 0, {
      timeout: 15_000,
      message: '慢消费者下主进程应触发至少一次 PTY pause'
    })
    .toBeGreaterThan(0)

  const responsivenessStartedAt = Date.now()
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  )
  expect(
    Date.now() - responsivenessStartedAt,
    '背压期间 renderer 仍应能在 1 秒内执行 animation frame'
  ).toBeLessThan(1_000)

  // 已证明 pause 后恢复正常 ack，让测试尽快排空剩余输出。
  await setPtyAckDelay(page, 0)
  await waitForBufferText(doneToken, 30_000)
  await waitForCompletePrompt()

  await expect
    .poll(async () => (await flowControl(page))?.bufferedBytes ?? -1, {
      timeout: 15_000,
      message: 'xterm 消费完成后所有在途与排队字节都应被确认'
    })
    .toBe(0)

  const flow = await flowControl(page)
  expect(flow).not.toBeNull()
  expect(flow?.pauseCount).toBeGreaterThan(0)
  expect(flow?.resumeCount).toBeGreaterThan(0)
  expect(flow?.overflowed).toBe(false)
  expect(flow?.rejectedBytes).toBe(0)
  expect(flow?.maxBufferedBytes).toBe(1024 * 1024)
  expect(flow?.maxObservedBufferedBytes).toBeLessThanOrEqual(1024 * 1024)

  const history = await dumpAuthoritativeHistory(page)
  expect(history?.complete).toBe(true)
  const raw =
    history?.events
      .filter((event) => event.kind === 'output')
      .map((event) => event.data)
      .join('') ?? ''
  expect(raw).toContain(firstToken)
  expect(raw).toContain(lastToken)
  expect(raw).toContain(doneToken)
})

test('normal buffer: output + wheel scroll + rapid resize + zoom preserve all history and cursor state', async () => {
  const seedPrefix = 'STRESS_SEED'
  const seedCount = 36
  const streamPrefix = 'STRESS_STREAM'
  const streamCount = 90

  await typeInTerminal(page, `1..${seedCount} | % { "${seedPrefix}_$($_)_" + ("s" * 96) }`)
  await page.keyboard.press('Enter')
  await waitForBufferText(`${seedPrefix}_${seedCount}`)
  await waitForCompletePrompt()

  await resetClearSeqLog(page)
  await typeInTerminal(
    page,
    `1..${streamCount} | % { "${streamPrefix}_$($_)_" + ("t" * 88); Start-Sleep -Milliseconds 30 }`
  )
  await page.keyboard.press('Enter')
  await waitForBufferText(`${streamPrefix}_8`)

  // 走真实鼠标滚轮路径，确认用户能在输出尚未完成时离开底部。
  await page.locator('.xterm-screen').hover()
  await page.mouse.wheel(0, -1600)
  await expect
    .poll(async () => {
      const current = await readSnapshot()
      return current.viewportY < current.baseY
    }, { timeout: 5_000, message: '鼠标滚轮应把视口移到 scrollback' })
    .toBe(true)

  // 输出仍在继续时交错改变宽、高和页面缩放。每次停留超过 resize debounce，
  // 确保实际经过 fit -> xterm reflow -> ConPTY resize，而不只是改变窗口外框。
  const interleavedStates = [
    { width: 320, height: original.height, zoom: 1.25 },
    { width: 900, height: 480, zoom: 0.8 },
    { width: 420, height: 760, zoom: 1.1 },
    { width: original.width, height: original.height, zoom: original.zoomFactor }
  ]
  for (const state of interleavedStates) {
    await setWindowSize(state.width, state.height)
    await setZoomFactor(state.zoom)
    await page.waitForTimeout(180)
  }

  // 再补一轮接近真实拖窗的高频小步 resize，覆盖 debounce 合并边界。
  const rapidSteps = 24
  for (let step = 0; step <= rapidSteps; step++) {
    const width = Math.round(original.width - ((original.width - 260) * step) / rapidSteps)
    await setWindowSize(width, original.height)
    await page.waitForTimeout(12)
  }
  for (let step = 0; step <= rapidSteps; step++) {
    const width = Math.round(260 + ((original.width - 260) * step) / rapidSteps)
    await setWindowSize(width, original.height)
    await page.waitForTimeout(12)
  }

  await waitForBufferText(`${streamPrefix}_${streamCount}`, 20_000)
  await page.waitForTimeout(700)

  // debug bridge 的相对/绝对滚动也各走一次，避免只验证 wheel 事件绑定。
  await scrollToTop(page)
  const top = await readSnapshot()
  expect(top.viewportY).toBe(0)
  expect(top.baseY).toBeGreaterThan(0)
  await scrollLines(page, Math.min(7, top.baseY))
  const moved = await readSnapshot()
  expect(moved.viewportY).toBeGreaterThan(top.viewportY)
  await scrollToBottom(page)
  const bottom = await readSnapshot()
  expect(bottom.viewportY).toBe(bottom.baseY)

  // resize 后继续输入，专门防止提示符/光标只恢复半行，导致下一条命令覆盖历史。
  await typeInTerminal(page, 'Write-Output "STRESS_AFTER_ALL_OK"')
  await page.keyboard.press('Enter')
  await waitForBufferText('STRESS_AFTER_ALL_OK')
  await waitForCompletePrompt()

  const rendererText = (await dumpLogicalBuffer(page)).join('\n')
  const expected = [
    ...expectedTokens(seedPrefix, seedCount),
    ...expectedTokens(streamPrefix, streamCount)
  ]
  expect(
    missingTokens(rendererText, expected),
    'normal buffer 在组合压力后不应缺少任一输出 token'
  ).toEqual([])

  const history = await dumpAuthoritativeHistory(page)
  expect(history?.complete).toBe(true)
  expect(
    history?.events.filter((event) => event.kind === 'resize').length,
    '输出静默后，合并的最新 ConPTY resize 应实际执行并进入历史边界'
  ).toBeGreaterThan(1)
  const rawHistory =
    history?.events
      .filter((event) => event.kind === 'output')
      .map((event) => event.data)
      .join('') ?? ''
  expect(
    missingTokens(rawHistory, expected),
    '主进程权威历史在组合压力后不应缺少任一输出 token'
  ).toEqual([])

  const clearLog = await clearSeqLog(page)
  expect(clearLog.ed2, 'ConPTY resize 的 ED2 重画不应进入 renderer').toBe(0)
  expect(clearLog.ed3, 'resize 期间不应清除 scrollback').toBe(0)

  const final = await readSnapshot()
  expect(final.bufferType).toBe('normal')
  expect(final.viewportY).toBe(final.baseY)
  expect(final.cursorX).toBeGreaterThanOrEqual(0)
  expect(final.cursorX).toBeLessThan(final.cols)
  expect(final.cursorY).toBeGreaterThanOrEqual(0)
  expect(final.cursorY).toBeLessThan(final.rows)
})

test('alternate buffer: resize and zoom recover the normal history and accept the next command', async () => {
  const normalPrefix = 'NORMAL_BEFORE_ALT'
  const normalCount = 28

  await typeInTerminal(page, `1..${normalCount} | % { "${normalPrefix}_$($_)_" + ("n" * 72) }`)
  await page.keyboard.press('Enter')
  await waitForBufferText(`${normalPrefix}_${normalCount}`)
  await waitForCompletePrompt()

  const enterAlternate =
    '$e=[char]27; [Console]::Write("${e}[?1049h${e}[HALT_STRESS_READY"); ' +
    '[Console]::ReadKey($true) | Out-Null; [Console]::Write("${e}[?1049l")'
  await typeInTerminal(page, enterAlternate)
  await page.keyboard.press('Enter')

  await expect
    .poll(async () => (await readSnapshot()).bufferType, {
      timeout: 10_000,
      message: '命令应进入 alternate buffer'
    })
    .toBe('alternate')
  await expect
    .poll(async () => (await dumpViewport(page)).join('\n'), { timeout: 5_000 })
    .toContain('ALT_STRESS_READY')

  // alternate buffer 按 xterm 语义没有 scrollback；滚动不应产生虚假的历史位置。
  await scrollToTop(page)
  const alternateTop = await readSnapshot()
  expect(alternateTop.viewportY).toBe(alternateTop.baseY)

  const alternateStates = [
    { width: 300, height: 430, zoom: 1.3 },
    { width: 780, height: 760, zoom: 0.75 },
    { width: 380, height: original.height, zoom: 1.15 },
    { width: original.width, height: original.height, zoom: original.zoomFactor }
  ]
  for (const state of alternateStates) {
    await setWindowSize(state.width, state.height)
    await setZoomFactor(state.zoom)
    await page.waitForTimeout(220)
    expect((await readSnapshot()).bufferType).toBe('alternate')
  }

  // ReadKey 收到一个字符后退出 alternate buffer。
  await typeInTerminal(page, 'x')
  await expect
    .poll(async () => (await readSnapshot()).bufferType, {
      timeout: 10_000,
      message: '退出全屏命令后应恢复 normal buffer'
    })
    .toBe('normal')
  await waitForCompletePrompt()

  const restoredText = (await dumpBuffer(page)).join('\n')
  expect(
    missingTokens(restoredText, expectedTokens(normalPrefix, normalCount)),
    '退出 alternate buffer 后原 normal history 应完整恢复'
  ).toEqual([])

  await typeInTerminal(page, 'Write-Output "AFTER_ALT_RESIZE_OK"')
  await page.keyboard.press('Enter')
  await waitForBufferText('AFTER_ALT_RESIZE_OK')
  await waitForCompletePrompt()

  const final = await readSnapshot()
  expect(final.bufferType).toBe('normal')
  expect(final.viewportY).toBe(final.baseY)
  expect(final.cursorX).toBeLessThan(final.cols)
  expect(final.cursorY).toBeLessThan(final.rows)
})

import { test, expect } from '@playwright/test'
import {
  launchApp,
  snapshot,
  dumpBuffer,
  dumpAuthoritativeHistory,
  typeInTerminal,
  clearSeqLog,
  resetClearSeqLog,
  setSize
} from './helpers'
import type { ElectronApplication, Page } from '@playwright/test'

/**
 * resize 内容保全测试。
 *
 * 这是把「反复人肉拖窗观察」变成可复现断言的核心测试：
 * 打印已知内容 → 用调试桥读 buffer 真实文本 → 编程改变窗口宽度 → 再读 buffer →
 * 断言内容仍在（reflow 后行数会变，但可识别的文本 token 不应消失）。
 */

let app: ElectronApplication
let window: Page

test.beforeAll(async () => {
  ;({ app, window } = await launchApp())
})

test.afterAll(async () => {
  await app?.close()
})

test('DIAGNOSTIC: does pty inject clear sequences on resize?', async () => {
  // 打印内容建立 scrollback
  await typeInTerminal(window, '1..40 | % { "CLR_LINE_$_" }')
  await window.keyboard.press('Enter')
  await window.waitForTimeout(1500)

  const beforeSnap = (await snapshot(window)) as { length: number; baseY: number; rows: number }
  await resetClearSeqLog(window)

  const size = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const [width, height] = w.getSize()
    return { width, height }
  })

  // 连续拖动缩放
  const minW = 480
  const steps = 20
  for (let i = 0; i <= steps; i++) {
    const w = Math.round(size.width - ((size.width - minW) * i) / steps)
    await app.evaluate(async ({ BrowserWindow }, arg) => BrowserWindow.getAllWindows()[0].setSize(arg.w, arg.h), { w, h: size.height })
    await window.waitForTimeout(16)
  }
  for (let i = 0; i <= steps; i++) {
    const w = Math.round(minW + ((size.width - minW) * i) / steps)
    await app.evaluate(async ({ BrowserWindow }, arg) => BrowserWindow.getAllWindows()[0].setSize(arg.w, arg.h), { w, h: size.height })
    await window.waitForTimeout(16)
  }
  await window.waitForTimeout(1000)

  const log = await clearSeqLog(window)
  const afterSnap = (await snapshot(window)) as { length: number; baseY: number; rows: number }

  // 这个测试是诊断性的：打印证据，不硬断言（先看真相）
  console.log('[DIAG] clear-seq during resize:', JSON.stringify(log))
  console.log('[DIAG] buffer before resize:', JSON.stringify(beforeSnap))
  console.log('[DIAG] buffer after resize:', JSON.stringify(afterSnap))

  // 核心怀疑：若 buffer.length 在 resize 后骤降到接近 rows，说明 scrollback 被清
  console.log(`[DIAG] length before=${beforeSnap.length} after=${afterSnap.length} rows=${afterSnap.rows}`)
})

test('debug bridge is available and reports a sane snapshot', async () => {
  const snap = await snapshot(window)
  expect(snap).toBeTruthy()
  const s = snap as { cols: number; rows: number; bufferType: string }
  expect(s.cols).toBeGreaterThan(0)
  expect(s.rows).toBeGreaterThan(0)
  expect(s.bufferType).toBe('normal')
})

test('content survives width resize (reflow keeps tokens)', async () => {
  // 打印 20 行唯一可识别内容
  await typeInTerminal(window, '1..20 | % { "VIBING_LINE_$_" }')
  await window.keyboard.press('Enter')
  // 等待输出落定
  await window.waitForTimeout(1500)

  const before = await dumpBuffer(window)
  const beforeTokens = before.join('\n').match(/VIBING_LINE_\d+/g) ?? []
  // 至少应打印出大部分行（宽度足够时 20 行都在）
  expect(beforeTokens.length).toBeGreaterThanOrEqual(10)

  // 记录初始窗口尺寸，改窄再改宽
  const size = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const [width, height] = w.getSize()
    return { width, height }
  })

  // 改窄到 500px（强制 reflow / wrap）
  await app.evaluate(async ({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0].setSize(500, s.height)
  }, size)
  await window.waitForTimeout(600)

  // 改回原宽
  await app.evaluate(async ({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0].setSize(s.width, s.height)
  }, size)
  await window.waitForTimeout(600)

  const after = await dumpBuffer(window)
  const afterTokens = new Set(after.join('\n').match(/VIBING_LINE_\d+/g) ?? [])

  // 断言：resize 前可见的每个 token，resize 后仍在 buffer 中（内容未丢）
  const missing = beforeTokens.filter((t) => !afterTokens.has(t))
  expect(missing, `resize 后丢失的行: ${missing.join(', ')}`).toEqual([])
})

test('content survives CONTINUOUS drag-like resizing (many rapid steps)', async () => {
  // 复现真实拖动：连续几十次小步 resize，而非两步 setSize。
  await typeInTerminal(window, '1..20 | % { "DRAG_LINE_$_" }')
  await window.keyboard.press('Enter')
  await window.waitForTimeout(1500)

  const before = await dumpBuffer(window)
  const beforeTokens = before.join('\n').match(/DRAG_LINE_\d+/g) ?? []
  expect(beforeTokens.length).toBeGreaterThanOrEqual(10)

  const size = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const [width, height] = w.getSize()
    return { width, height }
  })

  // 模拟拖动：从原宽连续缩到 480，再连续扩回，每步一帧(~16ms)，共约 60 步
  const minW = 480
  const steps = 30
  for (let i = 0; i <= steps; i++) {
    const w = Math.round(size.width - ((size.width - minW) * i) / steps)
    await app.evaluate(async ({ BrowserWindow }, arg) => {
      BrowserWindow.getAllWindows()[0].setSize(arg.w, arg.h)
    }, { w, h: size.height })
    await window.waitForTimeout(16)
  }
  for (let i = 0; i <= steps; i++) {
    const w = Math.round(minW + ((size.width - minW) * i) / steps)
    await app.evaluate(async ({ BrowserWindow }, arg) => {
      BrowserWindow.getAllWindows()[0].setSize(arg.w, arg.h)
    }, { w, h: size.height })
    await window.waitForTimeout(16)
  }
  // 等 debounce + ConPTY 回吐重绘落定
  await window.waitForTimeout(1000)

  const after = await dumpBuffer(window)
  const afterTokens = new Set(after.join('\n').match(/DRAG_LINE_\d+/g) ?? [])
  const missing = beforeTokens.filter((t) => !afterTokens.has(t))
  expect(missing, `连续拖动后丢失的行: ${missing.join(', ')} (before=${beforeTokens.length}, afterUnique=${afterTokens.size})`).toEqual([])
})

test('content survives MANY narrow<->wide round trips (reproduces real drag)', async () => {
  // 真实复现：反复多轮 窄↔宽 来回。日志证明 reflow 在「变宽」时会累积丢行，
  // 单次来回看不出，多轮才暴露。
  await typeInTerminal(window, '1..20 | % { "RT_LINE_$_" }')
  await window.keyboard.press('Enter')
  await window.waitForTimeout(1500)

  const before = await dumpBuffer(window)
  const beforeTokens = before.join('\n').match(/RT_LINE_\d+/g) ?? []
  expect(beforeTokens.length).toBeGreaterThanOrEqual(10)

  const size = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const [width, height] = w.getSize()
    return { width, height }
  })

  // 8 轮 极窄(180px≈14列)↔宽(原宽) 来回。日志证明丢行发生在 cols=14↔148 之间，
  // 极窄时长行被 wrap 成 6-7 段，变宽合并才出错——必须窄到这个程度才复现。
  for (let round = 0; round < 8; round++) {
    await app.evaluate(async ({ BrowserWindow }, arg) => BrowserWindow.getAllWindows()[0].setSize(arg.w, arg.h), { w: 180, h: size.height })
    await window.waitForTimeout(180)
    await app.evaluate(async ({ BrowserWindow }, arg) => BrowserWindow.getAllWindows()[0].setSize(arg.w, arg.h), { w: size.width, h: size.height })
    await window.waitForTimeout(180)
  }
  await window.waitForTimeout(800)

  const after = await dumpBuffer(window)
  const afterTokens = new Set(after.join('\n').match(/RT_LINE_\d+/g) ?? [])
  const missing = beforeTokens.filter((t) => !afterTokens.has(t))
  expect(missing, `多轮来回后丢失: ${missing.join(', ')} (before=${beforeTokens.length}, afterUnique=${afterTokens.size})`).toEqual([])
})

test('REPRO: extreme cols reflow (14<->148) via direct xterm.resize', async () => {
  // 精确复现日志：cols 在 14↔148 之间反复。用 setSize 直接调 term.resize，绕过窗口像素下限。
  // 关键：用**长行**——短行在 14 列下 wrap 不足，日志里 cols=14 时 len=275 说明有超长行被拆 6-7 段。
  await typeInTerminal(window, '1..20 | % { "EX_LINE_${_}_" + ("x" * 120) }')
  await window.keyboard.press('Enter')
  await window.waitForTimeout(1500)

  const before = await dumpBuffer(window)
  const beforeTokens = before.join('\n').match(/EX_LINE_\d+/g) ?? []
  expect(beforeTokens.length).toBeGreaterThanOrEqual(10)

  // 反复 14↔148，每轮之间读一次 len 观察塌缩
  for (let round = 0; round < 6; round++) {
    await setSize(window, 14, 43)
    await window.waitForTimeout(120)
    const narrow = (await snapshot(window)) as { length: number }
    await setSize(window, 148, 43)
    await window.waitForTimeout(120)
    const wide = (await snapshot(window)) as { length: number; lastNonEmptyLine: number }
    console.log(`[REPRO round ${round}] narrow.len=${narrow.length} wide.len=${wide.length} wide.lastNonEmpty=${wide.lastNonEmptyLine}`)
  }
  await window.waitForTimeout(500)

  const after = await dumpBuffer(window)
  const afterTokens = new Set(after.join('\n').match(/EX_LINE_\d+/g) ?? [])
  const missing = beforeTokens.filter((t) => !afterTokens.has(t))
  expect(missing, `极端 reflow 后丢失: ${missing.join(', ')} (before=${beforeTokens.length}, afterUnique=${afterTokens.size})`).toEqual([])
})

test('REPRO2: pty round-trip resize (forceResize) — includes ConPTY reprint', async () => {
  // 与 REPRO 的区别：走真实路径 forceResize()，它会通知 pty→ConPTY 回吐重绘。
  // 日志显示塌缩发生在 pty resize 之后 400ms，setSize 绕过了 pty 所以测不到——这个测试补上。
  // 用长行 + 多轮，并在每轮 pty resize 后延迟读，抓塌缩。
  await typeInTerminal(window, '1..20 | % { "P2_LINE_${_}_" + ("y" * 120) }')
  await window.keyboard.press('Enter')
  await window.waitForTimeout(1500)

  const before = await dumpBuffer(window)
  const beforeTokens = before.join('\n').match(/P2_LINE_\d+/g) ?? []
  expect(beforeTokens.length).toBeGreaterThanOrEqual(10)

  const size = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const [width, height] = w.getSize()
    return { width, height }
  })

  for (let round = 0; round < 6; round++) {
    // 真实窗口 resize（触发 ResizeObserver→debounce→fit→pty resize→ConPTY 回吐）
    await app.evaluate(async ({ BrowserWindow }, arg) => BrowserWindow.getAllWindows()[0].setSize(arg.w, arg.h), { w: 260, h: size.height })
    await window.waitForTimeout(300)
    await app.evaluate(async ({ BrowserWindow }, arg) => BrowserWindow.getAllWindows()[0].setSize(arg.w, arg.h), { w: size.width, h: size.height })
    await window.waitForTimeout(600) // 等 ConPTY 回吐
    const snap = (await snapshot(window)) as { length: number; lastNonEmptyLine: number }
    console.log(`[REPRO2 round ${round}] len=${snap.length} lastNonEmpty=${snap.lastNonEmptyLine}`)
  }
  await window.waitForTimeout(500)

  const after = await dumpBuffer(window)
  const afterTokens = new Set(after.join('\n').match(/P2_LINE_\d+/g) ?? [])
  const missing = beforeTokens.filter((t) => !afterTokens.has(t))
  expect(missing, `pty 往返 resize 后丢失: ${missing.join(', ')} (before=${beforeTokens.length}, afterUnique=${afterTokens.size})`).toEqual([])
})

test('REGRESSION: repeated ls keeps the prompt and next output synchronized after rapid resize', async () => {
  for (let run = 1; run <= 3; run++) {
    await typeInTerminal(window, 'ls')
    await window.keyboard.press('Enter')
    await window.waitForTimeout(700)
  }

  const size = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const [width, height] = w.getSize()
    return { width, height }
  })

  for (let round = 0; round < 4; round++) {
    await app.evaluate(
      async ({ BrowserWindow }, arg) =>
        BrowserWindow.getAllWindows()[0].setSize(arg.w, arg.h),
      { w: 260, h: size.height }
    )
    await window.waitForTimeout(180)
    await app.evaluate(
      async ({ BrowserWindow }, arg) =>
        BrowserWindow.getAllWindows()[0].setSize(arg.w, arg.h),
      { w: size.width, h: size.height }
    )
    await window.waitForTimeout(300)
  }
  await window.waitForTimeout(500)

  const afterResize = await dumpBuffer(window)
  const afterResizeSnapshot = (await snapshot(window)) as {
    baseY: number
    cursorX: number
    cursorY: number
    lastNonEmptyLine: number
  }
  const lastAfterResize =
    [...afterResize].reverse().find((line) => line.trim().length > 0) ?? ''
  expect(
    lastAfterResize,
    `resize 后提示符不完整: ${JSON.stringify(lastAfterResize)} snapshot=${JSON.stringify(afterResizeSnapshot)}`
  ).toMatch(/vibing>\s*$/)

  for (let i = 0; i < 3; i++) {
    await window.keyboard.press('Enter')
    await window.waitForTimeout(120)
  }
  await typeInTerminal(window, 'Write-Output "AFTER_RESIZE_CURSOR_OK"')
  await window.keyboard.press('Enter')
  await window.waitForTimeout(800)

  const afterCommand = await dumpBuffer(window)
  const text = afterCommand.join('\n')
  // The command echo is a PSReadLine/ConPTY presentation detail. The resize
  // contract only requires the command output to exist and the next prompt to
  // remain complete; requiring both echo + output made this count flaky.
  expect(text.match(/AFTER_RESIZE_CURSOR_OK/g)?.length ?? 0).toBeGreaterThanOrEqual(1)
  const lastAfterCommand =
    [...afterCommand].reverse().find((line) => line.trim().length > 0) ?? ''
  expect(lastAfterCommand).toMatch(/vibing>\s*$/)
})

test('P0: authoritative main-process history survives ConPTY resize reprint', async () => {
  await typeInTerminal(window, '1..20 | % { "P0_HISTORY_${_}_" + ("h" * 120) }')
  await window.keyboard.press('Enter')
  await window.waitForTimeout(1500)

  const size = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const [width, height] = w.getSize()
    return { width, height }
  })

  for (let round = 0; round < 3; round++) {
    await app.evaluate(
      async ({ BrowserWindow }, arg) =>
        BrowserWindow.getAllWindows()[0].setSize(arg.w, arg.h),
      { w: 260, h: size.height }
    )
    await window.waitForTimeout(300)
    await app.evaluate(
      async ({ BrowserWindow }, arg) =>
        BrowserWindow.getAllWindows()[0].setSize(arg.w, arg.h),
      { w: size.width, h: size.height }
    )
    await window.waitForTimeout(600)
  }

  const history = await dumpAuthoritativeHistory(window)
  expect(history).not.toBeNull()
  expect(history?.complete).toBe(true)

  const raw = history?.events
    .filter((event) => event.kind === 'output')
    .map((event) => event.data)
    .join('') ?? ''
  const tokens = new Set(raw.match(/P0_HISTORY_\d+/g) ?? [])
  const expected = Array.from({ length: 20 }, (_, index) => `P0_HISTORY_${index + 1}`)
  const missing = expected.filter((token) => !tokens.has(token))

  expect(
    missing,
    `主进程历史源在 resize 后缺失: ${missing.join(', ')}`
  ).toEqual([])
  expect(
    history?.events.some((event) => event.kind === 'resize'),
    '历史源应记录 resize 边界，供后续重放过滤 ConPTY 重绘'
  ).toBe(true)
})

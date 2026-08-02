import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { resolve } from 'path'
import { PNG } from 'pngjs'
import type {
  PtyFlowControlSnapshot,
  PtyHistorySnapshot
} from '../shared/ipc-contract'

/**
 * 启动打包后的 Electron 应用（需先 npm run build 产出 out/main/index.js）。
 * 设置 VIBING_E2E=1 让 preload 注入 __VIBING_E2E__ 标记，激活 window.__vibingDebug 调试桥。
 */
export async function launchApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const main = resolve(__dirname, '../out/main/index.js')
  const app = await electron.launch({
    args: [main],
    env: { ...process.env, VIBING_E2E: '1' }
  })
  try {
    const window = await app.firstWindow()
    // Electron 窗口被遮挡时 requestAnimationFrame 可能被节流；使用固定间隔轮询，
    // 避免调试桥已经注册却因默认 rAF polling 误报启动超时。
    await window.waitForFunction(
      () =>
        Boolean(
          (window as unknown as Record<string, unknown>)['__vibingDebug']
        ) &&
        Boolean(
          (window as unknown as Record<string, unknown>)[
            '__vibingDebugShell'
          ]
        ),
      null,
      { polling: 100, timeout: 30_000 }
    )
    // 既有终端门禁仍以“启动后可直接操作终端”为前提。产品默认页已经改为
    // Home，因此 helper 统一导航到首个常驻终端；Shell 自身用例可再切回 Home。
    await window.evaluate(() => {
      const debugWindow = window as unknown as {
        __vibingDebugTabs: { list(): string[] }
        __vibingDebugShell: {
          navigate(pageId: `terminal:${string}`): void
          setNavMode(mode: 'sidebar'): void
        }
      }
      debugWindow.__vibingDebugShell.setNavMode('sidebar')
      const [terminalId] = debugWindow.__vibingDebugTabs.list()
      if (terminalId) {
        debugWindow.__vibingDebugShell.navigate(`terminal:${terminalId}`)
      }
    })
    return { app, window }
  } catch (error) {
    await app.close().catch(() => {})
    throw error
  }
}

/** App Shell entry used by legacy multi-terminal gates after the M3 tab bar was removed. */
export async function openDefaultTerminal(window: Page): Promise<void> {
  await window.keyboard.press('Control+Shift+T')
  await window.getByTestId('new-session-overlay').waitFor({ state: 'visible' })
  await window.getByTestId('new-session-terminal').click()
}

export async function closeTerminalAt(window: Page, index: number): Promise<void> {
  await window.getByTestId('sidebar-terminal-item').nth(index).hover()
  await window.getByTestId('sidebar-terminal-close').nth(index).click()
}

/** 通过调试桥读 buffer 快照 */
export async function snapshot(window: Page) {
  return window.evaluate(() => (window as unknown as { __vibingDebug: { snapshot(): unknown } }).__vibingDebug.snapshot())
}

/** 通过调试桥 dump 整个 buffer 文本行 */
export async function dumpBuffer(window: Page): Promise<string[]> {
  return window.evaluate(() =>
    (window as unknown as { __vibingDebug: { dumpBuffer(): string[] } }).__vibingDebug.dumpBuffer()
  )
}

/** 通过 isWrapped 合并物理行，读取 resize/reflow 后的逻辑文本。 */
export async function dumpLogicalBuffer(window: Page): Promise<string[]> {
  return window.evaluate(() =>
    (window as unknown as {
      __vibingDebug: { dumpLogicalBuffer(): string[] }
    }).__vibingDebug.dumpLogicalBuffer()
  )
}

/** 读取当前 xterm 选择文本；空字符串表示高亮已经取消。 */
export async function terminalSelection(window: Page): Promise<string> {
  return window.evaluate(() =>
    (window as unknown as {
      __vibingDebug: { selectionText(): string }
    }).__vibingDebug.selectionText()
  )
}

/** 通过调试桥 dump 当前视口文本行。 */
export async function dumpViewport(window: Page): Promise<string[]> {
  return window.evaluate(() =>
    (window as unknown as { __vibingDebug: { dumpViewport(): string[] } }).__vibingDebug.dumpViewport()
  )
}

/** 相对滚动视口；负数向上、正数向下。 */
export async function scrollLines(window: Page, amount: number): Promise<void> {
  await window.evaluate(
    (value) =>
      (window as unknown as {
        __vibingDebug: { scrollLines(amount: number): void }
      }).__vibingDebug.scrollLines(value),
    amount
  )
}

export async function scrollToTop(window: Page): Promise<void> {
  await window.evaluate(() =>
    (window as unknown as { __vibingDebug: { scrollToTop(): void } }).__vibingDebug.scrollToTop()
  )
}

export async function scrollToBottom(window: Page): Promise<void> {
  await window.evaluate(() =>
    (window as unknown as { __vibingDebug: { scrollToBottom(): void } }).__vibingDebug.scrollToBottom()
  )
}

/** 通过调试桥在终端 buffer 中精确选中指定 ASCII 文本。 */
export async function selectTerminalText(window: Page, text: string): Promise<boolean> {
  return window.evaluate((value) =>
    (window as unknown as {
      __vibingDebug: { selectText(text: string): boolean }
    }).__vibingDebug.selectText(value),
    text
  )
}

/** 读取主进程权威原始历史（P0 spike）。 */
export async function dumpAuthoritativeHistory(window: Page): Promise<PtyHistorySnapshot | null> {
  return window.evaluate(() =>
    (window as unknown as {
      __vibingDebug: {
        dumpAuthoritativeHistory(): Promise<PtyHistorySnapshot | null>
      }
    }).__vibingDebug.dumpAuthoritativeHistory()
  )
}

/** 读取当前 PTY 的背压与内存水位指标。 */
export async function flowControl(window: Page): Promise<PtyFlowControlSnapshot | null> {
  return window.evaluate(() =>
    (window as unknown as {
      __vibingDebug: {
        flowControl(): Promise<PtyFlowControlSnapshot | null>
      }
    }).__vibingDebug.flowControl()
  )
}

/** 走真实 pointer 路径拖选终端文本；TUI 遗留 mouse tracking 时该操作会失败。 */
export async function dragSelectTerminalText(
  window: Page,
  text: string
): Promise<string> {
  const lines = await dumpBuffer(window)
  let row = -1
  let column = -1
  for (let index = lines.length - 1; index >= 0; index--) {
    const matchIndex = lines[index].indexOf(text)
    if (matchIndex < 0) continue
    row = index
    column = matchIndex
    break
  }
  if (row < 0 || column < 0) return ''

  const state = (await snapshot(window)) as {
    cols: number
    rows: number
    viewportY: number
  }
  const screen = await window.locator('.xterm-screen:visible').boundingBox()
  if (!screen || row < state.viewportY || row >= state.viewportY + state.rows) {
    return ''
  }
  const cellWidth = screen.width / state.cols
  const cellHeight = screen.height / state.rows
  const y = screen.y + (row - state.viewportY + 0.5) * cellHeight
  await window.mouse.move(screen.x + (column + 0.2) * cellWidth, y)
  await window.mouse.down()
  await window.mouse.move(
    screen.x + (column + text.length - 0.2) * cellWidth,
    y,
    { steps: 5 }
  )
  await window.mouse.up()
  return terminalSelection(window)
}

/** E2E 专用：延迟 xterm 消费完成后的 ack，确定性模拟慢消费者。 */
export async function setPtyAckDelay(window: Page, milliseconds: number): Promise<void> {
  await window.evaluate(
    (value) =>
      (window as unknown as {
        __vibingDebug: { setPtyAckDelay(milliseconds: number): void }
      }).__vibingDebug.setPtyAckDelay(value),
    milliseconds
  )
}

/** 主动触发一次 fit + pty resize（绕过 debounce） */
export async function forceResize(window: Page): Promise<void> {
  await window.evaluate(() =>
    (window as unknown as { __vibingDebug: { forceResize(): void } }).__vibingDebug.forceResize()
  )
}

/** 直接把 xterm resize 到指定 cols/rows（绕过窗口像素约束，精确复现极端 reflow） */
export async function setSize(window: Page, cols: number, rows: number): Promise<void> {
  await window.evaluate(
    ({ cols, rows }) =>
      (window as unknown as { __vibingDebug: { setSize(c: number, r: number): void } }).__vibingDebug.setSize(cols, rows),
    { cols, rows }
  )
}

/** 读清屏序列日志（pty 是否在 resize 时发 ED2/ED3） */
export async function clearSeqLog(window: Page): Promise<{ ed2: number; ed3: number; events: Array<{ at: number; kind: string; chunkLen: number }> }> {
  return window.evaluate(() =>
    (window as unknown as { __vibingDebug: { clearSeqLog(): { ed2: number; ed3: number; events: Array<{ at: number; kind: string; chunkLen: number }> } } }).__vibingDebug.clearSeqLog()
  )
}

export async function resetClearSeqLog(window: Page): Promise<void> {
  await window.evaluate(() =>
    (window as unknown as { __vibingDebug: { resetClearSeqLog(): void } }).__vibingDebug.resetClearSeqLog()
  )
}

/** 在终端里输入文本（经 xterm.onData 送入 pty），可选回车 */
export async function typeInTerminal(window: Page, text: string): Promise<void> {
  await window.locator('.xterm:visible').click()
  await window.keyboard.type(text)
}

export interface SolidColorScan {
  matchingPixels: number
  longestHorizontalRun: number
  longestRunY: number
  longestRunFromX: number
  longestRunToX: number
}

/** 扫描纯色像素的最长水平连续段；块字符网格缝会把该连续段切碎。 */
export function scanSolidColor(
  screenshot: Buffer,
  expected: readonly [number, number, number],
  tolerance = 4,
  bounds?: { fromY?: number; toY?: number; fromX?: number; toX?: number }
): SolidColorScan {
  const png = PNG.sync.read(screenshot)
  let matchingPixels = 0
  let longestHorizontalRun = 0
  let longestRunY = -1
  let longestRunFromX = -1
  let longestRunToX = -1
  const fromY = Math.max(0, Math.floor(bounds?.fromY ?? 0))
  const toY = Math.min(png.height, Math.ceil(bounds?.toY ?? png.height))
  const fromX = Math.max(0, Math.floor(bounds?.fromX ?? 0))
  const toX = Math.min(png.width, Math.ceil(bounds?.toX ?? png.width))
  for (let y = fromY; y < toY; y++) {
    let run = 0
    let runFromX = fromX
    for (let x = fromX; x < toX; x++) {
      const offset = (y * png.width + x) * 4
      const matches =
        Math.abs(png.data[offset] - expected[0]) <= tolerance &&
        Math.abs(png.data[offset + 1] - expected[1]) <= tolerance &&
        Math.abs(png.data[offset + 2] - expected[2]) <= tolerance
      if (matches) {
        matchingPixels++
        if (run === 0) runFromX = x
        run++
        if (run > longestHorizontalRun) {
          longestHorizontalRun = run
          longestRunY = y
          longestRunFromX = runFromX
          longestRunToX = x + 1
        }
      } else {
        run = 0
      }
    }
  }
  return {
    matchingPixels,
    longestHorizontalRun,
    longestRunY,
    longestRunFromX,
    longestRunToX
  }
}

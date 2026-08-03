import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import { PNG } from 'pngjs'
import type {
  PtyFlowControlSnapshot,
  PtyHistorySnapshot
} from '../shared/ipc-contract'

/**
 * 启动打包后的 Electron 应用（需先 npm run build 产出 out/main/index.js）。
 * 设置 VIBING_E2E=1 让 preload 注入 __VIBING_E2E__ 标记，激活 window.__vibingDebug 调试桥。
 *
 * M5.c：默认每次 launch 使用独立 userData 临时目录（VIBING_USER_DATA_DIR），
 * 保证 stats / 主题热重载 / 重启持久化等断言从干净状态出发。
 * 传入 userDataDir 可复用同一目录（重启持久化验证）。
 */
export async function launchApp(options: {
  userDataDir?: string
  cliFixture?: boolean
  /** 既有终端门禁默认显式启动一个终端；空态用例可关闭。 */
  createDefaultTerminal?: boolean
  env?: Record<string, string>
} = {}): Promise<{
  app: ElectronApplication
  window: Page
  userDataDir: string
}> {
  const main = resolve(__dirname, '../out/main/index.js')
  const userDataDir =
    options.userDataDir ?? mkdtempSync(resolve(tmpdir(), 'vibing-e2e-'))
  const app = await electron.launch({
    args: [main],
    env: {
      ...process.env,
      VIBING_E2E: '1',
      VIBING_E2E_CLI_FIXTURE: options.cliFixture === false ? '0' : '1',
      VIBING_USER_DATA_DIR: userDataDir,
      ...options.env
    }
  })
  try {
    const window = await app.firstWindow()
    // Electron 窗口被遮挡时 requestAnimationFrame 可能被节流；使用固定间隔轮询，
    // 避免调试桥已经注册却因默认 rAF polling 误报启动超时。
    await window.waitForFunction(
      () =>
        Boolean(
          (window as unknown as Record<string, unknown>)[
            '__vibingDebugShell'
          ]
        ),
      null,
      { polling: 100, timeout: 30_000 }
    )
    await window.evaluate(() => {
      const debugWindow = window as unknown as {
        __vibingDebugShell: {
          navigate(pageId: 'home'): void
          setNavMode(mode: 'sidebar'): void
        }
      }
      debugWindow.__vibingDebugShell.setNavMode('sidebar')
      debugWindow.__vibingDebugShell.navigate('home')
    })

    if (options.createDefaultTerminal === false) {
      return { app, window, userDataDir }
    }

    // 产品启动保持零实例。既有终端门禁由 helper 明确点击 Home 入口，
    // 测试便利性不再通过产品恢复代码偷偷创建 PTY。
    await expect
      .poll(
        () =>
          window.evaluate(() =>
            window.shellApi.listAvailable().then((shells) => shells.length)
          ),
        {
          timeout: 30_000,
          message: '至少应发现一个可启动终端'
        }
      )
      .toBeGreaterThan(0)
    await window.getByTestId('home-quick-terminal').click()
    await window.waitForFunction(
      () =>
        Boolean(
          (window as unknown as Record<string, unknown>)['__vibingDebug']
        ) &&
        Boolean(
          (window as unknown as Record<string, unknown>)[
            '__vibingDebugTabs'
          ]
        ),
      null,
      { polling: 100, timeout: 30_000 }
    )
    await window.evaluate(() => {
      const debugWindow = window as unknown as {
        __vibingDebugTabs: { list(): string[] }
        __vibingDebugShell: {
          navigate(pageId: `terminal:${string}`): void
        }
      }
      const [terminalId] = debugWindow.__vibingDebugTabs.list()
      if (terminalId) {
        debugWindow.__vibingDebugShell.navigate(`terminal:${terminalId}`)
      }
    })
    // 调试桥早于 PTY 首帧注册。等待权威 PTY 流完成首轮输出与尺寸重绘，
    // 避免第一条测试命令和 PowerShell 初始化竞争，也不污染终端 scrollback。
    await waitForShellReady(window)
    return { app, window, userDataDir }
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

async function waitForAuthoritativePtyQuiet(
  window: Page,
  timeout: number
): Promise<void> {
  let previousSequence = -1
  let stableSamples = 0
  await expect
    .poll(
      async () => {
        const history = await dumpAuthoritativeHistory(window)
        if (!history?.events.some((event) => event.kind === 'output')) {
          previousSequence = -1
          stableSamples = 0
          return stableSamples
        }
        const sequence = history.events.at(-1)?.sequence ?? -1
        if (sequence === previousSequence) {
          stableSamples++
        } else {
          previousSequence = sequence
          stableSamples = 0
        }
        return stableSamples
      },
      {
        timeout,
        intervals: [100, 150, 250, 400],
        message: 'PTY 输出应在发送下一条命令前进入稳定态'
      }
    )
    .toBeGreaterThanOrEqual(2)
}

export async function waitForShellReady(
  window: Page,
  timeout = 20_000
): Promise<void> {
  await expect
    .poll(() => dumpAuthoritativeHistory(window), {
      timeout,
      message: 'PTY 应在发送 shell 命令前完成绑定'
    })
    .not.toBeNull()
  await waitForAuthoritativePtyQuiet(window, timeout)
}

/**
 * 证明当前终端已经接通 shell：等待 PTY 句柄后发送一个很短的唯一标记，
 * 再从主进程权威原始流等待输出。探针把标记拆成变量和前缀，命令回显不会
 * 包含最终值；同时绕过 PowerShell/ConPTY 随后覆盖 xterm 行尾的重绘。
 */
export async function waitForShellRoundTrip(
  window: Page,
  timeout = 20_000
): Promise<void> {
  await waitForShellReady(window, timeout)

  const nonce = Math.random().toString(36).slice(2, 8)
  const expected = `VIB_${nonce}`
  const platform = await window.evaluate(() => window.windowApi.platform)
  const command =
    platform === 'win32'
      ? `$x='${nonce}'; echo VIB_$x`
      : `x='${nonce}'; echo VIB_$x`

  await typeInTerminal(window, command)
  await window.keyboard.press('Enter')
  await expect
    .poll(async () => {
      const history = await dumpAuthoritativeHistory(window)
      return (
        history?.events
          .filter((event) => event.kind === 'output')
          .map((event) => event.data)
          .join('') ?? ''
      )
    }, {
      timeout,
      message: 'shell 应执行并返回唯一就绪探针'
    })
    .toContain(expected)
  await waitForAuthoritativePtyQuiet(window, timeout)
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

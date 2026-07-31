import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { resolve } from 'path'
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
  const window = await app.firstWindow()
  // 等待调试桥就绪（xterm 已挂载并注册）
  await window.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>)['__vibingDebug']), null, {
    timeout: 15_000
  })
  return { app, window }
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

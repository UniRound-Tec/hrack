import type { Terminal } from '@xterm/xterm'
import type {
  PtyFlowControlSnapshot,
  PtyHistorySnapshot
} from '../../shared/ipc-contract'

/**
 * 调试桥 —— 仅在 dev / E2E 下暴露到 window.__vibingDebug，供 Playwright 用 evaluate 读取
 * 终端运行时真相（xterm buffer 的真实内容与尺寸），不再依赖人肉观察屏幕。
 *
 * 生产构建下不挂载（见 shouldEnable）。
 */

export interface TerminalSnapshot {
  cols: number
  rows: number
  bufferType: 'normal' | 'alternate'
  length: number
  baseY: number
  viewportY: number
  cursorX: number
  cursorY: number
  /** 最后一条非空行索引（粗略反映有内容的行数） */
  lastNonEmptyLine: number
}

export interface VibingDebugApi {
  /** 当前 xterm 尺寸与 buffer 指标 */
  snapshot(): TerminalSnapshot | null
  /** 整个 buffer 的文本（每行一个字符串，trimRight）。用于精确对比 resize 前后内容是否真丢。 */
  dumpBuffer(): string[]
  /** 按 isWrapped 合并物理行后的逻辑文本。用于区分正常换行与真实字符丢失。 */
  dumpLogicalBuffer(): string[]
  /** 当前选择文本；空字符串表示没有高亮选区。 */
  selectionText(): string
  /** 仅当前视口可见的文本行 */
  dumpViewport(): string[]
  /** 相对滚动视口；负数向上、正数向下。 */
  scrollLines(amount: number): void
  /** 滚到 normal buffer 历史顶部。alternate buffer 无 scrollback，因此不会移动。 */
  scrollToTop(): void
  /** 滚到当前 buffer 底部。 */
  scrollToBottom(): void
  /** 在 buffer 中查找并精确选中一段 ASCII 文本，供剪贴板 E2E 使用。 */
  selectText(text: string): boolean
  /** 主动触发一次 fit + pty resize（绕过 debounce，供测试确定性驱动） */
  forceResize(): void
  /** 直接把 xterm resize 到指定 cols/rows（绕过容器像素约束，精确复现极端 reflow）。仅测试用。 */
  setSize(cols: number, rows: number): void
  /** 累计收到的清屏序列计数（ED2=清屏, ED3=清 scrollback）。用于验证 pty 是否在 resize 时清屏。 */
  clearSeqLog(): ClearSeqLog
  /** 清零 clearSeqLog 计数 */
  resetClearSeqLog(): void
  /** P0：读取主进程中不受 resize 覆盖影响的原始历史。 */
  dumpAuthoritativeHistory(): Promise<PtyHistorySnapshot | null>
  /** M2：读取主进程背压与内存水位。 */
  flowControl(): Promise<PtyFlowControlSnapshot | null>
  /** E2E 专用：延迟 xterm 消费完成后的 ack，模拟慢消费者。 */
  setPtyAckDelay(milliseconds: number): void
}

export interface ClearSeqLog {
  ed2: number // \x1b[2J 清屏
  ed3: number // \x1b[3J 清 scrollback
  events: Array<{ at: number; kind: string; chunkLen: number }>
}

const clearLog: ClearSeqLog = { ed2: 0, ed3: 0, events: [] }

/**
 * useXterm 在每块 pty 数据写入 xterm 前调用，记录其中的清屏序列。
 * 与 shouldEnable 无关（开销极小），但只有 debug 激活时 API 才暴露这些计数。
 */
export function recordPtyData(data: Uint8Array): void {
  const text = new TextDecoder().decode(data)
  let kind = ''
  if (text.includes('\x1b[3J')) {
    clearLog.ed3++
    kind += 'ED3(clear-scrollback) '
  }
  if (text.includes('\x1b[2J')) {
    clearLog.ed2++
    kind += 'ED2(clear-screen) '
  }
  if (kind) {
    clearLog.events.push({ at: performance.now(), kind: kind.trim(), chunkLen: data.length })
    if (clearLog.events.length > 200) clearLog.events.shift()
  }
}

let registered: Terminal | null = null
let forceResizeFn: (() => void) | null = null
let dumpHistoryFn: (() => Promise<PtyHistorySnapshot | null>) | null = null
let dumpFlowControlFn: (() => Promise<PtyFlowControlSnapshot | null>) | null = null
let setPtyAckDelayFn: ((milliseconds: number) => void) | null = null

function bufferToLines(term: Terminal, fromViewportOnly: boolean): string[] {
  const b = term.buffer.active
  const start = fromViewportOnly ? b.viewportY : 0
  const end = fromViewportOnly ? b.viewportY + term.rows : b.length
  const out: string[] = []
  for (let i = start; i < end; i++) {
    const line = b.getLine(i)
    out.push(line ? line.translateToString(true) : '')
  }
  return out
}

function bufferToLogicalLines(term: Terminal): string[] {
  const buffer = term.buffer.active
  const out: string[] = []
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row)
    if (!line) {
      out.push('')
      continue
    }
    const text = line.translateToString(true)
    if (line.isWrapped && out.length > 0) {
      out[out.length - 1] += text
    } else {
      out.push(text)
    }
  }
  return out
}

/** dev/E2E 判定：Vite dev、或显式 VIBING_E2E 标记。 */
function shouldEnable(): boolean {
  try {
    return Boolean(import.meta.env?.DEV) || Boolean((globalThis as Record<string, unknown>)['__VIBING_E2E__'])
  } catch {
    return false
  }
}

/**
 * useXterm 在挂载后调用：把 term 实例与 forceResize 回调注册进调试桥。
 * 返回注销函数，卸载时调用。
 */
export function registerTerminalForDebug(
  term: Terminal,
  forceResize: () => void,
  dumpHistory: () => Promise<PtyHistorySnapshot | null>,
  dumpFlowControl: () => Promise<PtyFlowControlSnapshot | null>,
  setPtyAckDelay: (milliseconds: number) => void
): () => void {
  if (!shouldEnable()) return () => {}
  registered = term
  forceResizeFn = forceResize
  dumpHistoryFn = dumpHistory
  dumpFlowControlFn = dumpFlowControl
  setPtyAckDelayFn = setPtyAckDelay
  const api: VibingDebugApi = {
    snapshot() {
      if (!registered) return null
      const b = registered.buffer.active
      let lastNonEmpty = -1
      for (let i = b.length - 1; i >= 0; i--) {
        const l = b.getLine(i)
        if (l && l.translateToString(true).trim() !== '') {
          lastNonEmpty = i
          break
        }
      }
      return {
        cols: registered.cols,
        rows: registered.rows,
        bufferType: b.type,
        length: b.length,
        baseY: b.baseY,
        viewportY: b.viewportY,
        cursorX: b.cursorX,
        cursorY: b.cursorY,
        lastNonEmptyLine: lastNonEmpty
      }
    },
    dumpBuffer() {
      return registered ? bufferToLines(registered, false) : []
    },
    dumpLogicalBuffer() {
      return registered ? bufferToLogicalLines(registered) : []
    },
    selectionText() {
      return registered?.getSelection() ?? ''
    },
    dumpViewport() {
      return registered ? bufferToLines(registered, true) : []
    },
    scrollLines(amount: number) {
      registered?.scrollLines(amount)
    },
    scrollToTop() {
      registered?.scrollToTop()
    },
    scrollToBottom() {
      registered?.scrollToBottom()
    },
    selectText(text: string) {
      if (!registered || text.length === 0) return false
      const buffer = registered.buffer.active
      for (let row = 0; row < buffer.length; row++) {
        const line = buffer.getLine(row)
        const column = line?.translateToString(false).indexOf(text) ?? -1
        if (column >= 0) {
          registered.select(column, row, text.length)
          return registered.getSelection() === text
        }
      }
      return false
    },
    forceResize() {
      forceResizeFn?.()
    },
    setSize(cols: number, rows: number) {
      registered?.resize(cols, rows)
    },
    clearSeqLog() {
      return { ed2: clearLog.ed2, ed3: clearLog.ed3, events: [...clearLog.events] }
    },
    resetClearSeqLog() {
      clearLog.ed2 = 0
      clearLog.ed3 = 0
      clearLog.events.length = 0
    },
    dumpAuthoritativeHistory() {
      return dumpHistoryFn?.() ?? Promise.resolve(null)
    },
    flowControl() {
      return dumpFlowControlFn?.() ?? Promise.resolve(null)
    },
    setPtyAckDelay(milliseconds: number) {
      setPtyAckDelayFn?.(milliseconds)
    }
  }
  ;(window as unknown as Record<string, unknown>)['__vibingDebug'] = api
  return () => {
    if (registered === term) {
      registered = null
      forceResizeFn = null
      dumpHistoryFn = null
      dumpFlowControlFn = null
      setPtyAckDelayFn = null
      delete (window as unknown as Record<string, unknown>)['__vibingDebug']
    }
  }
}

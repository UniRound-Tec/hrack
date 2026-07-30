import { useEffect, useRef, type RefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { PtyProxy } from './PtyProxy'
import { registerTerminalForDebug, recordPtyData } from './debugBridge'

/**
 * ConPTY 重画被主进程隔离后，xterm 需要自行维持 normal buffer 的光标。
 * windowsPty resize 会出现“文字已 reflow 完整，但 cursorX 仍停在旧截断列”的情况；
 * 用最后非空提示符行的真实 cell 宽度重新锚定光标，避免下一次输入覆盖旧内容。
 */
function cursorAnchorAfterReflow(term: Terminal): string | null {
  const buffer = term.buffer.active
  if (buffer.type !== 'normal') return null

  let lineIndex = -1
  for (let index = buffer.length - 1; index >= buffer.baseY; index--) {
    const line = buffer.getLine(index)
    if (line && line.translateToString(true).trim().length > 0) {
      lineIndex = index
      break
    }
  }
  if (lineIndex < buffer.baseY) return null

  const line = buffer.getLine(lineIndex)
  if (!line) return null
  let targetX = 0
  for (let column = 0; column < line.length; column++) {
    const cell = line.getCell(column)
    if (cell && cell.getChars().length > 0) {
      targetX = Math.min(column + Math.max(cell.getWidth(), 1), term.cols - 1)
    }
  }

  const targetY = lineIndex - buffer.baseY
  if (targetY < 0 || targetY >= term.rows) return null
  if (targetX === buffer.cursorX && targetY === buffer.cursorY) return null
  return `\x1b[${targetY + 1};${targetX + 1}H`
}

/**
 * 让保留完整 scrollback 的 xterm 当前视口与 ConPTY 的光标行对齐。
 * 不能用 SU：baseY=0 时它会直接丢弃顶部行。改为先定位到底行再用 CRLF
 * 触发正常滚动，让顶部行按普通终端输出语义进入 scrollback。
 */
function applyConptyCursorSync(
  term: Terminal,
  row: number,
  column: number
): void {
  const buffer = term.buffer.active
  if (buffer.type !== 'normal') return
  const targetRow = Math.max(1, Math.min(row, term.rows))
  const targetColumn = Math.max(1, Math.min(column, term.cols))
  const currentRow = buffer.cursorY + 1
  const delta = currentRow - targetRow
  if (delta > 0) {
    const naturalScroll = '\r\n'.repeat(delta)
    term.write(
      `\x1b[${term.rows};1H${naturalScroll}\x1b[${targetRow};${targetColumn}H`
    )
    return
  }
  // 目标行通常只会相同或更靠上；若出现更靠下，不滚动内容，只同步光标。
  term.write(`\x1b[${targetRow};${targetColumn}H`)
}

/**
 * 挂载/卸载 xterm 并打通最小回显链路（SPEC §5.1）。
 *
 * 关键：**空依赖 useEffect，只挂载一次**。React 不参与 xterm 内部 re-render，
 * PTY 输出不进 React state，直达 term.write()。
 *
 * M1：无背压（直写 term.write）。背压的 ackData 流控是 M2。
 */
export function useXterm(
  containerRef: RefObject<HTMLDivElement | null>,
  onCopied?: () => void
): void {
  const onCopiedRef = useRef(onCopied)
  useEffect(() => {
    onCopiedRef.current = onCopied
  }, [onCopied])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // windowsPty 告知 xterm 使用对应的 ConPTY/build 兼容路径；build≥21376 时仍启用 reflow。
    // REPRO 已证明 xterm reflow 本身能完整保留历史。真正有破坏性的 ConPTY resize 整屏重画
    // 由主进程 ConptyResizeFilter 隔离，不会进入这里的 term.write。
    const meta = window.ptyApi.getMeta()
    const term = new Terminal({
      fontFamily: 'Consolas, "Cascadia Code", "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      // 主进程会隔离 ConPTY resize 重画，因此当前光标行也必须由 xterm 自己 reflow。
      reflowCursorLine: true,
      windowsPty: meta.windowsPty,
      theme: {
        background: '#0b0e14',
        foreground: '#c8d3e0',
        cursor: '#c8d3e0',
        selectionBackground: '#3d4f6b'
      }
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()

    let proxy: PtyProxy | null = null
    let disposed = false

    const copySelectionOnContextMenu = (event: MouseEvent): void => {
      if (!term.hasSelection()) return
      const selectedText = term.getSelection()
      if (selectedText.length === 0) return
      event.preventDefault()
      void window.clipboardApi
        .writeText(selectedText)
        .then(() => {
          if (disposed) return
          term.clearSelection()
          onCopiedRef.current?.()
        })
        .catch(() => {
          // 剪贴板临时不可用时保留选区，用户可以再次右键。
        })
    }
    container.addEventListener('contextmenu', copySelectionOnContextMenu)

    // resize 分成两条节奏：
    // 1. renderer 在每个 animation frame 最多 fit/reflow 一次，让拖窗视觉连续跟手；
    // 2. PTY 通知单独做 trailing debounce，避免拖动时让 ConPTY 高频整屏重画。
    // normal / alternate 缓冲区共用同一策略。
    let fitFrame: number | null = null
    let ptyResizeTimer: ReturnType<typeof setTimeout> | null = null
    let pendingPtyResize: { cols: number; rows: number } | null = null
    let lastSentCols = term.cols
    let lastSentRows = term.rows

    const sendPtyResize = (cols: number, rows: number): void => {
      if (disposed || !proxy) return
      if (cols === lastSentCols && rows === lastSentRows) return
      lastSentCols = cols
      lastSentRows = rows
      const anchor = cursorAnchorAfterReflow(term)
      if (anchor) {
        term.write(anchor, () => {
          if (!disposed) void proxy?.resize(cols, rows)
        })
      } else {
        void proxy.resize(cols, rows)
      }
    }

    const flushPendingPtyResize = (): void => {
      ptyResizeTimer = null
      const target = pendingPtyResize
      pendingPtyResize = null
      if (!target) return
      sendPtyResize(target.cols, target.rows)
    }

    const schedulePtyResize = (cols: number, rows: number): void => {
      if (ptyResizeTimer) {
        clearTimeout(ptyResizeTimer)
        ptyResizeTimer = null
      }
      if (cols === lastSentCols && rows === lastSentRows) {
        pendingPtyResize = null
        return
      }
      pendingPtyResize = { cols, rows }
      ptyResizeTimer = setTimeout(flushPendingPtyResize, 100)
    }

    const fitVisual = (): void => {
      fitFrame = null
      if (disposed) return
      try {
        fit.fit()
      } catch {
        return
      }
      schedulePtyResize(term.cols, term.rows)
    }

    const scheduleResize = (): void => {
      if (fitFrame !== null) return
      fitFrame = requestAnimationFrame(fitVisual)
    }

    // 调试桥：E2E/dev 下暴露 window.__vibingDebug，可读 buffer、可主动 forceResize。
    const unregisterDebug = registerTerminalForDebug(
      term,
      () => {
        if (fitFrame !== null) {
          cancelAnimationFrame(fitFrame)
          fitFrame = null
        }
        fitVisual()
        if (ptyResizeTimer) {
          clearTimeout(ptyResizeTimer)
          ptyResizeTimer = null
        }
        flushPendingPtyResize()
      },
      () => proxy?.history() ?? Promise.resolve(null)
    )

    // spawn 拿到 ptyId，建立回显双向链路
    window.ptyApi
      .spawn({ cols: term.cols, rows: term.rows })
      .then(({ ptyId }) => {
        if (disposed) {
          void window.ptyApi.kill(ptyId)
          return
        }
        proxy = new PtyProxy(ptyId)
        // spawn 完成后同步一次尺寸：spawn 期间容器尺寸可能已变，且此时 proxy 才可用。
        {
          if (ptyResizeTimer) {
            clearTimeout(ptyResizeTimer)
            ptyResizeTimer = null
          }
          pendingPtyResize = null
          const { cols, rows } = term
          sendPtyResize(cols, rows)
        }

        // 键盘 → pty
        term.onData((d) => {
          void proxy?.write(d)
        })
        // pty → 屏幕（M1 无 ack）
        proxy.onData((d) => {
          recordPtyData(d)
          term.write(d)
        })
        proxy.onResizeCursorSync(({ row, column }) => {
          applyConptyCursorSync(term, row, column)
        })
        proxy.onExit(({ code }) => {
          term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m`)
        })
      })
      .catch((err: unknown) => {
        term.write(`\r\n\x1b[31mFailed to spawn shell: ${String(err)}\x1b[0m\r\n`)
      })

    const ro = new ResizeObserver(scheduleResize)
    ro.observe(container)

    return () => {
      disposed = true
      if (fitFrame !== null) cancelAnimationFrame(fitFrame)
      if (ptyResizeTimer) clearTimeout(ptyResizeTimer)
      unregisterDebug()
      ro.disconnect()
      container.removeEventListener('contextmenu', copySelectionOnContextMenu)
      proxy?.dispose()
      void proxy?.kill()
      term.dispose()
    }
  }, [containerRef])
}

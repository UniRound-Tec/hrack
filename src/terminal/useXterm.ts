import { useEffect, useRef, type RefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { PtyProxy } from './PtyProxy'
import { handleShellShortcut } from '../app/shellShortcuts'
import {
  recordPtyData,
  registerTerminalForDebug,
  setActiveTerminalForDebug
} from './debugBridge'
import {
  createRendererController,
  type RendererController
} from './addons'
import { useSettingsStore } from '../state/settingsStore'
import { getTerminalTheme } from './themes'
import { createLigatureController } from './ligatures'
import { getTerminalLaunch } from '../state/terminalLaunchRegistry'
import { parseRenderedActivityCaption } from './renderedActivityCaption'

const DISABLE_MOUSE_TRACKING =
  '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l'

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
 * M2：PTY 输出使用 Uint8Array；xterm 解析完成后 ack，由主进程做有界背压。
 */
export function useXterm(
  containerRef: RefObject<HTMLDivElement | null>,
  tabId: string,
  active: boolean,
  onCopied?: () => void,
  onTitle?: (title: string) => void,
  onExit?: (code: number | undefined, respawned: boolean) => void,
  onInitialSpawn?: (error: string | null) => void
): void {
  const terminalRef = useRef<Terminal | null>(null)
  const rendererRef = useRef<RendererController | null>(null)
  const rendererFrameRef = useRef<number | null>(null)
  const fitRequestRef = useRef<(() => void) | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const onCopiedRef = useRef(onCopied)
  const onTitleRef = useRef(onTitle)
  const onExitRef = useRef(onExit)
  const onInitialSpawnRef = useRef(onInitialSpawn)
  useEffect(() => {
    onCopiedRef.current = onCopied
    onTitleRef.current = onTitle
    onExitRef.current = onExit
    onInitialSpawnRef.current = onInitialSpawn
  }, [onCopied, onExit, onInitialSpawn, onTitle])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // windowsPty 告知 xterm 使用对应的 ConPTY/build 兼容路径；build≥21376 时仍启用 reflow。
    // REPRO 已证明 xterm reflow 本身能完整保留历史。真正有破坏性的 ConPTY resize 整屏重画
    // 由主进程 ConptyResizeFilter 隔离，不会进入这里的 term.write。
    const meta = window.ptyApi.getMeta()
    const initialSettings = useSettingsStore.getState()
    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: initialSettings.fontFamily,
      fontSize: initialSettings.fontSize,
      cursorBlink: true,
      // 主进程会隔离 ConPTY resize 重画，因此当前光标行也必须由 xterm 自己 reflow。
      reflowCursorLine: true,
      windowsPty: meta.windowsPty,
      theme: getTerminalTheme(initialSettings.terminalThemeId).terminal
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    terminalRef.current = term
    const ligatures = createLigatureController(
      term,
      initialSettings.ligatures
    )
    const bufferChangeDisposable = term.buffer.onBufferChange((buffer) => {
      // TUI 异常/快速退出时可能已经切回 normal buffer，却遗漏 mouse tracking
      // 的 DECRST（opencode /exit 可稳定复现）。此时普通拖拽会继续被当作
      // 终端鼠标事件。只在离开 alternate buffer 后修复状态，不影响 TUI 内交互。
      if (
        buffer.type === 'normal' &&
        term.modes.mouseTrackingMode !== 'none'
      ) {
        term.write(DISABLE_MOUSE_TRACKING)
      }
    })
    const renderer = createRendererController(term)
    rendererRef.current = renderer
    fit.fit()
    term.attachCustomKeyEventHandler((event) => !handleShellShortcut(event))
    const titleDisposable = term.onTitleChange((title) => {
      onTitleRef.current?.(title)
    })

    let proxy: PtyProxy | null = null
    let initialSpawnPending = true
    // S1：AI CLI 启动走主进程 AgentSessionRuntime；普通终端保持原链路。
    const launch = getTerminalLaunch(tabId)
    const isAgentLaunch = launch?.kind === 'agent'
    let agentSessionReady = false
    const settleInitialSpawn = (error: string | null): void => {
      if (!initialSpawnPending) return
      initialSpawnPending = false
      onInitialSpawnRef.current?.(error)
    }
    let disposed = false
    let ptyAckDelayMs = 0
    let ptyRenderingSuspended = false
    const pendingAckTimers = new Set<ReturnType<typeof setTimeout>>()
    // ConPTY 下 TUI（如 opencode/OpenTUI）在 Windows 上 Ctrl+C 会连带杀死整个
    // pty，node-pty 报出 undefined exit code。异常退出时在当前 tab 自动重启 shell，
    // 而不是让终端停在死会话。连续异常只兜底几次，避免坏环境里无限循环。
    let respawnCount = 0
    let respawnTimer: ReturnType<typeof setTimeout> | null = null
    const MAX_ABNORMAL_EXITS = 3

    const acknowledgeParsedData = (bytes: number): void => {
      const acknowledge = (): void => {
        if (!disposed) void proxy?.ack(bytes)
      }
      if (ptyAckDelayMs <= 0) {
        acknowledge()
        return
      }
      const timer = setTimeout(() => {
        pendingAckTimers.delete(timer)
        acknowledge()
      }, ptyAckDelayMs)
      pendingAckTimers.add(timer)
    }

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
      if (disposed || !proxy || !activeRef.current) return
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
      if (disposed || !activeRef.current) return
      if (container.clientWidth <= 0 || container.clientHeight <= 0) return
      const proposed = fit.proposeDimensions()
      if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) return
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
    fitRequestRef.current = scheduleResize

    const unsubscribeSettings = useSettingsStore.subscribe(
      (settings, previous) => {
        if (settings.terminalThemeId !== previous.terminalThemeId) {
          term.options.theme = getTerminalTheme(
            settings.terminalThemeId
          ).terminal
        }
        if (
          settings.fontFamily !== previous.fontFamily ||
          settings.fontSize !== previous.fontSize
        ) {
          term.options.fontFamily = settings.fontFamily
          term.options.fontSize = settings.fontSize
          if (activeRef.current) scheduleResize()
        }
        if (settings.ligatures !== previous.ligatures) {
          ligatures.setEnabled(settings.ligatures)
        }
      }
    )

    let lastPublishedCaption = ''
    const captionTimer = isAgentLaunch
      ? setInterval(() => {
          if (disposed || !agentSessionReady) return
          const buffer = term.buffer.active
          const bottom = Math.min(
            buffer.length - 1,
            buffer.viewportY + term.rows - 1
          )
          const lines: string[] = []
          for (let index = Math.max(0, bottom - 11); index <= bottom; index++) {
            const line = buffer.getLine(index)
            if (line) lines.push(line.translateToString(true))
          }
          const caption = parseRenderedActivityCaption(lines)
          if (!caption || caption.text === lastPublishedCaption) return
          lastPublishedCaption = caption.text
          void window.agentApi.publishCaption({
            terminalId: tabId,
            text: caption.text,
            outputTokens: caption.outputTokens
          })
        }, 600)
      : null

    // 调试桥：E2E/dev 下暴露 window.__vibingDebug，可读 buffer、可主动 forceResize。
    const unregisterDebug = registerTerminalForDebug(
      tabId,
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
      () => proxy?.history() ?? Promise.resolve(null),
      () => proxy?.flowControl() ?? Promise.resolve(null),
      (milliseconds) => {
        ptyAckDelayMs = Math.max(0, Math.floor(milliseconds))
      },
      renderer,
      (suspended) => {
        ptyRenderingSuspended = suspended
      }
    )

    /**
     * 绑定一个新 pty 到当前 xterm。首次 spawn 与异常退出后的自动重启共用，
     * 保证两条路径的 data/exit 语义一致。
     */
    const wireProxy = (next: PtyProxy): void => {
      proxy?.dispose()
      proxy = next
      // spawn 完成后同步一次尺寸：spawn 期间容器尺寸可能已变，且此时 proxy 才可用。
      if (ptyResizeTimer) {
        clearTimeout(ptyResizeTimer)
        ptyResizeTimer = null
      }
      pendingPtyResize = null
      const { cols, rows } = term
      sendPtyResize(cols, rows)

      // pty → 屏幕；xterm 解析完成后 ack，驱动主进程高低水位背压。
      next.onData((d) => {
        recordPtyData(tabId, d)
        if (ptyRenderingSuspended) {
          acknowledgeParsedData(d.byteLength)
          return
        }
        term.write(d, () => acknowledgeParsedData(d.byteLength))
      })
      next.onResizeCursorSync(({ row, column }) => {
        applyConptyCursorSync(term, row, column)
      })
      next.onExit(({ code }) => {
        if (disposed) return
        // Agent 会话不自动重启：PTY 退出即事实（由主进程归约 session.exited）。
        const respawned =
          !isAgentLaunch && code === undefined && respawnCount < MAX_ABNORMAL_EXITS
        if (respawned) {
          respawnCount++
          term.write(
            '\r\n\x1b[90m[shell exited unexpectedly; restarting shell]\x1b[0m'
          )
          respawnTimer = setTimeout(() => {
            respawnTimer = null
            spawnShell()
          }, 400)
        } else {
          term.write(
            `\r\n\x1b[90m[process exited${code === undefined ? '' : ` with code ${code}`}]\x1b[0m`
          )
        }
        onExitRef.current?.(code, respawned)
      })
    }

    const spawnShell = (): void => {
      if (disposed) return
      if (isAgentLaunch && launch?.kind === 'agent') {
        window.agentApi
          .start({
            terminalId: tabId,
            selection: launch.selection,
            name: launch.name,
            cols: term.cols,
            rows: term.rows
          })
          .then((started) => {
            if (disposed) {
              void window.agentApi.stop(started.sessionId)
              settleInitialSpawn(
                'Launch was cancelled before the terminal became ready'
              )
              return
            }
            agentSessionReady = true
            wireProxy(new PtyProxy(started.ptyId))
            settleInitialSpawn(null)
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            term.write(
              `\r\n\x1b[31mFailed to launch CLI: ${message}\x1b[0m\r\n`
            )
            settleInitialSpawn(message)
          })
        return
      }
      window.ptyApi
        .spawn({
          ...(launch?.kind === 'shell' ? launch.shell : {}),
          cols: term.cols,
          rows: term.rows
        })
        .then(({ ptyId }) => {
          if (disposed) {
            void window.ptyApi.kill(ptyId)
            settleInitialSpawn('Launch was cancelled before the terminal became ready')
            return
          }
          wireProxy(new PtyProxy(ptyId))
          settleInitialSpawn(null)
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          term.write(
            `\r\n\x1b[31mFailed to spawn shell: ${message}\x1b[0m\r\n`
          )
          settleInitialSpawn(message)
        })
    }

    // 键盘 → pty；只在挂载时注册一次，自动重启换 proxy 不重复挂。
    term.onData((d) => {
      void proxy?.write(d)
    })
    spawnShell()

    const ro = new ResizeObserver(scheduleResize)
    ro.observe(container)

    return () => {
      disposed = true
      if (captionTimer) clearInterval(captionTimer)
      for (const timer of pendingAckTimers) clearTimeout(timer)
      pendingAckTimers.clear()
      if (fitFrame !== null) cancelAnimationFrame(fitFrame)
      if (rendererFrameRef.current !== null) {
        cancelAnimationFrame(rendererFrameRef.current)
        rendererFrameRef.current = null
      }
      unsubscribeSettings()
      if (ptyResizeTimer) clearTimeout(ptyResizeTimer)
      if (respawnTimer) {
        clearTimeout(respawnTimer)
        respawnTimer = null
      }
      unregisterDebug()
      bufferChangeDisposable.dispose()
      titleDisposable.dispose()
      ro.disconnect()
      container.removeEventListener('contextmenu', copySelectionOnContextMenu)
      proxy?.dispose()
      void proxy?.kill()
      renderer.dispose()
      ligatures.dispose()
      if (rendererRef.current === renderer) rendererRef.current = null
      if (fitRequestRef.current === scheduleResize) fitRequestRef.current = null
      if (terminalRef.current === term) terminalRef.current = null
      term.dispose()
    }
  }, [containerRef, tabId])

  useEffect(() => {
    if (rendererFrameRef.current !== null) {
      cancelAnimationFrame(rendererFrameRef.current)
      rendererFrameRef.current = null
    }
    if (!active) {
      rendererRef.current?.deactivate()
      return
    }
    terminalRef.current?.focus()
    setActiveTerminalForDebug(tabId)
    rendererFrameRef.current = requestAnimationFrame(() => {
      rendererFrameRef.current = null
      rendererRef.current?.activate()
      fitRequestRef.current?.()
    })
    return () => {
      if (rendererFrameRef.current !== null) {
        cancelAnimationFrame(rendererFrameRef.current)
        rendererFrameRef.current = null
      }
    }
  }, [active, tabId])
}

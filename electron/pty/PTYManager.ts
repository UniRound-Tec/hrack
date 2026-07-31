import type { IPty } from 'node-pty'
import { spawn } from 'node-pty'
import { BrowserWindow } from 'electron'
import {
  ptyDataChannel,
  ptyExitChannel,
  ptyResizeCursorSyncChannel,
  type PtyFlowControlSnapshot,
  type PtyHistorySnapshot,
  type SpawnOptions
} from '../../shared/ipc-contract'
import { PtyHistory } from './PtyHistory'
import { ConptyResizeFilter } from './ConptyResizeFilter'
import {
  installPtyErrorGuard,
  type PtyErrorEmitter
} from './PtyErrorGuard'
import {
  PTY_DATA_HIGH_WATER_MARK_BYTES,
  PTY_DATA_LOW_WATER_MARK_BYTES,
  PTY_DATA_MAX_BUFFERED_BYTES,
  PtyDataQueue
} from './PtyDataQueue'

interface ManagedPty {
  pty?: IPty
  history: PtyHistory
  dataQueue: PtyDataQueue
  resizeFilter?: ConptyResizeFilter
  /** renderer 已 fit、但尚未安全送给 ConPTY 的最新尺寸。 */
  pendingResize?: { cols: number; rows: number }
  resizeTimer?: ReturnType<typeof setTimeout>
  /** 最近一次真正转发给 renderer 的输出；不包含被抑制的 ConPTY resize 重画。 */
  lastForwardedOutputAt: number
}

/**
 * ConPTY 的 resize 重画不是纯装饰：若应用恰好同时输出，新字符可能只出现在
 * 那一帧整屏重画里。直接丢掉整帧会随机少一行。等输出短暂静默后再 resize，
 * 既保留 renderer 已完成的即时 reflow，也避免把真实输出和重画一起过滤掉。
 */
// node-pty/ConPTY 会把多行合并成不规则 chunk；窗口和 zoom 变化也可能暂时阻塞
// Electron 主线程，因此 100ms 量级仍会把同一波输出误判成静默。500ms 足以跨过
// 实测的批处理间隙，同时 renderer 已先行 fit，用户不会等待半秒才看到窗口适配。
const RESIZE_OUTPUT_QUIET_MS = 500

/** 按 SPEC §7 选默认 shell。Windows 优先 pwsh，回退 powershell / cmd。 */
function defaultShellCandidates(req?: string): string[] {
  if (req) return [req]
  if (process.platform === 'win32') {
    return ['pwsh.exe', 'powershell.exe', process.env.COMSPEC ?? 'cmd.exe']
  }
  return [process.env.SHELL ?? 'bash', 'sh']
}

/**
 * 唯一持有 node-pty 实例的管理器（主进程）。
 * 对外暴露 spawn/write/resize/kill，向上经 IPC 发 data/exit。
 * M2：PtyDataQueue 用 xterm 消费完成后的 ack 控制 node-pty pause/resume，
 * 并对 Main→Renderer 在途与排队数据设置硬上限。
 */
export class PTYManager {
  private ptys = new Map<string, ManagedPty>()
  private nextId = 1

  spawn(opts: SpawnOptions) {
    const ptyId = String(this.nextId++)
    const cols = opts.cols ?? 80
    const rows = opts.rows ?? 24
    console.log(`[vibing] spawn ptyId=${ptyId} shell=${opts.shell ?? '(default)'}`)

    let pty: IPty | undefined
    let lastErr: unknown
    for (const shell of defaultShellCandidates(opts.shell)) {
      try {
        pty = spawn(shell, opts.args ?? [], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: opts.cwd ?? process.cwd(),
          env: (opts.env ?? (process.env as Record<string, string>))
        })
        break
      } catch (err) {
        lastErr = err
      }
    }
    if (!pty) throw lastErr ?? new Error('failed to spawn pty')

    const spawnedPty = pty
    installPtyErrorGuard(spawnedPty as unknown as PtyErrorEmitter)
    const history = new PtyHistory()
    history.appendResize(cols, rows)
    const resizeFilter =
      process.platform === 'win32' ? new ConptyResizeFilter() : undefined
    const dataQueue = new PtyDataQueue({
      highWaterMarkBytes: PTY_DATA_HIGH_WATER_MARK_BYTES,
      lowWaterMarkBytes: PTY_DATA_LOW_WATER_MARK_BYTES,
      maxBufferedBytes: PTY_DATA_MAX_BUFFERED_BYTES,
      send: (data) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(ptyDataChannel(ptyId), data)
        }
      },
      pause: () => spawnedPty.pause(),
      resume: () => spawnedPty.resume()
    })
    const managed: ManagedPty = {
      pty: spawnedPty,
      history,
      dataQueue,
      resizeFilter,
      lastForwardedOutputAt: 0
    }
    this.ptys.set(ptyId, managed)

    pty.onData((data) => {
      // 权威历史永远保存未经修改的原始流；过滤只作用于易受 ConPTY
      // resize 重画破坏的 renderer 显示链路。
      history.appendOutput(data)
      const filtered = resizeFilter?.push(data)
      const displayData = filtered?.forward ?? data
      // ConPTY 自己的 resize 重画不能延长“输出活跃”窗口，否则连续拖窗时
      // 每个重画都会重新触发 500ms 保护延迟，表现为终端尺寸明显跟手不足。
      if (displayData.length > 0) {
        managed.lastForwardedOutputAt = Date.now()
        this.schedulePendingResize(managed)
      }
      for (const win of BrowserWindow.getAllWindows()) {
        for (const cursor of filtered?.cursorSyncs ?? []) {
          win.webContents.send(ptyResizeCursorSyncChannel(ptyId), cursor)
        }
      }
      if (displayData.length > 0) {
        const accepted = dataQueue.push(new TextEncoder().encode(displayData))
        if (!accepted) {
          console.error(
            `[vibing] ptyId=${ptyId} output exceeded the bounded delivery buffer; terminating PTY`
          )
          try {
            spawnedPty.kill()
          } catch {
            /* process may already be exiting */
          }
        }
      }
    })

    pty.onExit(({ exitCode, signal }) => {
      const ch = ptyExitChannel(ptyId)
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(ch, { code: exitCode, signal } as never)
      }
      // 进程退出后仍保留会话历史，直到 renderer 明确 kill/关闭该会话。
      // 否则主进程权威源会在用户最需要回看退出输出时消失。
      const current = this.ptys.get(ptyId)
      if (current?.pty === pty) {
        if (current.resizeTimer) clearTimeout(current.resizeTimer)
        current.resizeTimer = undefined
        current.pendingResize = undefined
        current.pty = undefined
      }
    })

    return { ptyId }
  }

  write(ptyId: string, data: string) {
    this.ptys.get(ptyId)?.pty?.write(data)
  }

  resize(ptyId: string, cols: number, rows: number) {
    const managed = this.ptys.get(ptyId)
    if (!managed?.pty) return
    // 输出活跃时只保留最新尺寸。renderer 的 xterm 已经立即 fit/reflow；
    // ConPTY 尺寸会在 500ms 无输出后跟上。
    managed.pendingResize = { cols, rows }
    this.schedulePendingResize(managed)
  }

  ack(ptyId: string, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return
    this.ptys.get(ptyId)?.dataQueue.ack(bytes)
  }

  private schedulePendingResize(managed: ManagedPty): void {
    if (!managed.pty || !managed.pendingResize) return
    if (managed.resizeTimer) {
      clearTimeout(managed.resizeTimer)
      managed.resizeTimer = undefined
    }

    const quietFor = Date.now() - managed.lastForwardedOutputAt
    const delay = Math.max(0, RESIZE_OUTPUT_QUIET_MS - quietFor)
    if (delay > 0) {
      managed.resizeTimer = setTimeout(() => {
        managed.resizeTimer = undefined
        this.schedulePendingResize(managed)
      }, delay)
      return
    }

    const targetPty = managed.pty
    if (!targetPty) return
    const { cols, rows } = managed.pendingResize
    managed.pendingResize = undefined
    const resizeGeneration = managed.resizeFilter?.expectResize()
    try {
      targetPty.resize(cols, rows)
      managed.history.appendResize(cols, rows)
    } catch (error) {
      // resize 未送达 PTY 时不能让过滤器继续等待，否则会误判下一段普通输出。
      if (resizeGeneration !== undefined) {
        managed.resizeFilter?.cancelExpectedResize(resizeGeneration)
      }
      // ConPTY 可以在最后一次存活检查与 native resize 调用之间退出。
      // resize 是窗口同步的 best-effort 操作，迟到失败不能成为主进程未捕获异常。
      console.warn(
        `[vibing] ignored stale PTY resize ${cols}x${rows}: ${String(error)}`
      )
    }
  }

  history(ptyId: string): PtyHistorySnapshot | null {
    return this.ptys.get(ptyId)?.history.snapshot() ?? null
  }

  flowControl(ptyId: string): PtyFlowControlSnapshot | null {
    return this.ptys.get(ptyId)?.dataQueue.snapshot() ?? null
  }

  kill(ptyId: string) {
    const managed = this.ptys.get(ptyId)
    if (!managed) return
    if (managed.resizeTimer) clearTimeout(managed.resizeTimer)
    if (managed.pty) {
      try {
        managed.pty.kill()
      } catch {
        /* 已退出则忽略 */
      }
    }
    // 即使进程早已自行退出，也必须在会话关闭时释放保留的权威历史。
    this.ptys.delete(ptyId)
  }

  killAll() {
    for (const { pty, resizeTimer } of this.ptys.values()) {
      if (resizeTimer) clearTimeout(resizeTimer)
      if (!pty) continue
      try {
        pty.kill()
      } catch {
        /* ignore */
      }
    }
    this.ptys.clear()
  }
}

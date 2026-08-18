import type { IPty } from 'node-pty'
import { spawn } from 'node-pty'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { BrowserWindow } from 'electron'
import {
  ptyDataChannel,
  ptyExitChannel,
  ptyResizeCursorSyncChannel,
  type ExitPayload,
  type PtyFlowControlSnapshot,
  type PtyHistorySnapshot,
  type PtyTerminalIdentity,
  type RecoverablePty,
  type SpawnOptions
} from '../../shared/ipc-contract'
import { PtyHistory } from './PtyHistory'
import { ConptyResizeFilter } from './ConptyResizeFilter'
import { installPtyErrorGuard, type PtyErrorEmitter } from './PtyErrorGuard'
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
  /** 同一批 pending resize 首次到达的时间；连续输出不能无限延后它。 */
  pendingResizeRequestedAt?: number
  resizeTimer?: ReturnType<typeof setTimeout>
  /** 最近一次真正转发给 renderer 的输出；不包含被抑制的 ConPTY resize 重画。 */
  lastForwardedOutputAt: number
  terminal?: PtyTerminalIdentity
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
// Claude / OpenTUI 的 spinner 会持续输出，可能永远没有 500ms 静默窗口。
// renderer 虽然已经完成 reflow，但子进程仍按旧列宽绘制，就会只占窗口左侧。
// 保留短暂静默优先策略，同时给 PTY resize 一个硬截止时间。
const RESIZE_MAX_DEFERRAL_MS = 750

/** 按 SPEC §7 选默认 shell。Windows 优先 pwsh，回退 powershell / cmd。 */
function defaultShellCandidates(req?: string): string[] {
  if (req) return [req]
  if (process.platform === 'win32') {
    return ['pwsh.exe', 'powershell.exe', process.env.COMSPEC ?? 'cmd.exe']
  }
  return [process.env.SHELL ?? 'bash', 'sh']
}

/**
 * Windows 下 node-pty 的 CreateProcess 不会走 PATH 解析裸命令名
 * （M5.c 真实 CLI 会话依赖这一点）。含路径分隔符的 shell 直接返回；
 * 否则用 where.exe 解析出首个可执行文件。
 */
function looksLikePath(shell: string): boolean {
  return shell.includes('\\') || shell.includes('/')
}

/**
 * PTY child capabilities are independent from the renderer's visual theme.
 * Codex Desktop launches HRack with TERM=dumb, which is correct for its own
 * non-interactive command runner but not for the ConPTY/xterm surface we create.
 */
export function ptyEnvironment(
  inherited: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (typeof value === 'string') env[key] = value
  }
  const termKey = Object.keys(env).find(
    (key) => key.toUpperCase() === 'TERM'
  )
  const term = termKey ? env[termKey] : undefined
  if (!term || term.trim().toLowerCase() === 'dumb') {
    if (termKey && termKey !== 'TERM') delete env[termKey]
    env.TERM = 'xterm-256color'
  }
  return env
}

/** 普通终端未指定工作区时进用户主目录，避免打包后落到安装目录。 */
export function resolvePtyCwd(
  opts: Pick<SpawnOptions, 'cwd'> & {
    terminal?: Pick<PtyTerminalIdentity, 'cwd'>
  },
  home = homedir()
): string {
  return opts.cwd?.trim() || opts.terminal?.cwd.trim() || home
}

async function resolveWindowsExecutable(shell: string): Promise<string | null> {
  if (!looksLikePath(shell)) {
    try {
      const execFileAsync = promisify(execFile)
      const { stdout } = await execFileAsync(
        'where.exe',
        [shell.replace(/\.exe$/i, '')],
        { timeout: 1_500, windowsHide: true }
      )
      const resolved = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean)
      if (resolved) return resolved
    } catch {
      /* 未命中 PATH：保留原值让 spawn 报真实错误 */
    }
  }
  return null
}

/**
 * 唯一持有 node-pty 实例的管理器（主进程）。
 * 对外暴露 spawn/write/resize/kill，向上经 IPC 发 data/exit。
 * M2：PtyDataQueue 用 xterm 消费完成后的 ack 控制 node-pty pause/resume，
 * 并对 Main→Renderer 在途与排队数据设置硬上限。
 *
 * S1：新增主进程内部 exit 订阅 seam（AgentSessionRuntime 专用），
 * 并缓存已退出 payload，避免「spawn 后立即退出」与「晚订阅」的竞态。
 * 本模块不引入 AgentEvent 或品牌判断。
 */
export class PTYManager {
  private readonly terminalRemovedListeners = new Set<(terminalId: string) => void>()
  private ptys = new Map<string, ManagedPty>()
  private nextId = 1
  private exitListeners = new Map<string, Set<(payload: ExitPayload) => void>>()
  private exitedPayloads = new Map<string, ExitPayload>()
  private inputSubmitListeners = new Map<string, Set<() => void>>()

  /**
   * 订阅某 pty 的退出（幂等：已退出则立刻用缓存的 payload 回调）。
   * 返回取消订阅函数。
   */
  onExit(ptyId: string, cb: (payload: ExitPayload) => void): () => void {
    let active = true
    const listeners = this.exitListeners.get(ptyId) ?? new Set()
    listeners.add(cb)
    this.exitListeners.set(ptyId, listeners)
    const cached = this.exitedPayloads.get(ptyId)
    if (cached)
      queueMicrotask(() => {
        if (active) cb(cached)
      })
    return () => {
      active = false
      const current = this.exitListeners.get(ptyId)
      current?.delete(cb)
      if (current?.size === 0) this.exitListeners.delete(ptyId)
    }
  }

  /** Observer watchdog 只读取时间事实，不接触 PTY 内容。 */
  lastOutputAt(ptyId: string): number | null {
    return this.ptys.get(ptyId)?.lastForwardedOutputAt ?? null
  }

  isRunning(ptyId: string): boolean {
    return Boolean(this.ptys.get(ptyId)?.pty)
  }

  /** 只暴露提交边界，不暴露用户输入内容。 */
  onInputSubmitted(ptyId: string, cb: () => void): () => void {
    const listeners = this.inputSubmitListeners.get(ptyId) ?? new Set()
    listeners.add(cb)
    this.inputSubmitListeners.set(ptyId, listeners)
    return () => {
      const current = this.inputSubmitListeners.get(ptyId)
      current?.delete(cb)
      if (current?.size === 0) this.inputSubmitListeners.delete(ptyId)
    }
  }

  async spawn(opts: SpawnOptions) {
    const ptyId = String(this.nextId++)
    const cols = opts.cols ?? 80
    const rows = opts.rows ?? 24
    console.log(
      `[hrack] spawn ptyId=${ptyId} shell=${opts.shell ?? '(default)'}`
    )

    // Windows：裸命令名先解析成绝对路径，避免 CreateProcess 找不到可执行文件。
    let resolvedShell: string | undefined
    if (process.platform === 'win32' && opts.shell) {
      const resolved = await resolveWindowsExecutable(opts.shell)
      if (resolved) resolvedShell = resolved
    }

    const cwd = resolvePtyCwd(opts)
    let pty: IPty | undefined
    let lastErr: unknown
    for (const shell of defaultShellCandidates(resolvedShell ?? opts.shell)) {
      try {
        pty = spawn(shell, opts.args ?? [], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env: ptyEnvironment(opts.env ?? process.env)
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
      lastForwardedOutputAt: 0,
      terminal: opts.terminal
        ? { ...opts.terminal, cwd: opts.terminal.cwd.trim() || cwd }
        : opts.terminal
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
            `[hrack] ptyId=${ptyId} output exceeded the bounded delivery buffer; terminating PTY`
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
      const payload: ExitPayload = { code: exitCode, signal }
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(ch, payload as never)
      }
      // 进程退出后仍保留会话历史，直到 renderer 明确 kill/关闭该会话。
      // 否则主进程权威源会在用户最需要回看退出输出时消失。
      const current = this.ptys.get(ptyId)
      if (current?.pty === pty) {
        // S1：内部生命周期 seam（Runtime 订阅；已退出 payload 缓存供晚订阅者）。
        this.exitedPayloads.set(ptyId, payload)
        const listeners = this.exitListeners.get(ptyId)
        if (listeners) {
          for (const cb of listeners) cb(payload)
        }
        this.exitListeners.delete(ptyId)
        if (current.resizeTimer) clearTimeout(current.resizeTimer)
        current.resizeTimer = undefined
        current.pendingResize = undefined
        current.pendingResizeRequestedAt = undefined
        current.pty = undefined
      }
    })

    return { ptyId }
  }

  write(ptyId: string, data: string) {
    const target = this.ptys.get(ptyId)?.pty
    if (!target) return
    target.write(data)
    if (/[\r\n]/.test(data)) {
      for (const listener of this.inputSubmitListeners.get(ptyId) ?? [])
        listener()
    }
  }

  resize(ptyId: string, cols: number, rows: number) {
    const managed = this.ptys.get(ptyId)
    if (!managed?.pty) return
    // 输出活跃时只保留最新尺寸。renderer 的 xterm 已经立即 fit/reflow；
    // ConPTY 尺寸优先在 500ms 无输出后跟上；持续输出时也会在硬截止时间送达。
    if (!managed.pendingResize) managed.pendingResizeRequestedAt = Date.now()
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
    const requestedAt = managed.pendingResizeRequestedAt ?? Date.now()
    const pendingFor = Date.now() - requestedAt
    const quietDelay = Math.max(0, RESIZE_OUTPUT_QUIET_MS - quietFor)
    const deadlineDelay = Math.max(0, RESIZE_MAX_DEFERRAL_MS - pendingFor)
    const delay = Math.min(quietDelay, deadlineDelay)
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
    managed.pendingResizeRequestedAt = undefined
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
        `[hrack] ignored stale PTY resize ${cols}x${rows}: ${String(error)}`
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
    this.exitListeners.delete(ptyId)
    this.exitedPayloads.delete(ptyId)
    this.inputSubmitListeners.delete(ptyId)
    const terminalId = managed.terminal?.terminalId
    if (terminalId) {
      for (const listener of this.terminalRemovedListeners) listener(terminalId)
    }
  }

  killAll() {
    const terminalIds = new Set(
      [...this.ptys.values()]
        .map((managed) => managed.terminal?.terminalId)
        .filter((terminalId): terminalId is string => Boolean(terminalId))
    )
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
    this.exitListeners.clear()
    this.exitedPayloads.clear()
    this.inputSubmitListeners.clear()
    for (const terminalId of terminalIds) {
      for (const listener of this.terminalRemovedListeners) listener(terminalId)
    }
  }

  onTerminalRemoved(listener: (terminalId: string) => void): () => void {
    this.terminalRemovedListeners.add(listener)
    return () => this.terminalRemovedListeners.delete(listener)
  }

  /**
   * 与 JS 事件循环内的 history snapshot 同步执行：先清理旧 renderer
   * 未 ack 的字节，再取快照。之后到达的输出只会进入新订阅者。
   */
  attach(ptyId: string): PtyHistorySnapshot | null {
    const managed = this.ptys.get(ptyId)
    if (!managed) return null
    managed.dataQueue.resetForAttach()
    return managed.history.snapshot()
  }

  listRecoverable(): RecoverablePty[] {
    const recoverable: RecoverablePty[] = []
    for (const [ptyId, managed] of this.ptys) {
      if (!managed.terminal) continue
      recoverable.push({
        ...managed.terminal,
        ptyId,
        exited: !managed.pty
      })
    }
    return recoverable
  }

  killTerminal(terminalId: string): void {
    const matches = [...this.ptys.entries()]
      .filter(([, managed]) => managed.terminal?.terminalId === terminalId)
      .map(([ptyId]) => ptyId)
    for (const ptyId of matches) this.kill(ptyId)
  }
}

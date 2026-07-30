import type {
  ExitPayload,
  PtyHistorySnapshot,
  PtyResizeCursorSync
} from '../../shared/ipc-contract'

type DataCb = (data: string) => void
type ExitCb = (payload: ExitPayload) => void
type ResizeCursorSyncCb = (payload: PtyResizeCursorSync) => void

/**
 * 面向单个 ptyId 的 IPC 薄封装（renderer 侧）。
 * 屏蔽 window.ptyApi 的 channel 细节，给 useXterm 提供干净接口。
 */
export class PtyProxy {
  private disposers: Array<() => void> = []

  constructor(private readonly ptyId: string) {}

  get id(): string {
    return this.ptyId
  }

  write(data: string): Promise<void> {
    return window.ptyApi.write(this.ptyId, data)
  }

  resize(cols: number, rows: number): Promise<void> {
    return window.ptyApi.resize(this.ptyId, cols, rows)
  }

  kill(): Promise<void> {
    return window.ptyApi.kill(this.ptyId)
  }

  history(): Promise<PtyHistorySnapshot | null> {
    return window.ptyApi.getHistory(this.ptyId)
  }

  onData(cb: DataCb): void {
    this.disposers.push(window.ptyApi.onData(this.ptyId, cb))
  }

  onResizeCursorSync(cb: ResizeCursorSyncCb): void {
    this.disposers.push(window.ptyApi.onResizeCursorSync(this.ptyId, cb))
  }

  onExit(cb: ExitCb): void {
    this.disposers.push(window.ptyApi.onExit(this.ptyId, cb))
  }

  /** 注销所有监听（不动 pty 本身；kill 另调）。 */
  dispose(): void {
    while (this.disposers.length) {
      this.disposers.pop()?.()
    }
  }
}

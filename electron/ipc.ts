import { clipboard, ipcMain } from 'electron'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { PTYManager } from './pty/PTYManager'
import {
  ClipboardInvokeChannel,
  PtyInvokeChannel,
  type SpawnOptions
} from '../shared/ipc-contract'

const MAX_CLIPBOARD_TEXT_LENGTH = 8 * 1024 * 1024

/** 注册所有 pty 相关的 invoke handler，委托 PTYManager。 */
export function registerIpc(manager: PTYManager): void {
  ipcMain.handle(PtyInvokeChannel.Spawn, (_e, opts: SpawnOptions) =>
    manager.spawn(opts)
  )
  ipcMain.handle(
    PtyInvokeChannel.Write,
    (_e, { ptyId, data }: { ptyId: string; data: string }) =>
      manager.write(ptyId, data)
  )
  ipcMain.handle(
    PtyInvokeChannel.Resize,
    (_e, { ptyId, cols, rows }: { ptyId: string; cols: number; rows: number }) =>
      manager.resize(ptyId, cols, rows)
  )
  ipcMain.handle(
    PtyInvokeChannel.Ack,
    (_e, { ptyId, bytes }: { ptyId: string; bytes: number }) =>
      manager.ack(ptyId, bytes)
  )
  ipcMain.handle(PtyInvokeChannel.Kill, (_e, { ptyId }: { ptyId: string }) =>
    manager.kill(ptyId)
  )
  ipcMain.handle(
    PtyInvokeChannel.History,
    (_e, { ptyId }: { ptyId: string }) => manager.history(ptyId)
  )
  ipcMain.handle(
    PtyInvokeChannel.FlowControl,
    (_e, { ptyId }: { ptyId: string }) => manager.flowControl(ptyId)
  )
  ipcMain.handle(ClipboardInvokeChannel.WriteText, (_e, text: unknown) => {
    if (
      typeof text !== 'string' ||
      text.length === 0 ||
      text.length > MAX_CLIPBOARD_TEXT_LENGTH
    ) {
      return
    }
    clipboard.writeText(text)
  })

  // 诊断：渲染进程把 resize 前后的 buffer 快照写到 logs/resize-diag.log，供离线分析。
  // 只在真实 dev 会话里抓证据用，定位后移除。
  const diagPath = join(process.cwd(), 'logs', 'resize-diag.log')
  ipcMain.handle('diag:log', (_e, line: string) => {
    try {
      appendFileSync(diagPath, `${line}\n`)
    } catch {
      /* logs/ 不存在时忽略；由渲染侧首次调用前主进程已 ensure */
    }
  })
}

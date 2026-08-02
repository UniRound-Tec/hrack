import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent
} from 'electron'
import { appendFileSync } from 'node:fs'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { PTYManager } from './pty/PTYManager'
import {
  ClipboardInvokeChannel,
  DialogInvokeChannel,
  PtyInvokeChannel,
  ShellInvokeChannel,
  ThemeInvokeChannel,
  WindowInvokeChannel,
  type SpawnOptions
} from '../shared/ipc-contract'
import { listAvailableShells } from './shells'

const MAX_CLIPBOARD_TEXT_LENGTH = 8 * 1024 * 1024
const MAX_USER_THEME_FILES = 128
const MAX_USER_THEME_BYTES = 256 * 1024

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win && !win.isDestroyed() ? win : null
}

async function listUserThemes() {
  const themesDirectory = join(app.getPath('userData'), 'themes')
  await mkdir(themesDirectory, { recursive: true })
  const entries = (await readdir(themesDirectory, { withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json')
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_USER_THEME_FILES)

  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(themesDirectory, entry.name)
      const metadata = await stat(path)
      if (metadata.size > MAX_USER_THEME_BYTES) {
        return {
          filename: entry.name,
          error: `文件大小 ${metadata.size} 字节，超过 256 KB 上限`
        }
      }
      return { filename: entry.name, source: await readFile(path, 'utf8') }
    })
  )
  return files
}

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
  ipcMain.handle(WindowInvokeChannel.Minimize, (event) => {
    senderWindow(event)?.minimize()
  })
  ipcMain.handle(WindowInvokeChannel.ToggleMaximize, (event) => {
    const win = senderWindow(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle(WindowInvokeChannel.Close, (event) => {
    senderWindow(event)?.close()
  })
  ipcMain.handle(WindowInvokeChannel.IsMaximized, (event) =>
    Boolean(senderWindow(event)?.isMaximized())
  )
  ipcMain.handle(ThemeInvokeChannel.ListUser, listUserThemes)
  ipcMain.handle(
    DialogInvokeChannel.PickDirectory,
    async (event, payload: { defaultPath?: unknown } | undefined) => {
      const win = senderWindow(event)
      const defaultPath =
        typeof payload?.defaultPath === 'string'
          ? payload.defaultPath
          : undefined
      const options = {
        defaultPath,
        properties: ['openDirectory' as const]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? null : result.filePaths[0] ?? null
    }
  )
  ipcMain.handle(ShellInvokeChannel.ListAvailable, listAvailableShells)

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

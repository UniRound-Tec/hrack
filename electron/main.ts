import { app, BrowserWindow } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createWindow } from './window'
import { registerIpc, type IpcContext } from './ipc'
import { PTYManager } from './pty/PTYManager'
import { EventLog } from './events/EventLog'
import { loadMainPrefs, getMainPrefs } from './main-prefs'
import { markQuitting } from './quitting'
import {
  registerGlobalShortcut,
  unregisterGlobalShortcut,
  isGlobalShortcutRegistered
} from './shortcuts'
import {
  createTray,
  rebuildTrayMenu,
  toggleWindowVisibility,
  clickTrayMenuItem,
  trayMenuState,
  type Tray,
  type TrayCallbacks
} from './tray'
import { startThemeWatcher, stopThemeWatcher } from './themes-watch'
import { AppEventChannel } from '../shared/ipc-contract'

// E2E/开发：隔离 userData，保证 stats/主题等持久化断言从干净状态出发。
// 必须在 app ready 之前调用。
const userDataOverride = process.env['VIBING_USER_DATA_DIR']
if (userDataOverride) {
  app.setPath('userData', userDataOverride)
}

const manager = new PTYManager()

app.whenReady().then(async () => {
  // M0 验收：抵达此行即证明 node-pty 已按 Electron ABI 成功加载
  console.log('[vibing] app ready; node-pty loaded against Electron ABI OK')
  // 诊断日志目录
  try {
    mkdirSync(join(process.cwd(), 'logs'), { recursive: true })
  } catch {
    /* ignore */
  }

  const prefs = await loadMainPrefs()
  const eventLog = new EventLog()
  await eventLog.init()

  let winRef: BrowserWindow | null = null
  let trayRef: Tray | null = null

  const showWindow = (): void => {
    if (!winRef || winRef.isDestroyed()) return
    if (winRef.isMinimized()) winRef.restore()
    winRef.show()
    winRef.focus()
  }

  const trayCallbacks: TrayCallbacks = {
    toggleWindow: () => {
      if (winRef && !winRef.isDestroyed()) toggleWindowVisibility(winRef)
    },
    showWindow,
    openNewSession: () => {
      if (winRef && !winRef.isDestroyed() && !winRef.webContents.isDestroyed()) {
        winRef.webContents.send(AppEventChannel.OpenNewSession)
      }
    },
    quit: () => {
      markQuitting()
      app.quit()
    }
  }

  const ctx: IpcContext = {
    eventLog,
    getWindow: () => (winRef && !winRef.isDestroyed() ? winRef : null),
    getTray: () => trayRef,
    rebuildTrayMenu: () => {
      if (trayRef) rebuildTrayMenu(trayRef, getMainPrefs().language, trayCallbacks)
    }
  }

  registerIpc(manager, ctx)
  winRef = createWindow(prefs)
  trayRef = createTray(prefs.language, trayCallbacks)
  if (prefs.globalShortcutEnabled) {
    registerGlobalShortcut(winRef)
  }
  startThemeWatcher()

  // E2E：主进程调试钩子（托盘菜单点击 / 快捷键注册状态无法从 renderer 注入）。
  if (process.env['VIBING_E2E']) {
    ;(globalThis as Record<string, unknown>)['__vibingMainDebug'] = {
      hasTray: () => Boolean(trayRef),
      isWindowVisible: () => Boolean(winRef && !winRef.isDestroyed() && winRef.isVisible()),
      isWindowDestroyed: () => Boolean(winRef?.isDestroyed()),
      isShortcutRegistered: () => isGlobalShortcutRegistered(),
      toggleWindow: () => {
        if (winRef && !winRef.isDestroyed()) toggleWindowVisibility(winRef)
      },
      clickTrayItem: (index: number) => {
        const result = clickTrayMenuItem(index)
        return {
          ...trayMenuState(),
          invoked: result,
          visible: Boolean(winRef && !winRef.isDestroyed() && winRef.isVisible()),
          focused: Boolean(winRef && !winRef.isDestroyed() && winRef.isFocused())
        }
      },
      openNewSession: () => {
        if (winRef && !winRef.isDestroyed() && !winRef.webContents.isDestroyed()) {
          winRef.webContents.send(AppEventChannel.OpenNewSession)
        }
      }
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      winRef = createWindow(prefs)
    }
  })
})

app.on('before-quit', () => {
  markQuitting()
  manager.killAll()
  unregisterGlobalShortcut()
  stopThemeWatcher()
})

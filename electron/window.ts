import { BrowserWindow, nativeTheme, screen, shell } from 'electron'
import { join } from 'path'
import {
  WindowEventChannel,
  type WindowPositionPayload
} from '../shared/ipc-contract'
import { DEFAULT_BACKGROUND_COLOR, type MainPrefs } from './main-prefs'
import { isQuitting } from './quitting'
import { applyHrackWindowIcon, createThemedHrackIcon } from './app-icons'

/** 窗口位置换算成"相对当前显示器"坐标（多显示器下渐变坐标系跟随窗口所在屏）。 */
export function displayRelativePosition(
  win: BrowserWindow
): WindowPositionPayload {
  const bounds = win.getBounds()
  const display = screen.getDisplayMatching(bounds)
  return {
    x: bounds.x - display.bounds.x,
    y: bounds.y - display.bounds.y,
    screenWidth: display.bounds.width,
    screenHeight: display.bounds.height
  }
}

/** 原型定稿的桌面外框：max-w 1440、16:10；小屏按工作区收缩。 */
const DESIGN_WIDTH = 1440
const DESIGN_HEIGHT = 900

/**
 * 创建主窗口。
 * 安全基线（SPEC §2.2）：contextIsolation=true、nodeIntegration=false，
 * 只通过 preload 的 contextBridge 收窄暴露 API。
 *
 * M5.c 关闭语义：非 quitting 的 close 一律 preventDefault + hide（关闭到托盘），
 * 托盘「退出」/ app.before-quit 置位 quitting 后 close 才真正销毁窗口。
 * 首帧底色取主进程偏好文件里最近一次活动主题的 bg.app，消除深色主题启动白闪。
 */
export function createWindow(prefs: MainPrefs): BrowserWindow {
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    width: Math.min(DESIGN_WIDTH, workArea.width),
    height: Math.min(DESIGN_HEIGHT, workArea.height),
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'darwin'
      ? {}
      : { icon: createThemedHrackIcon() }),
    backgroundColor: prefs.backgroundColor || DEFAULT_BACKGROUND_COLOR,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : { frame: false }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const updateWindowIcon = (): void => {
    applyHrackWindowIcon(win)
  }
  updateWindowIcon()
  nativeTheme.on('updated', updateWindowIcon)

  win.on('close', (event) => {
    if (isQuitting()) return
    event.preventDefault()
    win.hide()
  })

  win.on('ready-to-show', () => {
    updateWindowIcon()
    win.show()
  })
  const sendMaximizedState = (): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(
        WindowEventChannel.MaximizedChanged,
        win.isMaximized()
      )
    }
  }
  win.on('maximize', sendMaximizedState)
  win.on('unmaximize', sendMaximizedState)
  const sendFullScreenState = (): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(
        WindowEventChannel.FullScreenChanged,
        win.isFullScreen()
      )
    }
  }
  win.on('enter-full-screen', sendFullScreenState)
  win.on('leave-full-screen', sendFullScreenState)

  // 拖动期间 move 事件高频触发；合并到 ~30ms 一次（尾沿），供侧栏环境渐变跟随。
  let moveTimer: NodeJS.Timeout | null = null
  win.on('move', () => {
    if (moveTimer) return
    moveTimer = setTimeout(() => {
      moveTimer = null
      if (win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send(
        WindowEventChannel.PositionChanged,
        displayRelativePosition(win)
      )
    }, 30)
  })
  win.on('closed', () => {
    if (moveTimer) clearTimeout(moveTimer)
    nativeTheme.off('updated', updateWindowIcon)
  })

  // 外链交给系统浏览器，避免在 Electron 内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // electron-vite dev 时注入 dev server URL；生产 loadFile 构建产物。
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    // dev：自动打开 DevTools。用独立窗口(detach)，避免挤占终端高度污染 fit() 的 rows 计算
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

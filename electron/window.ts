import { BrowserWindow, shell } from 'electron'
import { join } from 'path'

/**
 * 创建主窗口。
 * 安全基线（SPEC §2.2）：contextIsolation=true、nodeIntegration=false，
 * 只通过 preload 的 contextBridge 收窄暴露 API。
 */
export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1040,
    height: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

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

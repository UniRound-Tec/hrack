import { app, BrowserWindow } from 'electron'
import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { ThemeEventChannel } from '../shared/ipc-contract'

/**
 * 监视 `<userData>/themes/`，变更（新增/修改/删除）经 300ms debounce 后
 * 推送 `theme:user-themes-changed`，renderer 重新加载主题注册表。
 */
let watcher: FSWatcher | null = null

export function startThemeWatcher(): void {
  const directory = join(app.getPath('userData'), 'themes')
  try {
    mkdirSync(directory, { recursive: true })
  } catch {
    /* 权限受限时静默，watch 会因目录不存在而失败，忽略即可 */
  }
  let timer: NodeJS.Timeout | null = null
  try {
    watcher = watch(directory, () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed() || win.webContents.isDestroyed()) continue
          win.webContents.send(ThemeEventChannel.UserThemesChanged)
        }
      }, 300)
    })
  } catch (error) {
    console.warn('[themes] 主题目录监视不可用:', error)
  }
}

export function stopThemeWatcher(): void {
  watcher?.close()
  watcher = null
}

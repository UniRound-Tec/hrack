import { globalShortcut, type BrowserWindow } from 'electron'
import { toggleWindowVisibility } from './tray'

/**
 * 全局快捷键 `Ctrl+Alt+V`（固定键位，无录制 UI）。
 * 语义 = quake 风格：窗口可见且聚焦 → 隐藏；否则显示并聚焦（最小化先 restore）。
 * 注册失败（被其他应用占用）只记日志，不弹窗；设置开关重开时重试。
 */
export const GLOBAL_SHORTCUT_ACCELERATOR = 'Control+Alt+V'

export function registerGlobalShortcut(win: BrowserWindow): boolean {
  try {
    const ok = globalShortcut.register(GLOBAL_SHORTCUT_ACCELERATOR, () =>
      toggleWindowVisibility(win)
    )
    if (!ok) {
      console.warn(
        `[shortcut] ${GLOBAL_SHORTCUT_ACCELERATOR} 注册失败（可能被其他应用占用）`
      )
    }
    return ok
  } catch (error) {
    console.warn('[shortcut] 注册异常:', error)
    return false
  }
}

export function unregisterGlobalShortcut(): void {
  globalShortcut.unregister(GLOBAL_SHORTCUT_ACCELERATOR)
}

export function isGlobalShortcutRegistered(): boolean {
  return globalShortcut.isRegistered(GLOBAL_SHORTCUT_ACCELERATOR)
}

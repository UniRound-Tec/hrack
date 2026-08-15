import { globalShortcut, type BrowserWindow } from 'electron'
import { toggleWindowVisibility } from './tray'

interface ShortcutBackend {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
  isRegistered(accelerator: string): boolean
}

const electronShortcutBackend: ShortcutBackend = {
  register: (accelerator, callback) =>
    globalShortcut.register(accelerator, callback),
  unregister: (accelerator) => globalShortcut.unregister(accelerator),
  isRegistered: (accelerator) => globalShortcut.isRegistered(accelerator)
}

function createMemoryShortcutBackend(): ShortcutBackend {
  const registered = new Set<string>()
  return {
    register: (accelerator) => {
      registered.add(accelerator)
      return true
    },
    unregister: (accelerator) => registered.delete(accelerator),
    isRegistered: (accelerator) => registered.has(accelerator)
  }
}

// OS-wide accelerators are shared mutable state and may already be occupied on
// a developer/CI host. The default E2E gate verifies our registration lifecycle
// against an in-memory backend; opt into the real OS smoke explicitly.
const shortcutBackend =
  process.env['HRACK_E2E'] === '1' &&
  process.env['HRACK_E2E_REAL_GLOBAL_SHORTCUT'] !== '1'
    ? createMemoryShortcutBackend()
    : electronShortcutBackend

/**
 * 全局快捷键 `Ctrl+Alt+V`（固定键位，无录制 UI）。
 * 语义 = quake 风格：窗口可见且聚焦 → 隐藏；否则显示并聚焦（最小化先 restore）。
 * 注册失败（被其他应用占用）只记日志，不弹窗；设置开关重开时重试。
 */
export const GLOBAL_SHORTCUT_ACCELERATOR = 'Control+Alt+V'

export function registerGlobalShortcut(win: BrowserWindow): boolean {
  try {
    const ok = shortcutBackend.register(GLOBAL_SHORTCUT_ACCELERATOR, () =>
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
  shortcutBackend.unregister(GLOBAL_SHORTCUT_ACCELERATOR)
}

export function isGlobalShortcutRegistered(): boolean {
  return shortcutBackend.isRegistered(GLOBAL_SHORTCUT_ACCELERATOR)
}

import { BrowserWindow, Menu, Tray, nativeTheme } from 'electron'
import { createThemedHrackIcon } from './app-icons'

export type { Tray } from 'electron'

/**
 * 系统托盘（macOS 为菜单栏状态项）。菜单三项：显示/隐藏、新建会话、退出。
 * 左键单击图标切换窗口显示（macOS 点击弹菜单，行为交给系统）。
 * 文案是原生 UI，主进程内嵌五语言小字典，语言随主进程偏好文件同步。
 */
export interface TrayCallbacks {
  toggleWindow(): void
  showWindow(): void
  openNewSession(): void
  quit(): void
}

const TRAY_LABELS: Record<string, { toggle: string; newSession: string; quit: string }> = {
  'zh-CN': { toggle: '显示 / 隐藏', newSession: '新建会话', quit: '退出' },
  'zh-TW': { toggle: '顯示 / 隱藏', newSession: '新增工作階段', quit: '結束' },
  en: { toggle: 'Show / Hide', newSession: 'New Session', quit: 'Quit' },
  ja: { toggle: '表示 / 非表示', newSession: '新しいセッション', quit: '終了' },
  ko: { toggle: '표시 / 숨기기', newSession: '새 세션', quit: '종료' }
}

let activeTray: Tray | null = null
let activeMenu: Menu | null = null

nativeTheme.on('updated', () => {
  if (process.platform !== 'darwin' && activeTray && !activeTray.isDestroyed()) {
    activeTray.setImage(createThemedHrackIcon())
  }
})

export function rebuildTrayMenu(
  tray: Tray,
  language: string,
  callbacks: TrayCallbacks
): void {
  const labels = TRAY_LABELS[language] ?? TRAY_LABELS.en
  const menu = Menu.buildFromTemplate([
    {
      label: labels.toggle,
      click: () => callbacks.toggleWindow()
    },
    {
      label: labels.newSession,
      click: () => callbacks.openNewSession()
    },
    { type: 'separator' },
    {
      label: labels.quit,
      click: () => callbacks.quit()
    }
  ])
  tray.setContextMenu(menu)
  activeTray = tray
  activeMenu = menu
}

/** E2E：直接触发托盘菜单项 click 回调（托盘原生 UI 无法从测试注入点击）。 */
export function clickTrayMenuItem(index: number): boolean {
  const item = activeMenu?.items[index]
  if (!item) {
    console.warn('[tray] clickTrayMenuItem: no item', { index, activeMenu: Boolean(activeMenu) })
    return false
  }
  item.click(undefined as never, undefined as never, {})
  return true
}

export function getTrayInstance(): Tray | null {
  return activeTray
}

export function trayMenuState(): {
  hasTray: boolean
  hasMenu: boolean
  labels: string[]
} {
  return {
    hasTray: Boolean(activeTray),
    hasMenu: Boolean(activeMenu),
    labels: activeMenu?.items.map((item) => item.label) ?? []
  }
}

export function createTray(
  language: string,
  callbacks: TrayCallbacks
): Tray {
  const tray = new Tray(createThemedHrackIcon())
  tray.setToolTip('HRack')
  rebuildTrayMenu(tray, language, callbacks)
  // Windows/Linux：单击图标切换显示；macOS 点击交给系统弹出菜单。
  if (process.platform !== 'darwin') {
    tray.on('click', () => callbacks.toggleWindow())
  }
  tray.on('double-click', () => callbacks.showWindow())
  return tray
}

/** 供 E2E 断言：当前窗口隐藏态切换语义（quake 风格）。 */
export function toggleWindowVisibility(win: BrowserWindow): void {
  if (win.isVisible() && win.isFocused()) {
    win.hide()
  } else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

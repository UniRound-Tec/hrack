import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 主进程偏好文件 `<userData>/main-prefs.json`。
 * 主进程唯一读写方：建窗首帧底色、全局快捷键开关、托盘菜单语言。
 * renderer 通过 `app:set-main-prefs` 上报更新；本模块即时生效。
 */

export interface MainPrefs {
  /** 最近一次活动界面主题的 bg.app 色值；建窗前用作 BrowserWindow.backgroundColor。 */
  backgroundColor: string
  uiThemeId: string
  globalShortcutEnabled: boolean
  /** 托盘菜单文案语言（AppLocale）。 */
  language: string
  /** 独立置顶悬浮窗由主进程建窗，偏好也由主进程持久化。 */
  floatingWindowEnabled: boolean
  floatingWindowPosition: {
    x: number
    y: number
    displayId: number
  } | null
}

export const DEFAULT_BACKGROUND_COLOR = '#ffffff'
export const DEFAULT_LANGUAGE = 'zh-CN'

export const defaultMainPrefs: MainPrefs = {
  backgroundColor: DEFAULT_BACKGROUND_COLOR,
  uiThemeId: 'light',
  globalShortcutEnabled: true,
  language: DEFAULT_LANGUAGE,
  floatingWindowEnabled: false,
  floatingWindowPosition: null
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value.trim())
}

function sanitize(parsed: unknown): MainPrefs {
  const raw =
    parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  const prefs = { ...defaultMainPrefs }
  if (isHexColor(raw.backgroundColor)) {
    prefs.backgroundColor = (raw.backgroundColor as string).trim()
  }
  if (typeof raw.globalShortcutEnabled === 'boolean') {
    prefs.globalShortcutEnabled = raw.globalShortcutEnabled
  }
  if (
    typeof raw.language === 'string' &&
    raw.language.length > 0 &&
    raw.language.length <= 16
  ) {
    prefs.language = raw.language
  }
  if (
    typeof raw.uiThemeId === 'string' &&
    raw.uiThemeId.trim().length > 0 &&
    raw.uiThemeId.trim().length <= 128
  ) {
    prefs.uiThemeId = raw.uiThemeId.trim()
  }
  if (typeof raw.floatingWindowEnabled === 'boolean') {
    prefs.floatingWindowEnabled = raw.floatingWindowEnabled
  }
  if (
    raw.floatingWindowPosition &&
    typeof raw.floatingWindowPosition === 'object'
  ) {
    const position = raw.floatingWindowPosition as Record<string, unknown>
    if (
      typeof position.x === 'number' &&
      Number.isFinite(position.x) &&
      typeof position.y === 'number' &&
      Number.isFinite(position.y) &&
      typeof position.displayId === 'number' &&
      Number.isFinite(position.displayId)
    ) {
      prefs.floatingWindowPosition = {
        x: Math.round(position.x),
        y: Math.round(position.y),
        displayId: Math.round(position.displayId)
      }
    }
  }
  return prefs
}

let cachedPrefs: MainPrefs = { ...defaultMainPrefs }

function prefsPath(): string {
  return join(app.getPath('userData'), 'main-prefs.json')
}

/** 启动时读一次；缺失 / 手工改坏的文件逐字段回退默认值，不崩溃。 */
export async function loadMainPrefs(): Promise<MainPrefs> {
  try {
    cachedPrefs = sanitize(
      JSON.parse(await readFile(prefsPath(), 'utf8'))
    )
  } catch {
    cachedPrefs = { ...defaultMainPrefs }
  }
  return { ...cachedPrefs }
}

export function getMainPrefs(): MainPrefs {
  return { ...cachedPrefs }
}

/** 原子落盘（临时文件 + rename），失败只记日志，不阻断调用方。 */
export async function persistMainPrefs(
  patch: Partial<MainPrefs>
): Promise<MainPrefs> {
  const merged = { ...cachedPrefs, ...patch }
  cachedPrefs = merged
  try {
    const path = prefsPath()
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.tmp`
    await writeFile(temp, JSON.stringify(merged, null, 2), 'utf8')
    await rename(temp, path)
  } catch (error) {
    console.error('[main-prefs] 落盘失败:', error)
  }
  return { ...merged }
}

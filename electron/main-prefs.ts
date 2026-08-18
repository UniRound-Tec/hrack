import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  DshHomeMode,
  DshRetentionPolicy,
  DshRuntimePreference
} from '../shared/dsh-ipc'
import {
  BUILTIN_FLOATING_RENDERER_ID,
  type FloatingAppearance
} from '../shared/floating-window'
import {
  UI_COLOR_TOKENS,
  isCssColorLiteral,
  type UiColorToken
} from '../shared/theme-schema'

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
  floatingRendererId: string
  floatingAttentionEffectEnabled: boolean
  floatingWindowScale: number
  /** Last resolved main-window theme, replayed before the renderer is ready. */
  floatingAppearance: FloatingAppearance
  floatingWindowPosition: {
    x: number
    y: number
    displayId: number
  } | null
  dshHomeMode: DshHomeMode
  dshRetention: DshRetentionPolicy
  dshRuntimePreference: DshRuntimePreference
}

export const DEFAULT_BACKGROUND_COLOR = '#ffffff'
export const DEFAULT_LANGUAGE = 'zh-CN'

export const defaultMainPrefs: MainPrefs = {
  backgroundColor: DEFAULT_BACKGROUND_COLOR,
  uiThemeId: 'light',
  globalShortcutEnabled: true,
  language: DEFAULT_LANGUAGE,
  floatingWindowEnabled: false,
  floatingRendererId: BUILTIN_FLOATING_RENDERER_ID,
  floatingAttentionEffectEnabled: true,
  floatingWindowScale: 1,
  floatingAppearance: {
    themeId: 'light',
    themeType: 'light',
    colors: {},
    locale: DEFAULT_LANGUAGE
  },
  floatingWindowPosition: null,
  dshHomeMode: 'shared',
  dshRetention: { kind: 'all' },
  dshRuntimePreference: { kind: 'auto' }
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
    typeof raw.floatingRendererId === 'string' &&
    raw.floatingRendererId.trim().length > 0 &&
    raw.floatingRendererId.trim().length <= 128
  ) {
    prefs.floatingRendererId = raw.floatingRendererId.trim()
  }
  if (typeof raw.floatingAttentionEffectEnabled === 'boolean') {
    prefs.floatingAttentionEffectEnabled = raw.floatingAttentionEffectEnabled
  }
  if (typeof raw.floatingWindowScale === 'number' && Number.isFinite(raw.floatingWindowScale)) {
    prefs.floatingWindowScale = Math.max(0.6, Math.min(1.6, raw.floatingWindowScale))
  }
  prefs.floatingAppearance = sanitizeFloatingAppearance(raw.floatingAppearance)
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
  if (raw.dshHomeMode === 'isolated' || raw.dshHomeMode === 'shared') {
    prefs.dshHomeMode = raw.dshHomeMode
  }
  prefs.dshRetention = sanitizeRetention(raw.dshRetention)
  prefs.dshRuntimePreference = sanitizeDshRuntimePreference(
    raw.dshRuntimePreference
  )
  return prefs
}

export function sanitizeFloatingAppearance(value: unknown): FloatingAppearance {
  if (!value || typeof value !== 'object') {
    return { ...defaultMainPrefs.floatingAppearance }
  }
  const raw = value as Record<string, unknown>
  const colors: Partial<Record<UiColorToken, string>> = {}
  if (raw.colors && typeof raw.colors === 'object' && !Array.isArray(raw.colors)) {
    const source = raw.colors as Record<string, unknown>
    for (const token of UI_COLOR_TOKENS) {
      const color = source[token]
      if (isCssColorLiteral(color)) colors[token] = color.trim()
    }
  }
  return {
    themeId:
      typeof raw.themeId === 'string' && raw.themeId.trim().length <= 128
        ? raw.themeId.trim() || 'light'
        : 'light',
    themeType: raw.themeType === 'dark' ? 'dark' : 'light',
    colors,
    locale:
      typeof raw.locale === 'string' && raw.locale.length > 0 && raw.locale.length <= 16
        ? raw.locale
        : DEFAULT_LANGUAGE
  }
}

function sanitizeDshRuntimePreference(value: unknown): DshRuntimePreference {
  if (!value || typeof value !== 'object') return { kind: 'auto' }
  const raw = value as { kind?: unknown; installationId?: unknown }
  if (raw.kind === 'bundled') return { kind: 'bundled' }
  if (
    raw.kind === 'installation' &&
    typeof raw.installationId === 'string' &&
    raw.installationId.length > 0 &&
    raw.installationId.length <= 4_096
  ) {
    return { kind: 'installation', installationId: raw.installationId }
  }
  return { kind: 'auto' }
}

function sanitizeRetention(value: unknown): DshRetentionPolicy {
  if (!value || typeof value !== 'object') return { kind: 'all' }
  const raw = value as { kind?: unknown; days?: unknown; count?: unknown }
  if (raw.kind === 'days') {
    const days =
      typeof raw.days === 'number' && Number.isFinite(raw.days)
        ? Math.max(1, Math.min(3650, Math.round(raw.days)))
        : 30
    return { kind: 'days', days }
  }
  if (raw.kind === 'count') {
    const count =
      typeof raw.count === 'number' && Number.isFinite(raw.count)
        ? Math.max(1, Math.min(5000, Math.round(raw.count)))
        : 50
    return { kind: 'count', count }
  }
  return { kind: 'all' }
}

let cachedPrefs: MainPrefs = { ...defaultMainPrefs }
let persistenceQueue: Promise<void> = Promise.resolve()

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
  // 主题、悬浮窗和 DSH 设置可能在同一帧写入；串行化可同时避免固定
  // .tmp 文件互相 rename，以及较早快照最后落盘覆盖新偏好。
  persistenceQueue = persistenceQueue.then(async () => {
    try {
      const path = prefsPath()
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.tmp`
      await writeFile(temp, JSON.stringify(merged, null, 2), 'utf8')
      await rename(temp, path)
    } catch (error) {
      console.error('[main-prefs] 落盘失败:', error)
    }
  })
  await persistenceQueue
  return { ...merged }
}

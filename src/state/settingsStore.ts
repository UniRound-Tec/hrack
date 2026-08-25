import { create, type StateCreator } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AppLocale } from '../app/i18n'
import { detectLocale } from '../app/i18n/locale'
import { isTerminalThemeId, type ThemeId } from '../terminal/themes'
import { migrateLegacyStorageKey } from './legacyStorage'
import {
  isTerminalBackgroundFit,
  normalizeTerminalBackgroundName,
  normalizeTerminalBackgroundOpacity,
  normalizeTerminalBackgroundRevision,
  type TerminalBackgroundFit
} from '../../shared/terminal-background'
import {
  DEFAULT_NOTIFICATION_SOUND_NAME,
  normalizeNotificationSoundName,
  normalizeNotificationSoundRevision
} from '../../shared/notification-sound'

const LEGACY_DEFAULT_FONT_FAMILY =
  'Consolas, "Cascadia Code", "Courier New", monospace'
const MAPLE_NL_DEFAULT_FONT_FAMILY =
  '"Maple Mono NL", "Cascadia Mono", Consolas, "Courier New", monospace'

export type NavMode = 'sidebar' | 'rail' | 'tabs'

export interface SettingsSnapshot {
  /** 全新安装完成首次引导后置位；旧版本用户迁移时直接视为已完成。 */
  onboardingCompleted: boolean
  uiThemeId: string
  terminalThemeId: ThemeId
  fontFamily: string
  fontSize: number
  ligatures: boolean
  /** 圆角开关：开 = 内容区圆角 + 终端两侧留白；关 = 终端贴边直角。 */
  terminalRounded: boolean
  navMode: NavMode
  floatEnabled: boolean
  defaultTerminal: string
  language: AppLocale
  /** M5.c v5：全局快捷键 Ctrl+Alt+V 开关（默认开）。 */
  globalShortcutEnabled: boolean
  /** M5.d：工作区阅读器占内容区的比例。 */
  readerWidthRatio: number
  /** M5.d：工作区文件树宽度。 */
  workspaceTreeWidth: number
  /** 导航会话是否随最新活动重排；默认关闭以保持稳定位置。 */
  attentionPriorityEnabled: boolean
  /** 官方 DSH Web surface 的独立缩放，不写入 DSH 自身设置。 */
  dshScale: number
  /** 指针移到按钮上时的跟随方框；默认开，与历史行为一致。 */
  targetCursorEnabled: boolean
  /** 终端背景图显示名；空字符串表示未选择。 */
  terminalBackgroundName: string
  /** 背景图版本号，用于刷新自定义协议缓存。 */
  terminalBackgroundRevision: number
  terminalBackgroundFit: TerminalBackgroundFit
  /** 背景图不透明度，0.1–1。 */
  terminalBackgroundOpacity: number
  /** 事件提示音总开关。 */
  notificationSoundEnabled: boolean
  /** 阻塞/需要操作时播放提示音。 */
  notificationSoundOnBlocked: boolean
  /** 完成时播放提示音。 */
  notificationSoundOnCompleted: boolean
  /** 异常时播放提示音。 */
  notificationSoundOnError: boolean
  /** 当前提示音显示名；默认 done.mp3，上传后为用户文件名。 */
  notificationSoundName: string
  /** 当前提示音版本号；0 表示使用打包默认音，>0 表示用户上传音。 */
  notificationSoundRevision: number
  /** 用户选择“忽略”的更新版本；等于该版本时不再弹更新确认框。 */
  ignoredUpdateVersion: string | null
  /** 用户选择“以后不再弹出”后，所有未来版本都不再自动弹出更新确认框。 */
  updateModalDisabled: boolean
  /** 远程房间加入 URL；空字符串表示未填。 */
  remoteJoinUrl: string
}

/** v3 及更早版本的默认字号；v4 起默认 14，迁移时把旧默认值一并带过去。 */
const LEGACY_DEFAULT_FONT_SIZE = 16

export const defaultSettings: SettingsSnapshot = {
  onboardingCompleted: false,
  uiThemeId: 'light',
  terminalThemeId: 'dark',
  fontFamily:
    '"Maple Mono", "Microsoft JhengHei UI", "Microsoft YaHei UI", "PingFang TC", "PingFang SC", "Noto Sans Mono CJK TC", "Noto Sans Mono CJK SC", "Noto Sans CJK TC", "Noto Sans CJK SC", Consolas, monospace',
  fontSize: 14,
  ligatures: true,
  terminalRounded: true,
  navMode: 'sidebar',
  floatEnabled: false,
  defaultTerminal: 'powershell',
  // M5.c 决策 7：首装语言跟随系统；已有用户保留持久化偏好。
  language: detectLocale(),
  globalShortcutEnabled: true,
  readerWidthRatio: 0.52,
  workspaceTreeWidth: 220,
  attentionPriorityEnabled: false,
  dshScale: 0.9,
  targetCursorEnabled: true,
  terminalBackgroundName: '',
  terminalBackgroundRevision: 0,
  terminalBackgroundFit: 'cover',
  terminalBackgroundOpacity: 0.3,
  notificationSoundEnabled: true,
  notificationSoundOnBlocked: true,
  notificationSoundOnCompleted: true,
  notificationSoundOnError: true,
  notificationSoundName: DEFAULT_NOTIFICATION_SOUND_NAME,
  notificationSoundRevision: 0,
  ignoredUpdateVersion: null,
  updateModalDisabled: false,
  remoteJoinUrl: ''
}

/** Terminal consumers only need this stable subset. */
export type TerminalSettings = Pick<
  SettingsSnapshot,
  'terminalThemeId' | 'fontFamily' | 'fontSize' | 'ligatures'
>

/** Kept as an export for M4 callers while P2/P3 move to the full settings model. */
export const defaultTerminalSettings: TerminalSettings = {
  terminalThemeId: defaultSettings.terminalThemeId,
  fontFamily: defaultSettings.fontFamily,
  fontSize: defaultSettings.fontSize,
  ligatures: defaultSettings.ligatures
}

export interface SettingsState extends SettingsSnapshot {
  completeOnboarding(): void
  setUiTheme(uiThemeId: string): void
  setTerminalTheme(terminalThemeId: ThemeId): void
  setFont(fontFamily: string, fontSize: number): void
  setLigatures(ligatures: boolean): void
  setTerminalRounded(terminalRounded: boolean): void
  setNavMode(navMode: NavMode): void
  setFloatEnabled(floatEnabled: boolean): void
  setDefaultTerminal(defaultTerminal: string): void
  setLanguage(language: AppLocale): void
  setGlobalShortcutEnabled(enabled: boolean): void
  setReaderWidthRatio(ratio: number): void
  setWorkspaceTreeWidth(width: number): void
  setAttentionPriorityEnabled(enabled: boolean): void
  setDshScale(scale: number): void
  setTargetCursorEnabled(enabled: boolean): void
  setTerminalBackground(name: string, revision: number): void
  setTerminalBackgroundFit(fit: TerminalBackgroundFit): void
  setTerminalBackgroundOpacity(opacity: number): void
  clearTerminalBackground(): void
  setNotificationSoundEnabled(enabled: boolean): void
  setNotificationSoundOnBlocked(enabled: boolean): void
  setNotificationSoundOnCompleted(enabled: boolean): void
  setNotificationSoundOnError(enabled: boolean): void
  setNotificationSound(name: string, revision: number): void
  clearNotificationSound(): void
  ignoreUpdateVersion(version: string | null): void
  setUpdateModalDisabled(disabled: boolean): void
  setRemoteJoinUrl(url: string): void
  reset(): void
}

type LegacySettings = Partial<SettingsSnapshot> & {
  themeId?: unknown
}

function isNavMode(value: unknown): value is NavMode {
  return value === 'sidebar' || value === 'rail' || value === 'tabs'
}

function isAppLocale(value: unknown): value is AppLocale {
  return (
    value === 'zh-CN' ||
    value === 'zh-TW' ||
    value === 'en' ||
    value === 'ja' ||
    value === 'ko'
  )
}

function normalizeDshScale(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(0.75, Math.min(1.25, value)) * 100) / 100
    : defaultSettings.dshScale
}

/**
 * Zustand persist v0/v1/v2/v3 -> v4 migration.
 *
 * v0/v1 keep the two historical font migrations. v2 splits the single
 * `themeId` preference into independent GUI and terminal theme fields.
 * v4 lowers the default font size 16 -> 14 (users who never left the old
 * default follow it) and adds the rounded-terminal flag.
 * v11 adds the TargetCursor hover-frame toggle (default on).
 * v12 adds terminal background image, fit mode, and opacity.
 * v13 adds configurable notification sound, event toggles, and custom sound info.
 * v14 adds the user-ignored update version for the update confirmation modal.
 * v15 adds a global "don't ask again" switch for update confirmation modals.
 */
export function migrateSettings(
  persistedState: unknown,
  version: number
): SettingsSnapshot {
  const legacy: LegacySettings =
    persistedState && typeof persistedState === 'object'
      ? { ...(persistedState as LegacySettings) }
      : {}

  if (
    version < 1 &&
    legacy.fontFamily === LEGACY_DEFAULT_FONT_FAMILY &&
    legacy.fontSize === 13
  ) {
    legacy.fontFamily = defaultSettings.fontFamily
    legacy.fontSize = defaultSettings.fontSize
    legacy.ligatures = defaultSettings.ligatures
  }

  if (version < 2 && legacy.fontFamily === MAPLE_NL_DEFAULT_FONT_FAMILY) {
    legacy.fontFamily = defaultSettings.fontFamily
    legacy.ligatures = defaultSettings.ligatures
  }

  if (version < 4 && legacy.fontSize === LEGACY_DEFAULT_FONT_SIZE) {
    legacy.fontSize = defaultSettings.fontSize
  }

  const legacyThemeId = isTerminalThemeId(legacy.themeId)
    ? legacy.themeId
    : undefined
  const uiThemeId =
    typeof legacy.uiThemeId === 'string' && legacy.uiThemeId.trim()
      ? legacy.uiThemeId.trim()
      : legacyThemeId ?? defaultSettings.uiThemeId
  const terminalThemeId = isTerminalThemeId(legacy.terminalThemeId)
    ? legacy.terminalThemeId
    : legacyThemeId ?? defaultSettings.terminalThemeId

  return {
    onboardingCompleted:
      typeof legacy.onboardingCompleted === 'boolean'
        ? legacy.onboardingCompleted
        : version < 9,
    uiThemeId,
    terminalThemeId,
    fontFamily:
      typeof legacy.fontFamily === 'string' && legacy.fontFamily.trim()
        ? legacy.fontFamily
        : defaultSettings.fontFamily,
    fontSize:
      typeof legacy.fontSize === 'number' && Number.isFinite(legacy.fontSize)
        ? Math.max(8, Math.min(32, Math.round(legacy.fontSize)))
        : defaultSettings.fontSize,
    ligatures:
      typeof legacy.ligatures === 'boolean'
        ? legacy.ligatures
        : defaultSettings.ligatures,
    terminalRounded:
      typeof legacy.terminalRounded === 'boolean'
        ? legacy.terminalRounded
        : defaultSettings.terminalRounded,
    navMode: isNavMode(legacy.navMode)
      ? legacy.navMode
      : defaultSettings.navMode,
    // M5.b only exposes the disabled placeholder. Never revive an old truthy
    // value before the independent floating window exists.
    floatEnabled: false,
    defaultTerminal:
      typeof legacy.defaultTerminal === 'string' &&
      legacy.defaultTerminal.trim()
        ? legacy.defaultTerminal.trim()
        : defaultSettings.defaultTerminal,
    language: isAppLocale(legacy.language)
      ? legacy.language
      : defaultSettings.language,
    globalShortcutEnabled:
      typeof legacy.globalShortcutEnabled === 'boolean'
        ? legacy.globalShortcutEnabled
        : defaultSettings.globalShortcutEnabled,
    readerWidthRatio:
      typeof legacy.readerWidthRatio === 'number' &&
      Number.isFinite(legacy.readerWidthRatio)
        ? Math.max(0.3, Math.min(0.75, legacy.readerWidthRatio))
        : defaultSettings.readerWidthRatio,
    workspaceTreeWidth:
      typeof legacy.workspaceTreeWidth === 'number' &&
      Number.isFinite(legacy.workspaceTreeWidth)
        ? Math.max(160, Math.min(360, Math.round(legacy.workspaceTreeWidth)))
        : defaultSettings.workspaceTreeWidth,
    attentionPriorityEnabled:
      typeof legacy.attentionPriorityEnabled === 'boolean'
        ? legacy.attentionPriorityEnabled
        : defaultSettings.attentionPriorityEnabled,
    dshScale: normalizeDshScale(legacy.dshScale),
    targetCursorEnabled:
      typeof legacy.targetCursorEnabled === 'boolean'
        ? legacy.targetCursorEnabled
        : defaultSettings.targetCursorEnabled,
    terminalBackgroundName: normalizeTerminalBackgroundName(
      legacy.terminalBackgroundName
    ),
    terminalBackgroundRevision: normalizeTerminalBackgroundRevision(
      legacy.terminalBackgroundRevision
    ),
    terminalBackgroundFit: isTerminalBackgroundFit(legacy.terminalBackgroundFit)
      ? legacy.terminalBackgroundFit
      : defaultSettings.terminalBackgroundFit,
    terminalBackgroundOpacity: normalizeTerminalBackgroundOpacity(
      legacy.terminalBackgroundOpacity
    ),
    notificationSoundEnabled:
      typeof legacy.notificationSoundEnabled === 'boolean'
        ? legacy.notificationSoundEnabled
        : defaultSettings.notificationSoundEnabled,
    notificationSoundOnBlocked:
      typeof legacy.notificationSoundOnBlocked === 'boolean'
        ? legacy.notificationSoundOnBlocked
        : defaultSettings.notificationSoundOnBlocked,
    notificationSoundOnCompleted:
      typeof legacy.notificationSoundOnCompleted === 'boolean'
        ? legacy.notificationSoundOnCompleted
        : defaultSettings.notificationSoundOnCompleted,
    notificationSoundOnError:
      typeof legacy.notificationSoundOnError === 'boolean'
        ? legacy.notificationSoundOnError
        : defaultSettings.notificationSoundOnError,
    notificationSoundName: normalizeNotificationSoundName(
      legacy.notificationSoundName
    ),
    notificationSoundRevision: normalizeNotificationSoundRevision(
      legacy.notificationSoundRevision
    ),
    ignoredUpdateVersion:
      typeof legacy.ignoredUpdateVersion === 'string' &&
      legacy.ignoredUpdateVersion.trim()
        ? legacy.ignoredUpdateVersion.trim()
        : null,
    updateModalDisabled:
      typeof legacy.updateModalDisabled === 'boolean'
        ? legacy.updateModalDisabled
        : false,
    remoteJoinUrl:
      typeof legacy.remoteJoinUrl === 'string'
        ? legacy.remoteJoinUrl.slice(0, 4_096)
        : defaultSettings.remoteJoinUrl
  }
}

/** Backward-compatible name for code/tests written against the M4 store. */
export const migrateTerminalSettings = migrateSettings

export const createSettingsState: StateCreator<SettingsState> = (set) => ({
  ...defaultSettings,
  completeOnboarding: () => set({ onboardingCompleted: true }),
  setUiTheme: (uiThemeId) =>
    set({ uiThemeId: uiThemeId.trim() || defaultSettings.uiThemeId }),
  setTerminalTheme: (terminalThemeId) => set({ terminalThemeId }),
  setFont: (fontFamily, fontSize) =>
    set({
      fontFamily: fontFamily.trim() || defaultSettings.fontFamily,
      fontSize: Math.max(8, Math.min(32, Math.round(fontSize)))
    }),
  setLigatures: (ligatures) => set({ ligatures }),
  setTerminalRounded: (terminalRounded) => set({ terminalRounded }),
  setNavMode: (navMode) => set({ navMode }),
  setFloatEnabled: (floatEnabled) => set({ floatEnabled }),
  setDefaultTerminal: (defaultTerminal) =>
    set({
      defaultTerminal:
        defaultTerminal.trim() || defaultSettings.defaultTerminal
    }),
  setLanguage: (language) => set({ language }),
  setGlobalShortcutEnabled: (globalShortcutEnabled) =>
    set({ globalShortcutEnabled }),
  setReaderWidthRatio: (readerWidthRatio) =>
    set({
      readerWidthRatio: Math.max(0.3, Math.min(0.75, readerWidthRatio))
    }),
  setWorkspaceTreeWidth: (workspaceTreeWidth) =>
    set({
      workspaceTreeWidth: Math.max(
        160,
        Math.min(360, Math.round(workspaceTreeWidth))
      )
    }),
  setAttentionPriorityEnabled: (attentionPriorityEnabled) =>
    set({ attentionPriorityEnabled }),
  setDshScale: (dshScale) => set({ dshScale: normalizeDshScale(dshScale) }),
  setTargetCursorEnabled: (targetCursorEnabled) =>
    set({ targetCursorEnabled }),
  setTerminalBackground: (name, revision) =>
    set({
      terminalBackgroundName: normalizeTerminalBackgroundName(name),
      terminalBackgroundRevision: normalizeTerminalBackgroundRevision(revision)
    }),
  setTerminalBackgroundFit: (terminalBackgroundFit) =>
    set({
      terminalBackgroundFit: isTerminalBackgroundFit(terminalBackgroundFit)
        ? terminalBackgroundFit
        : defaultSettings.terminalBackgroundFit
    }),
  setTerminalBackgroundOpacity: (opacity) =>
    set({
      terminalBackgroundOpacity: normalizeTerminalBackgroundOpacity(opacity)
    }),
  clearTerminalBackground: () =>
    set({
      terminalBackgroundName: '',
      terminalBackgroundRevision: 0
    }),
  setNotificationSoundEnabled: (notificationSoundEnabled) =>
    set({ notificationSoundEnabled }),
  setNotificationSoundOnBlocked: (notificationSoundOnBlocked) =>
    set({ notificationSoundOnBlocked }),
  setNotificationSoundOnCompleted: (notificationSoundOnCompleted) =>
    set({ notificationSoundOnCompleted }),
  setNotificationSoundOnError: (notificationSoundOnError) =>
    set({ notificationSoundOnError }),
  setNotificationSound: (name, revision) =>
    set({
      notificationSoundName: normalizeNotificationSoundName(name),
      notificationSoundRevision: normalizeNotificationSoundRevision(revision)
    }),
  clearNotificationSound: () =>
    set({
      notificationSoundName: DEFAULT_NOTIFICATION_SOUND_NAME,
      notificationSoundRevision: 0
    }),
  ignoreUpdateVersion: (ignoredUpdateVersion) =>
    set({
      ignoredUpdateVersion:
        typeof ignoredUpdateVersion === 'string' && ignoredUpdateVersion.trim()
          ? ignoredUpdateVersion.trim()
          : null
    }),
  setUpdateModalDisabled: (updateModalDisabled) =>
    set({ updateModalDisabled }),
  setRemoteJoinUrl: (remoteJoinUrl) =>
    set({ remoteJoinUrl: remoteJoinUrl.slice(0, 4_096) }),
  reset: () => set(defaultSettings)
})

migrateLegacyStorageKey('hrack-terminal-settings', 'vibing-terminal-settings')

export const useSettingsStore = create<SettingsState>()(
  persist(createSettingsState, {
    name: 'hrack-terminal-settings',
    version: 16,
    migrate: migrateSettings,
    partialize: ({
      onboardingCompleted,
      uiThemeId,
      terminalThemeId,
      fontFamily,
      fontSize,
      ligatures,
      terminalRounded,
      navMode,
      defaultTerminal,
      language,
      globalShortcutEnabled,
      readerWidthRatio,
      workspaceTreeWidth,
      attentionPriorityEnabled,
      dshScale,
      targetCursorEnabled,
      terminalBackgroundName,
      terminalBackgroundRevision,
      terminalBackgroundFit,
      terminalBackgroundOpacity,
      notificationSoundEnabled,
      notificationSoundOnBlocked,
      notificationSoundOnCompleted,
      notificationSoundOnError,
      notificationSoundName,
      notificationSoundRevision,
      ignoredUpdateVersion,
      updateModalDisabled,
      remoteJoinUrl
    }) => ({
      onboardingCompleted,
      uiThemeId,
      terminalThemeId,
      fontFamily,
      fontSize,
      ligatures,
      terminalRounded,
      navMode,
      defaultTerminal,
      language,
      globalShortcutEnabled,
      readerWidthRatio,
      workspaceTreeWidth,
      attentionPriorityEnabled,
      dshScale,
      targetCursorEnabled,
      terminalBackgroundName,
      terminalBackgroundRevision,
      terminalBackgroundFit,
      terminalBackgroundOpacity,
      notificationSoundEnabled,
      notificationSoundOnBlocked,
      notificationSoundOnCompleted,
      notificationSoundOnError,
      notificationSoundName,
      notificationSoundRevision,
      ignoredUpdateVersion,
      updateModalDisabled,
      remoteJoinUrl
    })
  })
)

import { create, type StateCreator } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AppLocale } from '../app/strings'
import type { ThemeId } from '../terminal/themes'

const LEGACY_DEFAULT_FONT_FAMILY =
  'Consolas, "Cascadia Code", "Courier New", monospace'
const MAPLE_NL_DEFAULT_FONT_FAMILY =
  '"Maple Mono NL", "Cascadia Mono", Consolas, "Courier New", monospace'

export type NavMode = 'sidebar' | 'rail' | 'tabs'

export interface SettingsSnapshot {
  uiThemeId: string
  terminalThemeId: ThemeId
  fontFamily: string
  fontSize: number
  ligatures: boolean
  navMode: NavMode
  floatEnabled: boolean
  defaultTerminal: string
  language: AppLocale
}

export const defaultSettings: SettingsSnapshot = {
  uiThemeId: 'light',
  terminalThemeId: 'dark',
  fontFamily:
    '"Maple Mono", "Microsoft JhengHei UI", "Microsoft YaHei UI", "PingFang TC", "PingFang SC", "Noto Sans Mono CJK TC", "Noto Sans Mono CJK SC", "Noto Sans CJK TC", "Noto Sans CJK SC", Consolas, monospace',
  fontSize: 16,
  ligatures: true,
  navMode: 'sidebar',
  floatEnabled: false,
  defaultTerminal: 'powershell',
  language: 'zh-CN'
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
  setUiTheme(uiThemeId: string): void
  setTerminalTheme(terminalThemeId: ThemeId): void
  setFont(fontFamily: string, fontSize: number): void
  setLigatures(ligatures: boolean): void
  setNavMode(navMode: NavMode): void
  setDefaultTerminal(defaultTerminal: string): void
  setLanguage(language: AppLocale): void
  reset(): void
}

type LegacySettings = Partial<SettingsSnapshot> & {
  themeId?: unknown
}

function isThemeId(value: unknown): value is ThemeId {
  return value === 'dark' || value === 'light'
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

/**
 * Zustand persist v0/v1/v2 -> v3 migration.
 *
 * v0/v1 keep the two historical font migrations. v2 then splits the single
 * `themeId` preference into independent GUI and terminal theme fields.
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

  const legacyThemeId = isThemeId(legacy.themeId)
    ? legacy.themeId
    : undefined
  const uiThemeId =
    typeof legacy.uiThemeId === 'string' && legacy.uiThemeId.trim()
      ? legacy.uiThemeId.trim()
      : legacyThemeId ?? defaultSettings.uiThemeId
  const terminalThemeId = isThemeId(legacy.terminalThemeId)
    ? legacy.terminalThemeId
    : legacyThemeId ?? defaultSettings.terminalThemeId

  return {
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
      : defaultSettings.language
  }
}

/** Backward-compatible name for code/tests written against the M4 store. */
export const migrateTerminalSettings = migrateSettings

export const createSettingsState: StateCreator<SettingsState> = (set) => ({
  ...defaultSettings,
  setUiTheme: (uiThemeId) =>
    set({ uiThemeId: uiThemeId.trim() || defaultSettings.uiThemeId }),
  setTerminalTheme: (terminalThemeId) => set({ terminalThemeId }),
  setFont: (fontFamily, fontSize) =>
    set({
      fontFamily: fontFamily.trim() || defaultSettings.fontFamily,
      fontSize: Math.max(8, Math.min(32, Math.round(fontSize)))
    }),
  setLigatures: (ligatures) => set({ ligatures }),
  setNavMode: (navMode) => set({ navMode }),
  setDefaultTerminal: (defaultTerminal) =>
    set({
      defaultTerminal:
        defaultTerminal.trim() || defaultSettings.defaultTerminal
    }),
  setLanguage: (language) => set({ language }),
  reset: () => set(defaultSettings)
})

export const useSettingsStore = create<SettingsState>()(
  persist(createSettingsState, {
    name: 'vibing-terminal-settings',
    version: 3,
    migrate: migrateSettings,
    partialize: ({
      uiThemeId,
      terminalThemeId,
      fontFamily,
      fontSize,
      ligatures,
      navMode,
      floatEnabled,
      defaultTerminal,
      language
    }) => ({
      uiThemeId,
      terminalThemeId,
      fontFamily,
      fontSize,
      ligatures,
      navMode,
      floatEnabled,
      defaultTerminal,
      language
    })
  })
)

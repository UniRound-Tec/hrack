import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ThemeId } from '../terminal/themes'

const LEGACY_DEFAULT_FONT_FAMILY =
  'Consolas, "Cascadia Code", "Courier New", monospace'
const MAPLE_NL_DEFAULT_FONT_FAMILY =
  '"Maple Mono NL", "Cascadia Mono", Consolas, "Courier New", monospace'

export const defaultTerminalSettings = {
  themeId: 'dark' as ThemeId,
  fontFamily:
    '"Maple Mono", "Microsoft JhengHei UI", "Microsoft YaHei UI", "PingFang TC", "PingFang SC", "Noto Sans Mono CJK TC", "Noto Sans Mono CJK SC", "Noto Sans CJK TC", "Noto Sans CJK SC", Consolas, monospace',
  fontSize: 16,
  ligatures: true
}

export interface TerminalSettings {
  themeId: ThemeId
  fontFamily: string
  fontSize: number
  ligatures: boolean
}

interface SettingsState extends TerminalSettings {
  setTheme(themeId: ThemeId): void
  setFont(fontFamily: string, fontSize: number): void
  setLigatures(ligatures: boolean): void
  reset(): void
}

export function migrateTerminalSettings(
  persistedState: unknown,
  version: number
): unknown {
  if (!persistedState || typeof persistedState !== 'object' || version >= 2) {
    return persistedState
  }
  const settings = { ...(persistedState as Partial<TerminalSettings>) }

  if (
    version < 1 &&
    settings.fontFamily === LEGACY_DEFAULT_FONT_FAMILY &&
    settings.fontSize === 13
  ) {
    settings.fontFamily = defaultTerminalSettings.fontFamily
    settings.fontSize = defaultTerminalSettings.fontSize
    settings.ligatures = defaultTerminalSettings.ligatures
  }

  if (version < 2 && settings.fontFamily === MAPLE_NL_DEFAULT_FONT_FAMILY) {
    settings.fontFamily = defaultTerminalSettings.fontFamily
    settings.ligatures = defaultTerminalSettings.ligatures
  }

  return settings
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaultTerminalSettings,
      setTheme: (themeId) => set({ themeId }),
      setFont: (fontFamily, fontSize) =>
        set({
          fontFamily: fontFamily.trim() || defaultTerminalSettings.fontFamily,
          fontSize: Math.max(8, Math.min(32, Math.round(fontSize)))
        }),
      setLigatures: (ligatures) => set({ ligatures }),
      reset: () => set(defaultTerminalSettings)
    }),
    {
      name: 'vibing-terminal-settings',
      version: 2,
      migrate: migrateTerminalSettings,
      partialize: ({ themeId, fontFamily, fontSize, ligatures }) => ({
        themeId,
        fontFamily,
        fontSize,
        ligatures
      })
    }
  )
)

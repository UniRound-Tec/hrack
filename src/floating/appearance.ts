import type { FloatingAppearance } from '../../shared/floating-window'
import {
  isCssColorLiteral,
  uiTokenToCssVariable,
  type UiColorToken
} from '../../shared/theme-schema'
import { appLocales, type AppLocale } from '../app/i18n'
import { useSettingsStore } from '../state/settingsStore'

/** Apply the host-provided theme without exposing the main theme filesystem API. */
export function applyFloatingAppearance(
  appearance: FloatingAppearance
): void {
  const root = document.documentElement
  root.dataset.uiTheme = appearance.themeId
  root.dataset.uiThemeType = appearance.themeType
  root.style.colorScheme = appearance.themeType
  root.lang = appearance.locale
  for (const [token, color] of Object.entries(appearance.colors)) {
    if (!isCssColorLiteral(color)) continue
    root.style.setProperty(
      uiTokenToCssVariable(token as UiColorToken),
      color
    )
  }
  if (appLocales.includes(appearance.locale as AppLocale)) {
    useSettingsStore.getState().setLanguage(appearance.locale as AppLocale)
  }
}

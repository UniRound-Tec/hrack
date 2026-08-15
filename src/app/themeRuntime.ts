import lightThemeJson from '../themes/light.json'
import darkThemeJson from '../themes/dark.json'
import catppuccinMochaThemeJson from '../themes/catppuccin-mocha.json'
import catppuccinLatteThemeJson from '../themes/catppuccin-latte.json'
import gruvboxDarkThemeJson from '../themes/gruvbox-dark.json'
import gruvboxLightThemeJson from '../themes/gruvbox-light.json'
import draculaThemeJson from '../themes/dracula.json'
import nordThemeJson from '../themes/nord.json'
import rosePineDawnThemeJson from '../themes/rose-pine-dawn.json'
import solarizedLightThemeJson from '../themes/solarized-light.json'
import { create } from 'zustand'
import {
  UI_COLOR_TOKENS,
  isCssColorLiteral,
  resolveUiTheme,
  uiTokenToCssVariable,
  validateUiTheme,
  type ResolvedUiTheme,
  type UiColorToken,
  type UiThemeType,
  type UserThemeFile
} from '../../shared/theme-schema'

export interface UiThemeLoadError {
  filename: string
  message: string
}

export interface UiThemeRegistry {
  themes: readonly ResolvedUiTheme[]
  errors: readonly UiThemeLoadError[]
  get(themeId: string): ResolvedUiTheme | undefined
}

let activeUiThemeRegistry: UiThemeRegistry | null = null

/** 注册表版本号：热重载后自增，设置页等 UI 订阅它以触发重渲染。 */
export const useThemeRegistryVersion = create<{ version: number }>(() => ({
  version: 0
}))

function bumpThemeRegistryVersion(): void {
  useThemeRegistryVersion.setState((state) => ({ version: state.version + 1 }))
}

export function setUiThemeRegistry(registry: UiThemeRegistry): void {
  activeUiThemeRegistry = registry
  bumpThemeRegistryVersion()
}

export function getUiThemeRegistry(): UiThemeRegistry {
  return activeUiThemeRegistry ?? buildUiThemeRegistry([])
}

function emergencyColor(token: UiColorToken): string {
  if (
    token === 'text.inverse' ||
    token === 'button.primary.fg' ||
    token === 'titlebar.close.fg.hover'
  ) {
    return '#ffffff'
  }
  if (token === 'titlebar.close.bg.hover') return '#c42b1c'
  if (
    token === 'button.primary.bg' ||
    token === 'button.primary.bg.hover'
  ) {
    return '#171717'
  }
  if (token === 'accent.spark') return '#1a1a1a'
  if (token === 'accent.cursor' || token === 'accent.target') return '#b497cf'
  // 环境渐变缺失时直接隐形，比给一个错误的彩色安全
  if (token.startsWith('sidebar.tint')) return 'rgb(0 0 0 / 0%)'
  if (token.startsWith('brand.')) return '#7a7a7a'
  if (token.startsWith('bg.backdrop')) return 'rgb(0 0 0 / 25%)'
  if (token.startsWith('bg.')) return '#ffffff'
  if (token.startsWith('border.')) return '#d4d4d4'
  if (token.startsWith('shadow.')) return 'rgb(0 0 0 / 20%)'
  if (token.startsWith('scrollbar.')) return 'rgb(0 0 0 / 20%)'
  if (token.endsWith('.fg') || token.startsWith('text.')) return '#171717'
  if (token.startsWith('button.') || token.startsWith('input.')) {
    return '#f5f5f5'
  }
  if (token.startsWith('titlebar.fg')) return '#525252'
  return '#ff4500'
}

function emergencyLightTheme(value: unknown): ResolvedUiTheme {
  const rawColors =
    typeof value === 'object' && value !== null && 'colors' in value
      ? (value as { colors?: unknown }).colors
      : undefined
  const sourceColors =
    typeof rawColors === 'object' && rawColors !== null
      ? (rawColors as Record<string, unknown>)
      : {}
  const colors = {} as Record<UiColorToken, string>
  for (const token of UI_COLOR_TOKENS) {
    const candidate = sourceColors[token]
    colors[token] = isCssColorLiteral(candidate)
      ? candidate.trim()
      : emergencyColor(token)
  }
  return {
    id: 'light',
    name: 'HRack Light (safe mode)',
    type: 'light',
    colors,
    terminal: null
  }
}

export function loadBuiltInTheme(value: unknown): ResolvedUiTheme {
  const validation = validateUiTheme(value)
  if (!validation.ok) {
    console.error(
      `[theme] 内置主题无效，使用安全浅色回退：${validation.errors.join('；')}`
    )
    return emergencyLightTheme(value)
  }
  const resolved = resolveUiTheme(validation.theme)
  if (!resolved) {
    console.error(
      `[theme] 内置主题 ${validation.theme.id} 缺少颜色 token，使用安全浅色回退`
    )
    return emergencyLightTheme(value)
  }
  return resolved
}

export const builtInLightTheme = loadBuiltInTheme(lightThemeJson)
export const builtInDarkTheme = loadBuiltInTheme(darkThemeJson)
const builtInThemes = [
  builtInLightTheme,
  builtInDarkTheme,
  loadBuiltInTheme(catppuccinMochaThemeJson),
  loadBuiltInTheme(draculaThemeJson),
  loadBuiltInTheme(gruvboxDarkThemeJson),
  loadBuiltInTheme(nordThemeJson),
  loadBuiltInTheme(catppuccinLatteThemeJson),
  loadBuiltInTheme(solarizedLightThemeJson),
  loadBuiltInTheme(rosePineDawnThemeJson),
  loadBuiltInTheme(gruvboxLightThemeJson)
] as const

export function applyUiTheme(theme: ResolvedUiTheme): void {
  const root = document.documentElement
  root.dataset.uiTheme = theme.id
  root.dataset.uiThemeType = theme.type
  root.style.colorScheme = theme.type
  for (const [token, color] of Object.entries(theme.colors)) {
    root.style.setProperty(
      uiTokenToCssVariable(token as keyof typeof theme.colors),
      color
    )
  }
}

export function buildUiThemeRegistry(
  userFiles: readonly UserThemeFile[]
): UiThemeRegistry {
  const themes = new Map<string, ResolvedUiTheme>(
    builtInThemes.map((theme) => [theme.id, theme])
  )
  const fallbackByType = new Map<UiThemeType, ResolvedUiTheme>([
    ['light', builtInLightTheme],
    ['dark', builtInDarkTheme]
  ])
  const errors: UiThemeLoadError[] = []

  for (const file of userFiles) {
    if (typeof file.error === 'string') {
      errors.push({ filename: file.filename, message: file.error })
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(file.source)
    } catch {
      errors.push({ filename: file.filename, message: 'JSON 解析失败' })
      continue
    }

    const validation = validateUiTheme(value)
    if (!validation.ok) {
      errors.push({
        filename: file.filename,
        message: validation.errors.join('；')
      })
      continue
    }
    if (themes.has(validation.theme.id)) {
      errors.push({
        filename: file.filename,
        message: `主题 id 冲突：${validation.theme.id}`
      })
      continue
    }

    const resolved = resolveUiTheme(
      validation.theme,
      fallbackByType.get(validation.theme.type)
    )
    if (!resolved) {
      errors.push({
        filename: file.filename,
        message: `主题缺少颜色 token，且没有 ${validation.theme.type} 内置主题可回退`
      })
      continue
    }
    themes.set(resolved.id, resolved)
  }

  return {
    themes: [...themes.values()],
    errors,
    get: (themeId) => themes.get(themeId)
  }
}

export async function loadUiThemeRegistry(): Promise<UiThemeRegistry> {
  try {
    return buildUiThemeRegistry(await window.themeApi.listUser())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const registry = buildUiThemeRegistry([])
    return {
      ...registry,
      errors: [{ filename: '<userData>/themes', message }]
    }
  }
}

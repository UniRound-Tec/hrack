/**
 * Renderer GUI theme contract shared by built-in and user themes.
 *
 * Components consume semantic tokens only. A user theme may omit tokens; the
 * renderer fills them from the built-in theme with the same `type`.
 */
export const UI_COLOR_TOKENS = [
  'bg.app',
  'bg.content',
  'bg.surface',
  'bg.surface.hover',
  'bg.surface.strong',
  'bg.control',
  'bg.control.active',
  'bg.overlay',
  'bg.backdrop',
  'bg.backdrop.strong',
  'text.primary',
  'text.secondary',
  'text.strong',
  'text.muted',
  'text.faint',
  'text.disabled',
  'text.inverse',
  'border.default',
  'border.subtle',
  'border.faint',
  'border.strong',
  'border.control',
  'accent.flame',
  'accent.cursor',
  'accent.spark',
  'accent.target',
  'brand.logo',
  'brand.logoShine',
  'brand.logoMuted',
  'status.working',
  'status.working.dot',
  'status.needsYou',
  'status.needsYou.dot',
  'status.done',
  'status.done.dot',
  'status.error',
  'status.error.dot',
  'status.idle',
  'status.idle.dot',
  'status.exited',
  'status.exited.dot',
  'titlebar.fg',
  'titlebar.fg.hover',
  'titlebar.bg.hover',
  'titlebar.close.bg.hover',
  'titlebar.close.fg.hover',
  'scrollbar.thumb',
  'scrollbar.thumb.hover',
  'scrollbar.thumb.active',
  'sidebar.tint.a',
  'sidebar.tint.b',
  'shadow.window',
  'shadow.popover',
  'button.primary.bg',
  'button.primary.bg.hover',
  'button.primary.fg',
  'button.secondary.bg',
  'button.secondary.bg.hover',
  'button.secondary.fg',
  'input.bg',
  'input.bg.hover',
  'input.border.focus',
  'focus.ring'
] as const

export type UiColorToken = (typeof UI_COLOR_TOKENS)[number]
export type UiThemeType = 'light' | 'dark'

export const CUSTOM_UI_THEME_ID = 'custom'
export const CUSTOM_UI_THEME_FILENAME = 'custom.json'

export interface UiThemeSource {
  id: string
  name: string
  type: UiThemeType
  colors: Partial<Record<UiColorToken, string>>
  /** Reserved for the future convergence with the xterm 16-colour palette. */
  terminal: null | Record<string, unknown>
}

export interface ResolvedUiTheme extends Omit<UiThemeSource, 'colors'> {
  colors: Record<UiColorToken, string>
}

/** Raw user theme file transferred across the main/renderer boundary. */
export type UserThemeFile =
  | { filename: string; source: string; error?: never }
  | { filename: string; source?: never; error: string }

export interface ThemeValidationSuccess {
  ok: true
  theme: UiThemeSource
}

export interface ThemeValidationFailure {
  ok: false
  errors: string[]
}

export type ThemeValidationResult =
  | ThemeValidationSuccess
  | ThemeValidationFailure

const TOKEN_SET = new Set<string>(UI_COLOR_TOKENS)
const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const HEX_COLOR_PATTERN =
  /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i
const FUNCTION_COLOR_PATTERN =
  /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^;{}]+\)$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Strictly accept color literals, never `var()`, URLs, or declaration text. */
export function isCssColorLiteral(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const color = value.trim()
  return (
    color === 'transparent' ||
    HEX_COLOR_PATTERN.test(color) ||
    FUNCTION_COLOR_PATTERN.test(color)
  )
}

export function validateUiTheme(value: unknown): ThemeValidationResult {
  const errors: string[] = []
  if (!isRecord(value)) return { ok: false, errors: ['主题根节点必须是对象'] }

  const id = value.id
  const name = value.name
  const type = value.type
  const colorsValue = value.colors

  if (typeof id !== 'string' || !THEME_ID_PATTERN.test(id)) {
    errors.push('id 必须是 1–64 位小写字母、数字、点、下划线或连字符')
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    errors.push('name 必须是非空字符串')
  }
  if (type !== 'light' && type !== 'dark') {
    errors.push('type 必须是 light 或 dark')
  }
  if (!isRecord(colorsValue)) {
    errors.push('colors 必须是对象')
  } else {
    for (const [token, color] of Object.entries(colorsValue)) {
      if (!TOKEN_SET.has(token)) {
        errors.push(`未知颜色 token：${token}`)
      } else if (!isCssColorLiteral(color)) {
        errors.push(`颜色 token ${token} 不是合法的颜色字面量`)
      }
    }
  }
  if (value.terminal !== null && value.terminal !== undefined && !isRecord(value.terminal)) {
    errors.push('terminal 必须是对象或 null')
  }
  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    theme: {
      id: id as string,
      name: (name as string).trim(),
      type: type as UiThemeType,
      colors: { ...(colorsValue as Partial<Record<UiColorToken, string>>) },
      terminal: (value.terminal as null | Record<string, unknown> | undefined) ?? null
    }
  }
}

export function resolveUiTheme(
  source: UiThemeSource,
  fallback?: ResolvedUiTheme
): ResolvedUiTheme | null {
  if (fallback && fallback.type !== source.type) return null
  const colors = {} as Record<UiColorToken, string>
  for (const token of UI_COLOR_TOKENS) {
    const color = source.colors[token] ?? fallback?.colors[token]
    if (!color) return null
    colors[token] = color
  }
  return { ...source, colors }
}

export function uiTokenToCssVariable(token: UiColorToken): string {
  return `--hrack-${token.replaceAll('.', '-')}`
}

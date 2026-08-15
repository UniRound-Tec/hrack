/**
 * 把通过校验的 Vibing 主题解析成官方 DSH ThemeRuntime 接受的 alias。
 * 这里只产生 JSON-safe appearance；真正应用发生在隔离官方页面中。
 */

import type { DshSurfaceAppearance } from '../../shared/dsh-ipc'
import type { ResolvedUiTheme, UiColorToken } from '../../shared/theme-schema'
import type { AppLocale } from '../app/i18n'

const DSW_FROM_VIB: ReadonlyArray<readonly [string, UiColorToken]> = [
  ['--dsw-alias-bg-base', 'bg.app'],
  ['--dsw-alias-bg-layer-1', 'bg.content'],
  ['--dsw-alias-bg-layer-2', 'bg.surface'],
  ['--dsw-alias-bg-layer-3', 'bg.surface.strong'],
  ['--dsw-alias-bg-module-platform', 'bg.content'],
  ['--dsw-alias-bg-overlay', 'bg.overlay'],
  ['--dsw-alias-label-primary', 'text.primary'],
  ['--dsw-alias-label-secondary', 'text.secondary'],
  ['--dsw-alias-label-tertiary', 'text.muted'],
  ['--dsw-alias-label-caption', 'text.muted'],
  ['--dsw-alias-label-primary-dimmed', 'text.strong'],
  ['--dsw-alias-border-l1', 'border.faint'],
  ['--dsw-alias-border-l2', 'border.subtle'],
  ['--dsw-alias-border-l2-darkmode-thin', 'border.subtle'],
  ['--dsw-alias-border-l3', 'border.default'],
  ['--dsw-specific-input-major', 'input.bg'],
  ['--dsw-specific-menu', 'bg.surface'],
  ['--dsw-specific-selector', 'bg.control'],
  ['--dsw-specific-sidebar-fill', 'bg.app'],
  ['--dsw-alias-interactive-bg-hover', 'bg.surface.hover'],
  ['--dsw-alias-interactive-bg-hover-solid', 'bg.surface.hover'],
  ['--dsw-alias-scrollbar-bg-l1', 'scrollbar.thumb'],
  ['--dsw-alias-scrollbar-bg-l2', 'scrollbar.thumb'],
  ['--dsw-alias-scrollbar-hover-l1', 'scrollbar.thumb.hover'],
  ['--dsw-alias-scrollbar-hover-l2', 'scrollbar.thumb.hover']
]

export function createDshSurfaceAppearance(
  theme: ResolvedUiTheme,
  locale: AppLocale,
  scale: number
): DshSurfaceAppearance {
  const tokens: Record<string, string> = {}
  for (const [dsw, token] of DSW_FROM_VIB) {
    tokens[dsw] = theme.colors[token]
  }
  return {
    colorScheme: theme.type,
    locale: locale.startsWith('zh') ? 'zh' : 'en',
    scale,
    backgroundColor: theme.colors['bg.content'],
    tokens
  }
}

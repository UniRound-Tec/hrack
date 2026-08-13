/**
 * 把 vibing 主题色写进官方 `--dsw-*` alias。
 * 官方 design-platform.css 把 alias 挂在 body / body[data-ds-dark-theme]，
 * 必须用 inline 盖掉，否则浅色菜单底会继承深色 caption 字。
 */

import {
  uiTokenToCssVariable,
  type ResolvedUiTheme,
  type UiColorToken
} from '../../shared/theme-schema'

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

export function applyDshThemeBridge(theme: ResolvedUiTheme): void {
  const root = document.documentElement
  const body = document.body
  root.dataset.uiThemeType = theme.type
  root.style.colorScheme = theme.type
  body?.toggleAttribute('data-ds-dark-theme', theme.type === 'dark')
  const targets = [root, body].filter((node): node is HTMLElement => Boolean(node))
  for (const [dsw, token] of DSW_FROM_VIB) {
    const value = theme.colors[token]
    for (const node of targets) node.style.setProperty(dsw, value)
  }
  // 保证 fallback 菜单即使没吃到 --vib-* 也能读到实色。
  root.style.setProperty(uiTokenToCssVariable('bg.surface'), theme.colors['bg.surface'])
  root.style.setProperty(uiTokenToCssVariable('text.primary'), theme.colors['text.primary'])
  root.style.setProperty(uiTokenToCssVariable('text.muted'), theme.colors['text.muted'])
}

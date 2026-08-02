import type { ITheme } from '@xterm/xterm'

export type ThemeId = 'dark' | 'light'

export interface TerminalThemeDefinition {
  id: ThemeId
  terminal: ITheme
}

export const terminalThemes: Record<ThemeId, TerminalThemeDefinition> = {
  dark: {
    id: 'dark',
    terminal: {
      background: '#0b0e14',
      foreground: '#c8d3e0',
      cursor: '#c8d3e0',
      cursorAccent: '#0b0e14',
      selectionBackground: '#3d4f6b',
      black: '#1b1d23',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff'
    }
  },
  light: {
    id: 'light',
    terminal: {
      background: '#f6f8fa',
      foreground: '#24292f',
      cursor: '#24292f',
      cursorAccent: '#f6f8fa',
      selectionBackground: '#b6d7ff',
      black: '#24292f',
      red: '#cf222e',
      green: '#116329',
      yellow: '#4d2d00',
      blue: '#0969da',
      magenta: '#8250df',
      cyan: '#1b7c83',
      white: '#6e7781',
      brightBlack: '#57606a',
      brightRed: '#a40e26',
      brightGreen: '#1a7f37',
      brightYellow: '#633c01',
      brightBlue: '#218bff',
      brightMagenta: '#a475f9',
      brightCyan: '#3192aa',
      brightWhite: '#8c959f'
    }
  }
}

export function getTerminalTheme(themeId: ThemeId): TerminalThemeDefinition {
  return terminalThemes[themeId] ?? terminalThemes.dark
}

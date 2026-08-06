import type { ITheme } from '@xterm/xterm'

export interface TerminalThemeDefinition {
  id: string
  name: string
  type: 'light' | 'dark'
  terminal: ITheme
}

export const terminalThemes = {
  dark: {
    id: 'dark',
    name: 'Vibing Dark',
    type: 'dark',
    terminal: {
      background: '#1f1f1f', foreground: '#c8d3e0', cursor: '#c8d3e0', cursorAccent: '#1f1f1f', selectionBackground: '#3d4f6b',
      black: '#1b1d23', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff'
    }
  },
  light: {
    id: 'light',
    name: 'Vibing Light',
    type: 'light',
    terminal: {
      background: '#f6f8fa', foreground: '#24292f', cursor: '#24292f', cursorAccent: '#f6f8fa', selectionBackground: '#b6d7ff',
      black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f'
    }
  },
  'catppuccin-mocha': {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    type: 'dark',
    terminal: {
      background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e', selectionBackground: '#585b70',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8'
    }
  },
  'gruvbox-dark': {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    type: 'dark',
    terminal: {
      background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828', selectionBackground: '#665c54',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2'
    }
  },
  dracula: {
    id: 'dracula',
    name: 'Dracula',
    type: 'dark',
    terminal: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff'
    }
  },
  nord: {
    id: 'nord',
    name: 'Nord',
    type: 'dark',
    terminal: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#4c566a',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4'
    }
  },
  'catppuccin-latte': {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    type: 'light',
    terminal: {
      background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', cursorAccent: '#eff1f5', selectionBackground: '#acb0be',
      black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d', blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#acb0be',
      brightBlack: '#acb0be', brightRed: '#d20f39', brightGreen: '#40a02b', brightYellow: '#df8e1d', brightBlue: '#1e66f5', brightMagenta: '#ea76cb', brightCyan: '#179299', brightWhite: '#bcc0cc'
    }
  },
  'solarized-light': {
    id: 'solarized-light',
    name: 'Solarized Light',
    type: 'light',
    terminal: {
      background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', cursorAccent: '#fdf6e3', selectionBackground: '#eee8d5',
      black: '#eee8d5', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#073642',
      brightBlack: '#fdf6e3', brightRed: '#cb4b16', brightGreen: '#93a1a1', brightYellow: '#839496', brightBlue: '#657b83', brightMagenta: '#6c71c4', brightCyan: '#586e75', brightWhite: '#002b36'
    }
  },
  'rose-pine-dawn': {
    id: 'rose-pine-dawn',
    name: 'Rosé Pine Dawn',
    type: 'light',
    terminal: {
      background: '#faf4ed', foreground: '#575279', cursor: '#9893a5', cursorAccent: '#faf4ed', selectionBackground: '#dfdad9',
      black: '#f2e9e1', red: '#b4637a', green: '#286983', yellow: '#ea9d34', blue: '#56949f', magenta: '#907aa9', cyan: '#d7827e', white: '#575279',
      brightBlack: '#797593', brightRed: '#b4637a', brightGreen: '#286983', brightYellow: '#ea9d34', brightBlue: '#56949f', brightMagenta: '#907aa9', brightCyan: '#d7827e', brightWhite: '#575279'
    }
  },
  'gruvbox-light': {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    type: 'light',
    terminal: {
      background: '#fbf1c7', foreground: '#3c3836', cursor: '#3c3836', cursorAccent: '#fbf1c7', selectionBackground: '#bdae93',
      black: '#fbf1c7', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#7c6f64',
      brightBlack: '#928374', brightRed: '#9d0006', brightGreen: '#79740e', brightYellow: '#b57614', brightBlue: '#076678', brightMagenta: '#8f3f71', brightCyan: '#427b58', brightWhite: '#3c3836'
    }
  }
} as const satisfies Record<string, TerminalThemeDefinition>

export type ThemeId = keyof typeof terminalThemes

export const terminalThemeIds: readonly ThemeId[] = [
  'dark',
  'light',
  'catppuccin-mocha',
  'dracula',
  'gruvbox-dark',
  'nord',
  'catppuccin-latte',
  'solarized-light',
  'rose-pine-dawn',
  'gruvbox-light'
]

export function isTerminalThemeId(value: unknown): value is ThemeId {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(terminalThemes, value)
  )
}

export function getTerminalTheme(themeId: ThemeId): TerminalThemeDefinition {
  return terminalThemes[themeId] ?? terminalThemes.dark
}

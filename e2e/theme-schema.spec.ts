import { expect, test } from '@playwright/test'
import {
  buildUiThemeRegistry,
  loadBuiltInTheme
} from '../src/app/themeRuntime'
import { UI_COLOR_TOKENS } from '../shared/theme-schema'
import { terminalThemes } from '../src/terminal/themes'

const popularThemeIds = [
  'catppuccin-mocha',
  'dracula',
  'gruvbox-dark',
  'nord',
  'catppuccin-latte',
  'solarized-light',
  'rose-pine-dawn',
  'gruvbox-light'
] as const

const terminalColorKeys = [
  'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite'
] as const

const expectedTerminalColors: Record<(typeof popularThemeIds)[number], readonly string[]> = {
  'catppuccin-mocha': [
    '#1e1e2e', '#cdd6f4', '#f5e0dc', '#1e1e2e', '#585b70',
    '#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de',
    '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'
  ],
  'gruvbox-dark': [
    '#282828', '#ebdbb2', '#ebdbb2', '#282828', '#665c54',
    '#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
    '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'
  ],
  dracula: [
    '#282a36', '#f8f8f2', '#f8f8f2', '#282a36', '#44475a',
    '#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
    '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'
  ],
  nord: [
    '#2e3440', '#d8dee9', '#d8dee9', '#2e3440', '#4c566a',
    '#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
    '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'
  ],
  'catppuccin-latte': [
    '#eff1f5', '#4c4f69', '#dc8a78', '#eff1f5', '#acb0be',
    '#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be',
    '#acb0be', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#bcc0cc'
  ],
  'solarized-light': [
    '#fdf6e3', '#657b83', '#586e75', '#fdf6e3', '#eee8d5',
    '#eee8d5', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#073642',
    '#fdf6e3', '#cb4b16', '#93a1a1', '#839496', '#657b83', '#6c71c4', '#586e75', '#002b36'
  ],
  'rose-pine-dawn': [
    '#faf4ed', '#575279', '#9893a5', '#faf4ed', '#dfdad9',
    '#f2e9e1', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#d7827e', '#575279',
    '#797593', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#d7827e', '#575279'
  ],
  'gruvbox-light': [
    '#fbf1c7', '#3c3836', '#3c3836', '#fbf1c7', '#bdae93',
    '#fbf1c7', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#7c6f64',
    '#928374', '#9d0006', '#79740e', '#b57614', '#076678', '#8f3f71', '#427b58', '#3c3836'
  ]
}

function rgb(color: string, background?: string): [number, number, number] {
  const hex = color.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i)
  if (hex) return [1, 2, 3].map((index) => Number.parseInt(hex[index], 16)) as [number, number, number]
  const alpha = color.match(/^rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)$/)
  if (!alpha || !background) throw new Error(`unsupported test color: ${color}`)
  const backdrop = rgb(background)
  const opacity = Number(alpha[4]) / 100
  return [1, 2, 3].map((index) =>
    Math.round(Number(alpha[index]) * opacity + backdrop[index - 1] * (1 - opacity))
  ) as [number, number, number]
}

function contrast(foreground: string, background: string): number {
  const luminance = (color: [number, number, number]): number => {
    const channels = color.map((channel) => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  }
  const backdrop = rgb(background)
  const light = luminance(rgb(foreground, background))
  const dark = luminance(backdrop)
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05)
}

test('ships each popular palette for both the GUI and terminal', () => {
  const registry = buildUiThemeRegistry([])
  expect(registry.themes.map((theme) => theme.id)).toEqual([
    'light',
    'dark',
    ...popularThemeIds
  ])
  for (const themeId of popularThemeIds) {
    const gui = registry.get(themeId)?.colors
    expect(gui).toBeTruthy()
    expect(contrast(gui!['text.primary'], gui!['bg.content'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(gui!['text.secondary'], gui!['bg.content'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(gui!['status.error'], gui!['bg.content'])).toBeGreaterThanOrEqual(3)
    expect(contrast(gui!['button.primary.fg'], gui!['button.primary.bg'])).toBeGreaterThanOrEqual(4.5)
    expect(terminalThemes[themeId].type).toBe(registry.get(themeId)?.type)
    expect(terminalColorKeys.map((colorKey) => terminalThemes[themeId].terminal[colorKey]))
      .toEqual(expectedTerminalColors[themeId])
  }
})

test('fills omitted user-theme tokens from the built-in theme of the same type', () => {
  const registry = buildUiThemeRegistry([
    {
      filename: 'paper.json',
      source: JSON.stringify({
        id: 'paper',
        name: 'Paper',
        type: 'light',
        colors: { 'accent.flame': '#123456' },
        terminal: null
      })
    }
  ])

  expect(registry.errors).toEqual([])
  expect(registry.get('paper')?.colors).toMatchObject({
    'accent.flame': '#123456',
    'bg.app': '#ededec',
    'text.primary': '#171717'
  })
})

test('rejects invalid colors, unknown tokens, duplicate ids, and fills partial dark themes from the built-in dark theme', () => {
  const registry = buildUiThemeRegistry([
    {
      filename: 'invalid.json',
      source: JSON.stringify({
        id: 'invalid',
        name: 'Invalid',
        type: 'light',
        colors: {
          'bg.app': 'url(https://example.invalid/paint)',
          'unknown.token': '#ffffff'
        }
      })
    },
    {
      filename: 'duplicate.json',
      source: JSON.stringify({
        id: 'light',
        name: 'Duplicate',
        type: 'light',
        colors: {}
      })
    },
    {
      filename: 'partial-dark.json',
      source: JSON.stringify({
        id: 'partial-dark',
        name: 'Partial dark',
        type: 'dark',
        colors: { 'bg.app': '#000000' }
      })
    }
  ])

  expect(registry.themes.map((theme) => theme.id)).toEqual([
    'light',
    'dark',
    ...popularThemeIds,
    'partial-dark'
  ])
  expect(registry.errors).toHaveLength(2)
  expect(registry.errors.map((error) => error.filename)).toEqual([
    'invalid.json',
    'duplicate.json'
  ])
  expect(registry.get('partial-dark')?.colors).toMatchObject({
    'bg.app': '#000000',
    'text.primary': '#f5f5f5'
  })
})

test('reports rejected theme files without mislabeling them as JSON errors', () => {
  const registry = buildUiThemeRegistry([
    {
      filename: 'oversized.json',
      error: '文件大小 300000 字节，超过 256 KB 上限'
    }
  ])

  expect(registry.errors).toEqual([
    {
      filename: 'oversized.json',
      message: '文件大小 300000 字节，超过 256 KB 上限'
    }
  ])
})

test('falls back instead of throwing when the built-in theme is invalid', () => {
  const theme = loadBuiltInTheme({ id: 'broken', colors: {} })

  expect(theme.id).toBe('light')
  expect(Object.keys(theme.colors)).toHaveLength(UI_COLOR_TOKENS.length)
  expect(theme.colors).toMatchObject({
    'button.primary.bg': '#171717',
    'button.primary.fg': '#ffffff'
  })
})

import { expect, test } from '@playwright/test'
import {
  buildUiThemeRegistry,
  loadBuiltInTheme
} from '../src/app/themeRuntime'
import { UI_COLOR_TOKENS } from '../shared/theme-schema'

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
    'bg.app': '#ffffff',
    'text.primary': '#171717'
  })
})

test('rejects invalid colors, unknown tokens, duplicate ids, and incomplete dark themes', () => {
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

  expect(registry.themes.map((theme) => theme.id)).toEqual(['light'])
  expect(registry.errors).toHaveLength(3)
  expect(registry.errors.map((error) => error.filename)).toEqual([
    'invalid.json',
    'duplicate.json',
    'partial-dark.json'
  ])
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

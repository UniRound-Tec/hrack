import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from './helpers'

const customTheme = {
  id: 'custom',
  name: 'Theme Editor Test',
  type: 'dark',
  colors: {
    'bg.app': '#123456',
    'bg.content': '#182838',
    'text.primary': '#f5f7fa',
    'focus.ring': '#78a9ff'
  },
  terminal: null
} as const

test('edits, saves, and applies the custom theme JSON from settings', async () => {
  const { app, window, userDataDir } = await launchApp({
    createDefaultTerminal: false
  })
  try {
    await window.getByTestId('titlebar-settings').click()
    const editor = window.getByTestId('settings-theme-json-input')
    const save = window.getByTestId('settings-theme-json-save')
    await expect(editor).toBeVisible()
    await expect(editor).toHaveValue(/"id": "custom"/)

    await editor.fill('{')
    await save.click()
    await expect(window.getByTestId('settings-theme-json-status')).toContainText(
      /JSON/
    )

    await editor.fill(JSON.stringify({
      ...customTheme,
      id: 'light'
    }, null, 2))
    await save.click()
    await expect(window.getByTestId('settings-theme-json-status')).toContainText(
      /custom/
    )

    await editor.fill(JSON.stringify(customTheme, null, 2))
    await save.click()

    const themePath = join(userDataDir, 'themes', 'custom.json')
    await expect.poll(() => existsSync(themePath), { timeout: 15_000 }).toBe(true)
    expect(JSON.parse(readFileSync(themePath, 'utf8'))).toEqual(customTheme)

    await window.getByTestId('settings-ui-theme').click()
    await window.getByTestId('settings-ui-theme-option-custom').click()
    await expect.poll(
      () => window.evaluate(() => document.documentElement.dataset.uiTheme),
      { timeout: 15_000 }
    ).toBe(customTheme.id)
    await expect.poll(
      () => window.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--hrack-bg-app')
          .trim()
      )
    ).toBe(customTheme.colors['bg.app'])

    const editedTheme = {
      ...customTheme,
      colors: { ...customTheme.colors, 'bg.app': '#654321' }
    }
    await editor.fill(JSON.stringify(editedTheme, null, 2))
    await save.click()
    await expect.poll(
      () => JSON.parse(readFileSync(themePath, 'utf8')).colors['bg.app']
    ).toBe(editedTheme.colors['bg.app'])
    await expect.poll(
      () => window.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--hrack-bg-app')
          .trim()
      )
    ).toBe(editedTheme.colors['bg.app'])
  } finally {
    await app.close().catch(() => {})
  }
})

test('protects the custom theme file and copies the theme creation Skill', async () => {
  const { app, window } = await launchApp({ createDefaultTerminal: false })
  try {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('clipboard:write-text')
      ipcMain.handle('clipboard:write-text', (_event, text: unknown) => {
        ;(globalThis as Record<string, unknown>).__hrackCopiedThemeSkill = text
      })
    })
    await window.getByTestId('titlebar-settings').click()
    const settings = window.getByTestId('settings-page')
    const copy = window.getByTestId('settings-theme-copy-skill')
    await expect(copy).toBeVisible()
    await expect(settings).not.toContainText('name: create-hrack-theme')

    await expect(
      window.evaluate(() => window.themeApi.saveCustom(
        JSON.stringify({
          id: 'other',
          name: 'Other',
          type: 'dark',
          colors: {},
          terminal: null
        })
      ))
    ).rejects.toThrow(/must be custom/)

    await copy.click()
    const copied = await app.evaluate(() => String(
      (globalThis as Record<string, unknown>).__hrackCopiedThemeSkill ?? ''
    ))
    expect(copied).toContain('name: create-hrack-theme')
    expect(copied).toContain('UI_COLOR_TOKENS')
    expect(copied).toContain('Settings -> Appearance -> Theme JSON')
    await expect(copy).toContainText(/已复制|Copied|コピー済み|복사됨|已複製/)
  } finally {
    await app.close().catch(() => {})
  }
})

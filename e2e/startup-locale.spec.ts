import { expect, test, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveLocale } from '../src/app/i18n/locale'
import { launchApp } from './helpers'

async function storedLanguage(window: Page): Promise<string | undefined> {
  return window.evaluate(() => {
    const settings = localStorage.getItem('hrack-terminal-settings')
    return settings ? JSON.parse(settings).state.language : undefined
  })
}

test('keeps the detected locale through startup and theme preference broadcasts', async () => {
  test.skip(process.platform !== 'linux', 'This first-run regression uses the Linux system locale.')
  const { app, window, userDataDir } = await launchApp({
    createDefaultTerminal: false,
    env: { LANG: 'en_US.UTF-8', LANGUAGE: 'en_US:en', LC_ALL: 'en_US.UTF-8' }
  })
  try {
    const languages = await window.evaluate(() =>
      navigator.languages.length ? [...navigator.languages] : [navigator.language]
    )
    const expected = resolveLocale(languages)
    expect(expected).toBe('en')
    const prefsPath = join(userDataDir, 'main-prefs.json')
    await expect.poll(() => storedLanguage(window)).toBe(expected)
    await expect.poll(() => JSON.parse(readFileSync(prefsPath, 'utf8'))).toMatchObject({
      language: expected,
      floatingAppearance: { locale: expected }
    })

    // Theme-only updates broadcast the main-process language back to the renderer.
    await window.evaluate(() => window.appApi.setMainPrefs({ uiThemeId: 'dark' }))
    await expect.poll(() => window.evaluate(() => document.documentElement.dataset.uiTheme)).toBe('dark')
    await expect.poll(() => storedLanguage(window)).toBe(expected)
  } finally {
    await app.close().catch(() => {})
  }
})

test('keeps a persisted renderer locale when main preferences contain an older language', async () => {
  const first = await launchApp({ createDefaultTerminal: false })
  try {
    await first.window.evaluate(() => {
      const key = 'hrack-terminal-settings'
      const settings = JSON.parse(localStorage.getItem(key)!)
      settings.state.language = 'ja'
      localStorage.setItem(key, JSON.stringify(settings))
    })
  } finally {
    await first.app.close().catch(() => {})
  }
  const prefsPath = join(first.userDataDir, 'main-prefs.json')
  const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'))
  writeFileSync(prefsPath, JSON.stringify({ ...prefs, language: 'zh-CN' }))

  const second = await launchApp({
    userDataDir: first.userDataDir,
    createDefaultTerminal: false
  })
  try {
    await expect.poll(() => storedLanguage(second.window)).toBe('ja')
    await expect.poll(() => JSON.parse(readFileSync(prefsPath, 'utf8'))).toMatchObject({
      language: 'ja',
      floatingAppearance: { locale: 'ja' }
    })
    await second.window.evaluate(() => window.appApi.setMainPrefs({ uiThemeId: 'dark' }))
    await expect.poll(() => second.window.evaluate(() => document.documentElement.dataset.uiTheme)).toBe('dark')
    await expect.poll(() => storedLanguage(second.window)).toBe('ja')
  } finally {
    await second.app.close().catch(() => {})
  }
})

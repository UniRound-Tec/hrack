import { expect, test } from '@playwright/test'
import { resolveLocale } from '../src/app/i18n/locale'
import { getStrings } from '../src/app/i18n'

const copied = (locale: string): string =>
  getStrings(resolveLocale([locale])).terminal.copied

test('copy notice supports simplified and traditional Chinese', () => {
  expect(copied('zh-CN')).toBe('已复制')
  expect(copied('zh-Hant')).toBe('已複製')
  expect(copied('zh-HK')).toBe('已複製')
})

test('copy notice supports English, Japanese, and Korean', () => {
  expect(copied('en-US')).toBe('Copied')
  expect(copied('ja-JP')).toBe('コピーしました')
  expect(copied('ko-KR')).toBe('복사됨')
})

test('unsupported locale falls back to English', () => {
  expect(resolveLocale(['fr-FR'])).toBe('en')
  expect(copied('fr-FR')).toBe('Copied')
})

test('tab controls and exited state support all application locales', () => {
  const cases = [
    ['zh-CN', '新建标签页', '关闭标签页', '已退出'],
    ['zh-TW', '新增分頁', '關閉分頁', '已結束'],
    ['en', 'New tab', 'Close tab', 'Exited'],
    ['ja', '新しいタブ', 'タブを閉じる', '終了'],
    ['ko', '새 탭', '탭 닫기', '종료됨']
  ] as const

  for (const [locale, newTab, closeTab, exited] of cases) {
    const strings = getStrings(locale)
    expect(strings.terminal.newTab).toBe(newTab)
    expect(strings.terminal.closeTab).toBe(closeTab)
    expect(strings.terminal.exited).toBe(exited)
  }
})

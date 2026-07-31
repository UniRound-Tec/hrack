import { expect, test } from '@playwright/test'
import { resolveLocale, translate } from '../src/i18n'

test('copy notice supports simplified and traditional Chinese', () => {
  expect(translate(resolveLocale(['zh-CN']), 'copied')).toBe('已复制')
  expect(translate(resolveLocale(['zh-Hant']), 'copied')).toBe('已複製')
  expect(translate(resolveLocale(['zh-HK']), 'copied')).toBe('已複製')
})

test('copy notice supports English, Japanese, and Korean', () => {
  expect(translate(resolveLocale(['en-US']), 'copied')).toBe('Copied')
  expect(translate(resolveLocale(['ja-JP']), 'copied')).toBe('コピーしました')
  expect(translate(resolveLocale(['ko-KR']), 'copied')).toBe('복사됨')
})

test('unsupported locale falls back to English', () => {
  expect(resolveLocale(['fr-FR'])).toBe('en')
  expect(translate(resolveLocale(['fr-FR']), 'copied')).toBe('Copied')
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
    expect(translate(locale, 'newTab')).toBe(newTab)
    expect(translate(locale, 'closeTab')).toBe(closeTab)
    expect(translate(locale, 'exited')).toBe(exited)
  }
})

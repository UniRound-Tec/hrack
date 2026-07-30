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

import type { AppLocale } from './index'

/** 按浏览器语言偏好选语言；未支持的语言统一回退英文。 */
export function resolveLocale(languages: readonly string[]): AppLocale {
  for (const language of languages) {
    const normalized = language.toLowerCase()
    if (normalized.startsWith('zh')) {
      if (
        normalized.includes('hant') ||
        normalized.includes('-tw') ||
        normalized.includes('-hk') ||
        normalized.includes('-mo')
      ) {
        return 'zh-TW'
      }
      return 'zh-CN'
    }
    if (normalized.startsWith('ja')) return 'ja'
    if (normalized.startsWith('ko')) return 'ko'
    if (normalized.startsWith('en')) return 'en'
  }
  return 'en'
}

export function detectLocale(): AppLocale {
  if (typeof navigator === 'undefined') return 'en'
  const languages =
    navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language]
  return resolveLocale(languages)
}

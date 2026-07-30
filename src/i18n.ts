export type AppLocale = 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko'
export type MessageKey = 'copied'

const messages: Record<AppLocale, Record<MessageKey, string>> = {
  'zh-CN': {
    copied: '已复制'
  },
  'zh-TW': {
    copied: '已複製'
  },
  en: {
    copied: 'Copied'
  },
  ja: {
    copied: 'コピーしました'
  },
  ko: {
    copied: '복사됨'
  }
}

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

export function translate(locale: AppLocale, key: MessageKey): string {
  return messages[locale][key]
}

export type AppLocale = 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko'
export type MessageKey = 'copied' | 'newTab' | 'closeTab' | 'exited'

const messages: Record<AppLocale, Record<MessageKey, string>> = {
  'zh-CN': {
    copied: '已复制',
    newTab: '新建标签页',
    closeTab: '关闭标签页',
    exited: '已退出'
  },
  'zh-TW': {
    copied: '已複製',
    newTab: '新增分頁',
    closeTab: '關閉分頁',
    exited: '已結束'
  },
  en: {
    copied: 'Copied',
    newTab: 'New tab',
    closeTab: 'Close tab',
    exited: 'Exited'
  },
  ja: {
    copied: 'コピーしました',
    newTab: '新しいタブ',
    closeTab: 'タブを閉じる',
    exited: '終了'
  },
  ko: {
    copied: '복사됨',
    newTab: '새 탭',
    closeTab: '탭 닫기',
    exited: '종료됨'
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

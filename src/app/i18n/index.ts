import { zhCN, type AppStrings } from './zh-CN'
import { zhTW } from './zh-TW'
import { en } from './en'
import { ja } from './ja'
import { ko } from './ko'
import { useSettingsStore } from '../../state/settingsStore'

export const appLocales = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const
export type AppLocale = (typeof appLocales)[number]

export type { AppStrings }

const dictionaries: Record<AppLocale, AppStrings> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en,
  ja,
  ko
}

/** 非 React 消费者（store / shortcuts 等）：按当前持久化语言取文案。 */
export function getStrings(locale: AppLocale): AppStrings {
  return dictionaries[locale] ?? zhCN
}

/** 组件入口：订阅 settingsStore.language，语言切换即时重渲染。 */
export function useStrings(): AppStrings {
  const language = useSettingsStore((state) => state.language)
  return getStrings(language)
}

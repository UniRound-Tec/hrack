import { createRoot } from 'react-dom/client'
import App from './App'
import FloatingApp from './floating/FloatingApp'
import './index.css'
import mapleMonoLicenseUrl from './assets/fonts/maple-mono/LICENSE.txt?url'
import {
  applyUiTheme,
  builtInLightTheme,
  loadUiThemeRegistry,
  setUiThemeRegistry
} from './app/themeRuntime'
import { appLocales, type AppLocale } from './app/i18n'
import { useSettingsStore } from './state/settingsStore'

const licenseLink = document.createElement('link')
licenseLink.rel = 'license'
licenseLink.href = mapleMonoLicenseUrl
licenseLink.title = 'Maple Mono — SIL Open Font License 1.1'
document.head.append(licenseLink)
applyUiTheme(builtInLightTheme)

async function bootstrap(): Promise<void> {
  const surface = new URLSearchParams(window.location.search).get('surface')
  const floatingSurface = surface === 'floating'
  document.documentElement.dataset.surface = floatingSurface
    ? 'floating'
    : 'main'
  let themeRegistry = await loadUiThemeRegistry()
  setUiThemeRegistry(themeRegistry)
  for (const error of themeRegistry.errors) {
    console.warn(`[theme] ${error.filename}: ${error.message}`)
  }
  const applySelectedUiTheme = (themeId: string): void => {
    const theme = themeRegistry.get(themeId) ?? builtInLightTheme
    applyUiTheme(theme)
    // 首帧底色进主进程偏好文件：下次启动建窗前即可用，消除深色主题启动白闪。
    void window.appApi.setMainPrefs({
      backgroundColor: theme.colors['bg.app'],
      uiThemeId: theme.id
    })
  }
  applySelectedUiTheme(useSettingsStore.getState().uiThemeId)
  const unsubscribeTheme = useSettingsStore.subscribe(
    (settings, previous) => {
      if (settings.uiThemeId !== previous.uiThemeId) {
        applySelectedUiTheme(settings.uiThemeId)
      }
    }
  )

  // 主进程 fs.watch 用户主题目录：新增/修改 → 色值热更；当前主题被删除 → 回退内置浅色并提示。
  const reloadRegistry = async (): Promise<void> => {
    const next = await loadUiThemeRegistry()
    const current = useSettingsStore.getState().uiThemeId
    if (!next.get(current) && current !== 'light') {
      themeRegistry = {
        ...next,
        errors: [
          ...next.errors,
          {
            filename: '<userData>/themes',
            message: '当前主题已被删除，已回退内置浅色'
          }
        ]
      }
    } else {
      themeRegistry = next
    }
    setUiThemeRegistry(themeRegistry)
    for (const error of themeRegistry.errors) {
      console.warn(`[theme] ${error.filename}: ${error.message}`)
    }
    applySelectedUiTheme(useSettingsStore.getState().uiThemeId)
  }
  const unsubscribeThemeWatch = window.appThemeApi.onUserThemesChanged(() => {
    void reloadRegistry()
  })
  const unsubscribeMainPrefs = window.appApi.onMainPrefsChanged((prefs) => {
    const settings = useSettingsStore.getState()
    if (themeRegistry.get(prefs.uiThemeId)) {
      settings.setUiTheme(prefs.uiThemeId)
    }
    if (appLocales.includes(prefs.language as AppLocale)) {
      settings.setLanguage(prefs.language as AppLocale)
    }
  })
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      unsubscribeTheme()
      unsubscribeThemeWatch()
      unsubscribeMainPrefs()
    })
  }

  // xterm 会在 open/fit 时测量字体；四种终端字形必须在 WebGL 创建前全部可用。
  // Pi 会在首屏大量使用 italic；若它第一次绘制时字体仍在加载，fallback 字形会
  // 留在 texture atlas 中，直到选择文本等操作用另一组颜色键触发重新栅格化。
  try {
    await Promise.all([
      document.fonts.load('400 16px "Maple Mono"'),
      document.fonts.load('700 16px "Maple Mono"'),
      document.fonts.load('italic 400 16px "Maple Mono"'),
      document.fonts.load('italic 700 16px "Maple Mono"')
    ])
  } catch {
    // 字体资源异常时仍允许 Consolas/monospace fallback 启动终端。
  }

  // 注意：不使用 <React.StrictMode>。StrictMode 会在 dev 下双触发 effect，
  // 导致 xterm 被 mount→dispose→mount 且 pty 重复 spawn，违背 SPEC §5.1「只挂载一次」。
  createRoot(document.getElementById('root')!).render(
    floatingSurface ? <FloatingApp /> : <App />
  )
}

void bootstrap()

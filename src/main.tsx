import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import mapleMonoLicenseUrl from './assets/fonts/maple-mono/LICENSE.txt?url'
import {
  applyUiTheme,
  builtInLightTheme,
  loadUiThemeRegistry,
  setUiThemeRegistry
} from './app/themeRuntime'
import {
  setRuntimeMockSessions,
  stopRuntimeMockSessions
} from './app/mockSessions'
import { useSettingsStore } from './state/settingsStore'

const licenseLink = document.createElement('link')
licenseLink.rel = 'license'
licenseLink.href = mapleMonoLicenseUrl
licenseLink.title = 'Maple Mono — SIL Open Font License 1.1'
document.head.append(licenseLink)
applyUiTheme(builtInLightTheme)

async function bootstrap(): Promise<void> {
  let themeRegistry = await loadUiThemeRegistry()
  setUiThemeRegistry(themeRegistry)
  for (const error of themeRegistry.errors) {
    console.warn(`[theme] ${error.filename}: ${error.message}`)
  }
  const applySelectedUiTheme = (themeId: string): void => {
    const theme = themeRegistry.get(themeId) ?? builtInLightTheme
    applyUiTheme(theme)
    // 首帧底色进主进程偏好文件：下次启动建窗前即可用，消除深色主题启动白闪。
    void window.appApi.setMainPrefs({ backgroundColor: theme.colors['bg.app'] })
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
  setRuntimeMockSessions(isMockRuntime())

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      unsubscribeTheme()
      unsubscribeThemeWatch()
      stopRuntimeMockSessions()
    })
  }

  // xterm 会在 open/fit 时测量字体；先等内嵌主字体可用，避免 fallback 字体尺寸被
  // 缓存后再换字体，导致首屏行列数和 WebGL glyph atlas 不一致。
  try {
    await Promise.all([
      document.fonts.load('400 16px "Maple Mono"'),
      document.fonts.load('700 16px "Maple Mono"')
    ])
  } catch {
    // 字体资源异常时仍允许 Consolas/monospace fallback 启动终端。
  }

  // 注意：不使用 <React.StrictMode>。StrictMode 会在 dev 下双触发 effect，
  // 导致 xterm 被 mount→dispose→mount 且 pty 重复 spawn，违背 SPEC §5.1「只挂载一次」。
  createRoot(document.getElementById('root')!).render(<App />)
}

function isMockRuntime(): boolean {
  return (
    import.meta.env.DEV ||
    Boolean((globalThis as Record<string, unknown>)['__VIBING_E2E__'])
  )
}

void bootstrap()

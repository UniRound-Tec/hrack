import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import mapleMonoLicenseUrl from './assets/fonts/maple-mono/LICENSE.txt?url'
import {
  applyUiTheme,
  builtInLightTheme,
  loadUiThemeRegistry
} from './app/themeRuntime'

const licenseLink = document.createElement('link')
licenseLink.rel = 'license'
licenseLink.href = mapleMonoLicenseUrl
licenseLink.title = 'Maple Mono — SIL Open Font License 1.1'
document.head.append(licenseLink)
applyUiTheme(builtInLightTheme)

async function bootstrap(): Promise<void> {
  const themeRegistry = await loadUiThemeRegistry()
  for (const error of themeRegistry.errors) {
    console.warn(`[theme] ${error.filename}: ${error.message}`)
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

void bootstrap()

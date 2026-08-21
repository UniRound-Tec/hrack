/**
 * 官方 DSH 页面 document-start bridge。
 *
 * DSH 没有公开 embedder handle。rc.6 把 module table 写到 `__DSH_MODULES__`，
 * rc.7+ 改走 `window.__ModuleLoader__` 并把 Cordis 放进 create() 的
 * staticModules。捕获逻辑见 officialRuntimeCapture.ts；失败由 Controller
 * 超时并显式报错，不做 DOM 猜测式降级。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { DSH_SURFACE_ACTIVE_SESSION_REPORT_CHANNEL } from '../../shared/dsh-ipc'
import { installOfficialRuntimeCapture } from './officialRuntimeCapture'

const requestedLocale = process.argv
  .find((arg) => arg.startsWith('--hrack-dsh-locale='))
  ?.slice('--hrack-dsh-locale='.length)
const locale = requestedLocale === 'en' ? 'en' : 'zh'

contextBridge.exposeInMainWorld('__HRACK_DSH_HOST_BRIDGE__', {
  reportActiveSession: (value: unknown): void => {
    ipcRenderer.send(
      DSH_SURFACE_ACTIVE_SESSION_REPORT_CHANNEL,
      typeof value === 'string' ? value : null
    )
  }
})

function installMainWorldBridge(): void {
  contextBridge.executeInMainWorld({
    args: [locale],
    func: installOfficialRuntimeCapture
  })
}

try {
  installMainWorldBridge()
} catch (error) {
  console.error('[dsh-surface-preload] bridge install failed', error)
}

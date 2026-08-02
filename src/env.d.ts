import type {
  ClipboardApi,
  PtyApi,
  ThemeApi,
  WindowApi
} from '../shared/ipc-contract'

// renderer 全局类型：preload 通过 contextBridge 注入 window.ptyApi。
declare global {
  interface Window {
    ptyApi: PtyApi
    clipboardApi: ClipboardApi
    windowApi: WindowApi
    themeApi: ThemeApi
    __VIBING_E2E__?: true
  }
}

export {}

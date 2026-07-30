import type { ClipboardApi, PtyApi } from '../shared/ipc-contract'

// renderer 全局类型：preload 通过 contextBridge 注入 window.ptyApi。
declare global {
  interface Window {
    ptyApi: PtyApi
    clipboardApi: ClipboardApi
  }
}

export {}

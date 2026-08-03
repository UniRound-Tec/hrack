import type {
  AgentApi
} from '../shared/agent-events'
import type {
  AppApi,
  AppThemeApi,
  CliApi,
  ClipboardApi,
  DialogApi,
  PtyApi,
  ShellApi,
  StatsApi,
  ThemeApi,
  WindowApi
} from '../shared/ipc-contract'
import type { VibingDebugShellApi } from './app/AppShell'

// renderer 全局类型：preload 通过 contextBridge 注入 window.ptyApi。
declare global {
  interface Window {
    ptyApi: PtyApi
    clipboardApi: ClipboardApi
    windowApi: WindowApi
    themeApi: ThemeApi
    dialogApi: DialogApi
    shellApi: ShellApi
    cliApi: CliApi
    statsApi: StatsApi
    agentApi: AgentApi
    appApi: AppApi
    appThemeApi: AppThemeApi
    __VIBING_E2E__?: true
    __vibingDebugShell?: VibingDebugShellApi
  }
}

export {}

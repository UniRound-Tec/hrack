import { dshTerminalId, isDshTerminalId } from '../../shared/dsh-ipc'

export type PageId =
  | 'home'
  | 'settings'
  | 'dsh:home'
  | 'dsh:settings'
  | `dsh:${string}`
  | `terminal:${string}`

export function terminalPage(terminalId: string): PageId {
  return `terminal:${terminalId}`
}

export function terminalIdFromPage(pageId: PageId): string | null {
  return pageId.startsWith('terminal:') ? pageId.slice(9) : null
}

/** DSH lobby 页（历史会话/新建/设置入口）。 */
export function dshHomePage(): PageId {
  return 'dsh:home'
}

/** 某个 DSH 会话的页面：只挂对话/轨迹，不挂官方侧栏。 */
export function dshSessionPage(sessionId: string): PageId {
  return `dsh:${sessionId}`
}

/** DSH 设置页（大厅入口，复用官方 settings.section）。 */
export function dshSettingsPage(): PageId {
  return 'dsh:settings'
}

export function isDshPage(pageId: PageId): boolean {
  return pageId === 'dsh:home' || pageId.startsWith('dsh:')
}

export function isDshSettingsPage(pageId: PageId): boolean {
  return pageId === 'dsh:settings'
}

export function isDshChromePage(pageId: PageId): boolean {
  return pageId === 'dsh:home' || pageId === 'dsh:settings'
}

export function dshSessionIdFromPage(pageId: PageId): string | null {
  if (isDshChromePage(pageId) || !pageId.startsWith('dsh:')) return null
  return pageId.slice(4)
}

export { dshTerminalId, isDshTerminalId }

export function sessionPage(session: {
  kind?: 'pty' | 'dsh'
  sessionId: string
  terminalId: string
}): PageId {
  return session.kind === 'dsh'
    ? dshSessionPage(session.sessionId)
    : terminalPage(session.terminalId)
}

export function isPageId(value: unknown): value is PageId {
  return (
    value === 'home' ||
    value === 'settings' ||
    value === 'dsh:home' ||
    value === 'dsh:settings' ||
    (typeof value === 'string' &&
      value.startsWith('dsh:') &&
      value.length > 4) ||
    (typeof value === 'string' &&
      value.startsWith('terminal:') &&
      value.length > 9)
  )
}

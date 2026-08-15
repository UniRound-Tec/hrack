import { dshTerminalId, isDshTerminalId } from '../../shared/dsh-ipc'

export type PageId =
  | 'home'
  | 'settings'
  | 'dsh:home'
  | `dsh:${string}`
  | `terminal:${string}`

export function terminalPage(terminalId: string): PageId {
  return `terminal:${terminalId}`
}

export function terminalIdFromPage(pageId: PageId): string | null {
  return pageId.startsWith('terminal:') ? pageId.slice(9) : null
}

/** Home 创建的某个 DSH 跟踪位；完整界面由官方 Web 自己渲染。 */
export function dshSlotPage(slotId: string): PageId {
  return `dsh:${slotId}`
}

export function isDshPage(pageId: PageId): boolean {
  return pageId === 'dsh:home' || pageId.startsWith('dsh:')
}

export function dshSlotIdFromPage(pageId: PageId): string | null {
  // dsh:settings was the removed Vibing-owned settings route. Keep treating
  // it as a non-session target so stale dev links can be normalized home.
  if (
    pageId === 'dsh:home' ||
    pageId === 'dsh:settings' ||
    !pageId.startsWith('dsh:')
  ) {
    return null
  }
  return pageId.slice(4)
}

export { dshTerminalId, isDshTerminalId }

export function sessionPage(session: {
  kind?: 'pty' | 'dsh'
  sessionId: string
  terminalId: string
}): PageId {
  return session.kind === 'dsh'
    ? dshSlotPage(session.sessionId)
    : terminalPage(session.terminalId)
}

export function isPageId(value: unknown): value is PageId {
  return (
    value === 'home' ||
    value === 'settings' ||
    value === 'dsh:home' ||
    (typeof value === 'string' &&
      value.startsWith('dsh:') &&
      value.length > 4) ||
    (typeof value === 'string' &&
      value.startsWith('terminal:') &&
      value.length > 9)
  )
}

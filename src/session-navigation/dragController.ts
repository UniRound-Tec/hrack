export const SESSION_DRAG_THRESHOLD_PX = 5
export const SESSION_GROUP_DWELL_MS = 800

export function passedSessionDragThreshold(
  startX: number,
  startY: number,
  clientX: number,
  clientY: number
): boolean {
  return Math.hypot(clientX - startX, clientY - startY) >= SESSION_DRAG_THRESHOLD_PX
}

export function rootDropBeforeId(clientY: number, sourceId: string): string | null {
  const roots = Array.from(
    document.querySelectorAll<HTMLElement>('[data-navigation-root-id]')
  ).filter((element) => element.dataset.navigationRootId !== sourceId)
  for (const root of roots) {
    const rect = root.getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) {
      return root.dataset.navigationRootId ?? null
    }
  }
  return null
}

export function memberDropBeforeId(
  clientY: number,
  groupId: string,
  sourceTerminalId: string
): string | null {
  const members = Array.from(
    document.querySelectorAll<HTMLElement>(
      `[data-navigation-terminal-id][data-navigation-group-id="${CSS.escape(groupId)}"]`
    )
  ).filter(
    (element) => element.dataset.navigationTerminalId !== sourceTerminalId
  )
  for (const member of members) {
    const rect = member.getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) {
      return member.dataset.navigationTerminalId ?? null
    }
  }
  return null
}

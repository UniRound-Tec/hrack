export const SESSION_DRAG_THRESHOLD_PX = 5

export function passedSessionDragThreshold(
  startX: number,
  startY: number,
  clientX: number,
  clientY: number
): boolean {
  return Math.hypot(clientX - startX, clientY - startY) >= SESSION_DRAG_THRESHOLD_PX
}

export function rootDropBeforeId(
  clientY: number,
  sourceId: string
): string | null {
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

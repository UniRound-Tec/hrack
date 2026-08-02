export type PageId = 'home' | 'settings' | `terminal:${string}`

export function terminalPage(terminalId: string): PageId {
  return `terminal:${terminalId}`
}

export function terminalIdFromPage(pageId: PageId): string | null {
  return pageId.startsWith('terminal:') ? pageId.slice(9) : null
}

export function isPageId(value: unknown): value is PageId {
  return (
    value === 'home' ||
    value === 'settings' ||
    (typeof value === 'string' &&
      value.startsWith('terminal:') &&
      value.length > 9)
  )
}

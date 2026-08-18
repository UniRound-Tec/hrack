export const WORKSPACE_HISTORY_LIMIT = 5
export const WORKSPACE_HISTORY_KEY = 'hrack.workspaceHistory'
export const LAST_WORKSPACE_KEY = 'hrack.lastWorkspace'
export const LEGACY_LAST_WORKSPACE_KEY = 'vibing.lastWorkspace'

export interface WorkspaceHistoryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function normalizeWorkspace(workspace: string): string {
  const trimmed = workspace.trim()
  if (!trimmed) return ''
  if (trimmed === '/' || /^[a-zA-Z]:\\$/.test(trimmed)) return trimmed
  return trimmed.replace(/[\\/]+$/, '')
}

export function rememberWorkspace(
  workspace: string,
  history: readonly string[]
): string[] {
  const next = normalizeWorkspace(workspace)
  const seen = new Set<string>()
  const items: string[] = []
  if (next) {
    seen.add(next)
    items.push(next)
  }
  for (const item of history) {
    const candidate = normalizeWorkspace(item)
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    items.push(candidate)
    if (items.length === WORKSPACE_HISTORY_LIMIT) break
  }
  return items
}

export function parseWorkspaceHistory(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return rememberWorkspace('', value.filter((item): item is string => typeof item === 'string'))
  } catch {
    return []
  }
}

function defaultStorage(): WorkspaceHistoryStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

export function readWorkspaceHistory(
  storage: WorkspaceHistoryStorage | null = defaultStorage()
): string[] {
  if (!storage) return []
  try {
    const stored = parseWorkspaceHistory(storage.getItem(WORKSPACE_HISTORY_KEY))
    if (stored.length > 0) return stored
    const last =
      storage.getItem(LAST_WORKSPACE_KEY) ??
      storage.getItem(LEGACY_LAST_WORKSPACE_KEY) ??
      ''
    const seeded = rememberWorkspace(last, [])
    if (seeded.length > 0) persistWorkspaceHistory(seeded, storage)
    return seeded
  } catch {
    return []
  }
}

export function lastWorkspace(
  storage: WorkspaceHistoryStorage | null = defaultStorage()
): string {
  return readWorkspaceHistory(storage)[0] ?? ''
}

export function saveWorkspace(
  workspace: string,
  storage: WorkspaceHistoryStorage | null = defaultStorage()
): string[] {
  const history = rememberWorkspace(workspace, readWorkspaceHistory(storage))
  persistWorkspaceHistory(history, storage)
  return history
}

function persistWorkspaceHistory(
  history: readonly string[],
  storage: WorkspaceHistoryStorage | null
): void {
  if (!storage) return
  try {
    storage.setItem(WORKSPACE_HISTORY_KEY, JSON.stringify(history))
    if (history[0]) storage.setItem(LAST_WORKSPACE_KEY, history[0])
  } catch {
    // Private browsing or a locked-down renderer may reject localStorage.
  }
}

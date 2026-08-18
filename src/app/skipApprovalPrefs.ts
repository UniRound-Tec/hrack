export const SKIP_APPROVAL_PREFS_KEY = 'hrack.skipApproval'

export interface SkipApprovalPrefsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): SkipApprovalPrefsStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

export function parseSkipApprovalPrefs(raw: string | null): Record<string, boolean> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const prefs: Record<string, boolean> = {}
    for (const [id, enabled] of Object.entries(value)) {
      if (typeof id !== 'string' || id.length === 0) continue
      if (typeof enabled !== 'boolean') continue
      prefs[id] = enabled
    }
    return prefs
  } catch {
    return {}
  }
}

function readAll(
  storage: SkipApprovalPrefsStorage | null
): Record<string, boolean> {
  if (!storage) return {}
  try {
    return parseSkipApprovalPrefs(storage.getItem(SKIP_APPROVAL_PREFS_KEY))
  } catch {
    return {}
  }
}

export function readSkipApprovalPref(
  definitionId: string,
  storage: SkipApprovalPrefsStorage | null = defaultStorage()
): boolean {
  return readAll(storage)[definitionId] === true
}

export function saveSkipApprovalPref(
  definitionId: string,
  enabled: boolean,
  storage: SkipApprovalPrefsStorage | null = defaultStorage()
): Record<string, boolean> {
  const prefs = readAll(storage)
  prefs[definitionId] = enabled
  if (!storage) return prefs
  try {
    storage.setItem(SKIP_APPROVAL_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Private browsing or a locked-down renderer may reject localStorage.
  }
  return prefs
}

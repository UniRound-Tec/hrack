import type { SessionEntry } from '../state/sessionsStore'

export interface SessionNavigationSnapshot {
  schemaVersion: 1
  root: SessionNavigationRef[]
}

export interface SessionNavigationRef {
  kind: 'session'
  terminalId: string
}

export type SessionNavigationIntent =
  | {
      kind: 'reorder-root'
      sourceId: string
      beforeId: string | null
    }
  | { kind: 'activity'; terminalId: string }

export function createEmptySessionNavigation(): SessionNavigationSnapshot {
  return { schemaVersion: 1, root: [] }
}

/**
 * Accepts both the current flat snapshot and the removed grouping schema.
 * Legacy groups are expanded in-place so upgrading preserves every card and
 * its visible order without keeping grouping behavior alive.
 */
export function normalizeSessionNavigationSnapshot(
  value: unknown
): SessionNavigationSnapshot {
  if (!value || typeof value !== 'object') return createEmptySessionNavigation()
  const candidate = value as { root?: unknown; groups?: unknown }
  if (!Array.isArray(candidate.root)) return createEmptySessionNavigation()
  const rawGroups =
    candidate.groups && typeof candidate.groups === 'object'
      ? (candidate.groups as Record<string, unknown>)
      : {}
  const root: SessionNavigationRef[] = []
  const seen = new Set<string>()
  const append = (terminalId: unknown): void => {
    if (
      typeof terminalId !== 'string' ||
      terminalId.length === 0 ||
      seen.has(terminalId)
    ) {
      return
    }
    seen.add(terminalId)
    root.push({ kind: 'session', terminalId })
  }

  for (const rawRef of candidate.root) {
    if (!rawRef || typeof rawRef !== 'object') continue
    const ref = rawRef as Record<string, unknown>
    if (ref.kind === 'session') {
      append(ref.terminalId)
      continue
    }
    if (ref.kind !== 'group' || typeof ref.groupId !== 'string') continue
    const rawGroup = rawGroups[ref.groupId]
    if (!rawGroup || typeof rawGroup !== 'object') continue
    const members = (rawGroup as { members?: unknown }).members
    if (Array.isArray(members)) members.forEach(append)
  }

  return { schemaVersion: 1, root }
}

function sameNavigationSnapshot(
  left: SessionNavigationSnapshot,
  right: SessionNavigationSnapshot
): boolean {
  return (
    left.root.length === right.root.length &&
    left.root.every(
      (ref, index) => ref.terminalId === right.root[index]?.terminalId
    )
  )
}

function insertRootBefore(
  root: SessionNavigationRef[],
  ref: SessionNavigationRef,
  beforeId: string | null
): SessionNavigationRef[] {
  const remaining = root.filter(
    (candidate) => candidate.terminalId !== ref.terminalId
  )
  const index =
    beforeId === null
      ? -1
      : remaining.findIndex(
          (candidate) => candidate.terminalId === beforeId
        )
  if (index < 0) remaining.push(ref)
  else remaining.splice(index, 0, ref)
  return remaining
}

export function applySessionNavigationIntent(
  snapshot: SessionNavigationSnapshot,
  intent: SessionNavigationIntent,
  options: { attentionPriorityEnabled: boolean }
): SessionNavigationSnapshot {
  if (intent.kind === 'reorder-root') {
    const source = snapshot.root.find(
      (ref) => ref.terminalId === intent.sourceId
    )
    if (!source) return snapshot
    const root = insertRootBefore(snapshot.root, source, intent.beforeId)
    const next = { ...snapshot, root }
    return sameNavigationSnapshot(snapshot, next) ? snapshot : next
  }

  if (!options.attentionPriorityEnabled) return snapshot
  const index = snapshot.root.findIndex(
    (ref) => ref.terminalId === intent.terminalId
  )
  if (index <= 0) return snapshot
  const root = [...snapshot.root]
  const [ref] = root.splice(index, 1)
  root.unshift(ref)
  return { ...snapshot, root }
}

export function reconcileSessionNavigation(
  snapshot: SessionNavigationSnapshot,
  activeTerminalIds: readonly string[],
  options: { recoveryComplete: boolean }
): SessionNavigationSnapshot {
  const normalized = normalizeSessionNavigationSnapshot(snapshot)
  if (!options.recoveryComplete) {
    return sameNavigationSnapshot(snapshot, normalized)
      ? snapshot
      : normalized
  }

  const active = new Set(activeTerminalIds)
  const seen = new Set<string>()
  const root = normalized.root.filter((ref) => {
    if (!active.has(ref.terminalId) || seen.has(ref.terminalId)) return false
    seen.add(ref.terminalId)
    return true
  })
  for (const terminalId of activeTerminalIds) {
    if (seen.has(terminalId)) continue
    seen.add(terminalId)
    root.push({ kind: 'session', terminalId })
  }

  const reconciled: SessionNavigationSnapshot = { schemaVersion: 1, root }
  return sameNavigationSnapshot(snapshot, reconciled) ? snapshot : reconciled
}

export function projectSessionNavigation(
  snapshot: SessionNavigationSnapshot,
  sessions: readonly SessionEntry[]
): SessionEntry[] {
  const normalized = normalizeSessionNavigationSnapshot(snapshot)
  const byTerminalId = new Map(
    sessions.map((session) => [session.terminalId, session])
  )
  return normalized.root
    .map((ref) => byTerminalId.get(ref.terminalId))
    .filter((session): session is SessionEntry => Boolean(session))
}

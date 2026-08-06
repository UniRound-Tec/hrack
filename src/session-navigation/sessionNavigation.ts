import type { SessionEntry } from '../state/sessionsStore'

export interface SessionNavigationSnapshot {
  schemaVersion: 1
  root: SessionNavigationRef[]
  groups: Record<string, SessionGroup>
}

export type SessionNavigationRef =
  | { kind: 'session'; terminalId: string }
  | { kind: 'group'; groupId: string }

export interface SessionGroup {
  id: string
  name: string
  members: string[]
}

export type SessionNavigationIntent =
  | {
      kind: 'reorder-root'
      sourceId: string
      beforeId: string | null
    }
  | {
      kind: 'reorder-member'
      terminalId: string
      groupId: string
      beforeTerminalId: string | null
    }
  | {
      kind: 'group-pair'
      groupId: string
      sourceTerminalId: string
      targetTerminalId: string
      defaultName: string
    }
  | {
      kind: 'move-into-group'
      terminalId: string
      groupId: string
      beforeTerminalId: string | null
    }
  | {
      kind: 'move-out-of-group'
      terminalId: string
      beforeId: string | null
    }
  | { kind: 'rename-group'; groupId: string; name: string }
  | { kind: 'dissolve-group'; groupId: string }
  | { kind: 'activity'; terminalId: string }

export type SidebarSessionNode =
  | { kind: 'session'; session: SessionEntry }
  | { kind: 'group'; group: SessionGroup; sessions: SessionEntry[] }

export function createEmptySessionNavigation(): SessionNavigationSnapshot {
  return { schemaVersion: 1, root: [], groups: {} }
}

export function normalizeSessionNavigationSnapshot(
  value: unknown
): SessionNavigationSnapshot {
  if (!value || typeof value !== 'object') return createEmptySessionNavigation()
  const candidate = value as {
    root?: unknown
    groups?: unknown
  }
  if (!Array.isArray(candidate.root)) return createEmptySessionNavigation()
  const rawGroups =
    candidate.groups && typeof candidate.groups === 'object'
      ? (candidate.groups as Record<string, unknown>)
      : {}
  const snapshot = createEmptySessionNavigation()
  const seenTerminals = new Set<string>()
  const seenGroups = new Set<string>()

  for (const rawRef of candidate.root) {
    if (!rawRef || typeof rawRef !== 'object') continue
    const ref = rawRef as Record<string, unknown>
    if (
      ref.kind === 'session' &&
      typeof ref.terminalId === 'string' &&
      ref.terminalId &&
      !seenTerminals.has(ref.terminalId)
    ) {
      seenTerminals.add(ref.terminalId)
      snapshot.root.push({ kind: 'session', terminalId: ref.terminalId })
      continue
    }
    if (
      ref.kind !== 'group' ||
      typeof ref.groupId !== 'string' ||
      !ref.groupId ||
      seenGroups.has(ref.groupId)
    ) {
      continue
    }
    const rawGroup = rawGroups[ref.groupId]
    if (!rawGroup || typeof rawGroup !== 'object') continue
    const group = rawGroup as Record<string, unknown>
    const members = Array.isArray(group.members)
      ? group.members.filter((member): member is string => {
          if (
            typeof member !== 'string' ||
            !member ||
            seenTerminals.has(member)
          ) {
            return false
          }
          seenTerminals.add(member)
          return true
        })
      : []
    if (members.length === 0) continue
    const name =
      typeof group.name === 'string' && group.name.trim()
        ? group.name.trim().slice(0, 48)
        : 'Group'
    seenGroups.add(ref.groupId)
    snapshot.groups[ref.groupId] = {
      id: ref.groupId,
      name,
      members
    }
    snapshot.root.push({ kind: 'group', groupId: ref.groupId })
  }
  return snapshot
}

function copySnapshot(
  snapshot: SessionNavigationSnapshot
): SessionNavigationSnapshot {
  return {
    schemaVersion: 1,
    root: snapshot.root.map((ref) => ({ ...ref })),
    groups: Object.fromEntries(
      Object.entries(snapshot.groups).map(([id, group]) => [
        id,
        { ...group, members: [...group.members] }
      ])
    )
  }
}

function refId(ref: SessionNavigationRef): string {
  return ref.kind === 'session' ? ref.terminalId : ref.groupId
}

function sameNavigationSnapshot(
  left: SessionNavigationSnapshot,
  right: SessionNavigationSnapshot
): boolean {
  if (left.root.length !== right.root.length) return false
  if (
    left.root.some(
      (ref, index) =>
        ref.kind !== right.root[index]?.kind ||
        refId(ref) !== refId(right.root[index])
    )
  ) {
    return false
  }
  const leftGroupIds = Object.keys(left.groups)
  const rightGroupIds = Object.keys(right.groups)
  if (leftGroupIds.length !== rightGroupIds.length) return false
  return leftGroupIds.every((groupId) => {
    const a = left.groups[groupId]
    const b = right.groups[groupId]
    return (
      Boolean(b) &&
      a.name === b.name &&
      a.members.length === b.members.length &&
      a.members.every((member, index) => member === b.members[index])
    )
  })
}

function terminalGroupId(
  snapshot: SessionNavigationSnapshot,
  terminalId: string
): string | null {
  for (const group of Object.values(snapshot.groups)) {
    if (group.members.includes(terminalId)) return group.id
  }
  return null
}

function removeTerminal(
  snapshot: SessionNavigationSnapshot,
  terminalId: string
): void {
  snapshot.root = snapshot.root.filter(
    (ref) => ref.kind !== 'session' || ref.terminalId !== terminalId
  )
  for (const group of Object.values(snapshot.groups)) {
    group.members = group.members.filter((member) => member !== terminalId)
  }
  removeEmptyGroups(snapshot)
}

function removeEmptyGroups(snapshot: SessionNavigationSnapshot): void {
  for (const [groupId, group] of Object.entries(snapshot.groups)) {
    if (group.members.length > 0) continue
    delete snapshot.groups[groupId]
    snapshot.root = snapshot.root.filter(
      (ref) => ref.kind !== 'group' || ref.groupId !== groupId
    )
  }
}

function insertRootBefore(
  snapshot: SessionNavigationSnapshot,
  ref: SessionNavigationRef,
  beforeId: string | null
): void {
  snapshot.root = snapshot.root.filter(
    (candidate) => refId(candidate) !== refId(ref)
  )
  const index =
    beforeId === null
      ? -1
      : snapshot.root.findIndex((candidate) => refId(candidate) === beforeId)
  if (index < 0) snapshot.root.push(ref)
  else snapshot.root.splice(index, 0, ref)
}

function insertMemberBefore(
  members: string[],
  terminalId: string,
  beforeTerminalId: string | null
): void {
  const remaining = members.filter((member) => member !== terminalId)
  const index =
    beforeTerminalId === null
      ? -1
      : remaining.findIndex((member) => member === beforeTerminalId)
  if (index < 0) remaining.push(terminalId)
  else remaining.splice(index, 0, terminalId)
  members.splice(0, members.length, ...remaining)
}

export function applySessionNavigationIntent(
  snapshot: SessionNavigationSnapshot,
  intent: SessionNavigationIntent,
  options: { attentionPriorityEnabled: boolean }
): SessionNavigationSnapshot {
  const next = copySnapshot(snapshot)

  switch (intent.kind) {
    case 'reorder-root': {
      const source = next.root.find((ref) => refId(ref) === intent.sourceId)
      if (!source) return snapshot
      insertRootBefore(next, source, intent.beforeId)
      return next
    }
    case 'reorder-member': {
      const group = next.groups[intent.groupId]
      if (!group || !group.members.includes(intent.terminalId)) return snapshot
      insertMemberBefore(
        group.members,
        intent.terminalId,
        intent.beforeTerminalId
      )
      return next
    }
    case 'group-pair': {
      if (intent.sourceTerminalId === intent.targetTerminalId) return snapshot
      const existing = next.groups[intent.groupId]
      if (
        existing?.members.includes(intent.sourceTerminalId) &&
        existing.members.includes(intent.targetTerminalId)
      ) {
        return snapshot
      }

      const sourceRootIndex = next.root.findIndex(
        (ref) =>
          (ref.kind === 'session' &&
            ref.terminalId === intent.sourceTerminalId) ||
          (ref.kind === 'group' &&
            ref.groupId === terminalGroupId(next, intent.sourceTerminalId))
      )
      const targetRootIndex = next.root.findIndex(
        (ref) =>
          (ref.kind === 'session' &&
            ref.terminalId === intent.targetTerminalId) ||
          (ref.kind === 'group' &&
            ref.groupId === terminalGroupId(next, intent.targetTerminalId))
      )
      if (sourceRootIndex < 0 || targetRootIndex < 0) return snapshot
      const insertAt = Math.min(sourceRootIndex, targetRootIndex)

      removeTerminal(next, intent.sourceTerminalId)
      removeTerminal(next, intent.targetTerminalId)
      next.groups[intent.groupId] = {
        id: intent.groupId,
        name: intent.defaultName.trim().slice(0, 48),
        members: [intent.targetTerminalId, intent.sourceTerminalId]
      }
      next.root.splice(Math.min(insertAt, next.root.length), 0, {
        kind: 'group',
        groupId: intent.groupId
      })
      return next
    }
    case 'move-into-group': {
      const group = next.groups[intent.groupId]
      if (!group) return snapshot
      if (group.members.includes(intent.terminalId)) {
        insertMemberBefore(
          group.members,
          intent.terminalId,
          intent.beforeTerminalId
        )
        return next
      }
      removeTerminal(next, intent.terminalId)
      const target = next.groups[intent.groupId]
      if (!target) return snapshot
      insertMemberBefore(
        target.members,
        intent.terminalId,
        intent.beforeTerminalId
      )
      return next
    }
    case 'move-out-of-group': {
      const groupId = terminalGroupId(next, intent.terminalId)
      if (!groupId) return snapshot
      removeTerminal(next, intent.terminalId)
      insertRootBefore(
        next,
        { kind: 'session', terminalId: intent.terminalId },
        intent.beforeId
      )
      return next
    }
    case 'rename-group': {
      const group = next.groups[intent.groupId]
      const name = intent.name.trim().slice(0, 48)
      if (!group || name.length === 0 || group.name === name) return snapshot
      group.name = name
      return next
    }
    case 'dissolve-group': {
      const group = next.groups[intent.groupId]
      const rootIndex = next.root.findIndex(
        (ref) => ref.kind === 'group' && ref.groupId === intent.groupId
      )
      if (!group || rootIndex < 0) return snapshot
      next.root.splice(
        rootIndex,
        1,
        ...group.members.map(
          (terminalId): SessionNavigationRef => ({ kind: 'session', terminalId })
        )
      )
      delete next.groups[intent.groupId]
      return next
    }
    case 'activity': {
      if (!options.attentionPriorityEnabled) return snapshot
      const groupId = terminalGroupId(next, intent.terminalId)
      const id = groupId ?? intent.terminalId
      const index = next.root.findIndex((ref) => refId(ref) === id)
      if (index <= 0) return snapshot
      const [ref] = next.root.splice(index, 1)
      next.root.unshift(ref)
      return next
    }
  }
}

export function reconcileSessionNavigation(
  snapshot: SessionNavigationSnapshot,
  activeTerminalIds: readonly string[],
  options: { recoveryComplete: boolean }
): SessionNavigationSnapshot {
  if (!options.recoveryComplete) return snapshot

  const active = new Set(activeTerminalIds)
  const seen = new Set<string>()
  const root: SessionNavigationRef[] = []
  const groups: Record<string, SessionGroup> = {}

  for (const ref of snapshot.root) {
    if (ref.kind === 'session') {
      if (active.has(ref.terminalId) && !seen.has(ref.terminalId)) {
        seen.add(ref.terminalId)
        root.push(ref)
      }
      continue
    }

    const persistedGroup = snapshot.groups[ref.groupId]
    if (!persistedGroup || groups[ref.groupId]) continue
    const members = persistedGroup.members.filter((terminalId) => {
      if (!active.has(terminalId) || seen.has(terminalId)) return false
      seen.add(terminalId)
      return true
    })
    if (members.length > 0) {
      groups[ref.groupId] = { ...persistedGroup, members }
      root.push({ kind: 'group', groupId: ref.groupId })
    }
  }

  for (const terminalId of activeTerminalIds) {
    if (!seen.has(terminalId)) {
      seen.add(terminalId)
      root.push({ kind: 'session', terminalId })
    }
  }

  const reconciled: SessionNavigationSnapshot = {
    schemaVersion: 1,
    root,
    groups
  }
  return sameNavigationSnapshot(snapshot, reconciled) ? snapshot : reconciled
}

export function projectSessionNavigation(
  snapshot: SessionNavigationSnapshot,
  sessions: readonly SessionEntry[]
): { sidebar: SidebarSessionNode[]; flat: SessionEntry[] } {
  const byTerminalId = new Map(
    sessions.map((session) => [session.terminalId, session])
  )
  const sidebar: SidebarSessionNode[] = []
  const flat: SessionEntry[] = []

  for (const ref of snapshot.root) {
    if (ref.kind === 'session') {
      const session = byTerminalId.get(ref.terminalId)
      if (!session) continue
      sidebar.push({ kind: 'session', session })
      flat.push(session)
      continue
    }
    const group = snapshot.groups[ref.groupId]
    if (!group) continue
    const members = group.members
      .map((terminalId) => byTerminalId.get(terminalId))
      .filter((session): session is SessionEntry => Boolean(session))
    if (members.length === 0) continue
    sidebar.push({ kind: 'group', group, sessions: members })
    flat.push(...members)
  }

  return { sidebar, flat }
}

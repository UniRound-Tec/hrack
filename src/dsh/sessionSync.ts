/**
 * 把 dsh host 的会话列表投影进 vibing sessionsStore。
 * 主进程 DshProjectionBridge 同步写 agent:projection，悬浮窗零改动受益。
 */

import { useSessionsStore, type SessionEntry } from '../state/sessionsStore'
import { dshTerminalId } from '../app/pages'
import type { DshRetentionPolicy } from '../../shared/dsh-ipc'
import {
  archiveDshSession,
  listDshSessions,
  listDshWorkspaces,
  renameDshSession,
  sessionTitleOf,
  type DshSessionSummary
} from './rpc'

async function applyRetention(
  sessions: DshSessionSummary[],
  policy: DshRetentionPolicy
): Promise<void> {
  const candidates = sessions.filter(
    (session) => !session.running && session.origin !== 'subagent'
  )
  let stale: DshSessionSummary[] = []
  if (policy.kind === 'days') {
    const cutoff = Date.now() - policy.days * 24 * 60 * 60 * 1000
    stale = candidates.filter((session) => session.updatedAt < cutoff)
  } else if (policy.kind === 'count') {
    stale = [...candidates]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(policy.count)
  }
  for (const session of stale) {
    try {
      await archiveDshSession(session.sessionId)
    } catch (error) {
      console.warn('[dsh] retention archive failed', session.sessionId, error)
    }
  }
}

export type DshUiStatus = SessionEntry['status']

function mapDshStatus(session: DshSessionSummary): {
  status: DshUiStatus
  detail?: string
} {
  if (session.running) return { status: 'working' }
  return { status: 'idle' }
}

export function toDshSessionEntry(session: DshSessionSummary): SessionEntry {
  const mapped = mapDshStatus(session)
  return {
    sessionId: session.sessionId,
    terminalId: dshTerminalId(session.sessionId),
    adapterId: 'dsh',
    installationId: 'dsh',
    kind: 'dsh',
    name: sessionTitleOf(session),
    status: mapped.status,
    detail: mapped.detail,
    lastActivityAt: session.updatedAt
  }
}

export async function refreshDshSessions(): Promise<SessionEntry[]> {
  const status = await window.dshApi.ensureStarted()
  if (status.state !== 'ready') {
    throw new Error(status.error ?? 'dsh host is not ready')
  }
  const [initialSessions, initialWorkspaces, config] = await Promise.all([
    listDshSessions(),
    listDshWorkspaces(),
    window.dshApi.getConfig()
  ])
  if (config.retention.kind !== 'all') {
    await applyRetention(initialSessions, config.retention)
  }
  const [sessions, workspaces] =
    config.retention.kind === 'all'
      ? [initialSessions, initialWorkspaces]
      : await Promise.all([listDshSessions(), listDshWorkspaces()])
  const archived = new Set(workspaces.archivedSessionIds)
  const visible = sessions.filter(
    (session) => !archived.has(session.sessionId) && session.origin !== 'subagent'
  )
  const store = useSessionsStore.getState()
  const incomingIds = new Set(visible.map((session) => session.sessionId))
  const stale = store.sessions
    .filter((session) => session.kind === 'dsh' && !incomingIds.has(session.sessionId))
    .map((session) => session.sessionId)
  if (stale.length > 0) store.removeSessions(stale)
  const current = new Map(
    store.sessions.map((session) => [session.sessionId, session])
  )
  const entries = visible.map((session) => {
    const entry = toDshSessionEntry(session)
    const existing = current.get(session.sessionId)
    if (
      existing &&
      (existing.status === 'needs-you' || existing.status === 'error')
    ) {
      return {
        ...entry,
        status: existing.status,
        detail: existing.detail ?? entry.detail
      }
    }
    return entry
  })
  store.upsertSessions(entries)
  return entries
}

export async function renameVisibleDshSession(
  sessionId: string,
  name: string
): Promise<void> {
  await renameDshSession(sessionId, name)
  useSessionsStore.getState().updateSession(sessionId, { name })
}

export async function closeVisibleDshSession(sessionId: string): Promise<void> {
  await archiveDshSession(sessionId)
  useSessionsStore.getState().removeSession(sessionId)
}

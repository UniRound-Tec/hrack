import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen, Plus, RefreshCw, Settings2 } from 'lucide-react'
import { useStrings } from './i18n'
import { statusDot, statusLabel, statusTone } from './sessionStatus'
import {
  createDshSession,
  createDshWorkspace,
  listDshSessions,
  listDshWorkspaces,
  sessionTitleOf,
  type DshSessionSummary,
  type DshWorkspaceView
} from '../dsh/rpc'
import { refreshDshSessions } from '../dsh/sessionSync'

interface DshLobbyPageProps {
  onOpenSession: (sessionId: string) => void
  onOpenSettings: () => void
}

interface WorkspaceGroup {
  workspace: DshWorkspaceView | null
  sessions: DshSessionSummary[]
}

function groupSessions(
  workspaces: DshWorkspaceView[],
  sessions: DshSessionSummary[],
  archived: readonly string[]
): WorkspaceGroup[] {
  const archivedIds = new Set(archived)
  const byId = new Map(sessions.map((session) => [session.sessionId, session]))
  const grouped = new Set<string>()
  const groups: WorkspaceGroup[] = workspaces.map((workspace) => {
    const rows = workspace.sessionIds
      .map((id) => byId.get(id))
      .filter((session): session is DshSessionSummary => {
        if (!session || archivedIds.has(session.sessionId)) return false
        if (session.origin === 'subagent') return false
        grouped.add(session.sessionId)
        return true
      })
    return { workspace, sessions: rows }
  })
  const ungrouped = sessions.filter(
    (session) =>
      !grouped.has(session.sessionId) &&
      !archivedIds.has(session.sessionId) &&
      session.origin !== 'subagent'
  )
  if (ungrouped.length > 0) {
    groups.push({ workspace: null, sessions: ungrouped })
  }
  return groups
}

export default function DshLobbyPage({
  onOpenSession,
  onOpenSettings
}: DshLobbyPageProps) {
  const strings = useStrings()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [workspaces, setWorkspaces] = useState<DshWorkspaceView[]>([])
  const [sessions, setSessions] = useState<DshSessionSummary[]>([])
  const [archived, setArchived] = useState<string[]>([])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const status = await window.dshApi.ensureStarted()
      if (status.state !== 'ready') {
        throw new Error(status.error ?? 'dsh host is not ready')
      }
      const [workspaceList, sessionList] = await Promise.all([
        listDshWorkspaces(),
        listDshSessions()
      ])
      setWorkspaces(workspaceList.items)
      setArchived(workspaceList.archivedSessionIds)
      setSessions(sessionList)
      await refreshDshSessions()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const groups = useMemo(
    () => groupSessions(workspaces, sessions, archived),
    [archived, sessions, workspaces]
  )

  const createInWorkspace = async (workspace?: DshWorkspaceView): Promise<void> => {
    setCreating(true)
    setError(null)
    try {
      let target = workspace
      if (!target) {
        const platform =
          window.windowApi.platform === 'darwin'
            ? 'macos'
            : window.windowApi.platform === 'linux'
              ? 'linux'
              : 'windows'
        const picked = await window.dialogApi.pickDirectory({
          runtime: { kind: 'host', platform }
        })
        if (!picked) return
        target = await createDshWorkspace(picked)
      }
      const created = await createDshSession({ workspaceId: target.workspaceId })
      await refreshDshSessions()
      onOpenSession(created.sessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
    }
  }

  return (
    <section
      data-testid="dsh-lobby"
      className="sidebar-scroll h-full overflow-y-auto px-8 py-8"
    >
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-maple text-[10px] tracking-[0.22em] text-text-faint uppercase">
            {strings.dsh.lobbyLabel}
          </p>
          <h1 className="mt-1 font-pingfang text-[22px] font-semibold text-text-primary">
            {strings.dsh.lobbyTitle}
          </h1>
          <p className="mt-1 font-pingfang text-[12px] text-text-muted">
            {strings.dsh.lobbyHint}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="dsh-lobby-refresh"
            onClick={() => void reload()}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 font-pingfang text-[11px] text-text-faint hover:bg-surface-strong hover:text-text-secondary"
          >
            <RefreshCw className={`size-3 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.75} />
            {strings.dsh.refresh}
          </button>
          <button
            type="button"
            data-testid="dsh-lobby-settings"
            onClick={onOpenSettings}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 font-pingfang text-[11px] text-text-faint hover:bg-surface-strong hover:text-text-secondary"
          >
            <Settings2 className="size-3" strokeWidth={1.75} />
            {strings.dsh.settings}
          </button>
          <button
            type="button"
            data-testid="dsh-lobby-new"
            disabled={creating}
            onClick={() => void createInWorkspace()}
            className="inline-flex items-center gap-1 rounded-lg bg-surface-strong px-3 py-1.5 font-pingfang text-[12px] font-medium text-text-primary hover:bg-control-active disabled:opacity-60"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
            {strings.dsh.newSession}
          </button>
        </div>
      </header>

      {error && (
        <p
          data-testid="dsh-lobby-error"
          className="mb-4 rounded-lg bg-surface-strong px-3 py-2 font-pingfang text-[12px] text-status-error"
        >
          {error}
        </p>
      )}

      {loading && groups.length === 0 ? (
        <p className="font-pingfang text-[12px] text-text-faint">{strings.dsh.loading}</p>
      ) : groups.every((group) => group.sessions.length === 0) ? (
        <div
          data-testid="dsh-lobby-empty"
          className="rounded-xl border border-border-subtle px-5 py-8 text-center"
        >
          <p className="font-pingfang text-[13px] text-text-secondary">
            {strings.dsh.emptyTitle}
          </p>
          <p className="mt-1 font-pingfang text-[12px] text-text-faint">
            {strings.dsh.emptyHint}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section
              key={group.workspace?.workspaceId ?? 'ungrouped'}
              data-testid="dsh-lobby-workspace"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate font-pingfang text-[13px] font-semibold text-text-secondary">
                    {group.workspace?.title ?? strings.dsh.ungrouped}
                  </h2>
                  {group.workspace && (
                    <p className="truncate font-maple text-[10px] text-text-faint">
                      {group.workspace.path}
                    </p>
                  )}
                </div>
                {group.workspace && (
                  <button
                    type="button"
                    data-testid="dsh-lobby-workspace-new"
                    disabled={creating}
                    onClick={() => void createInWorkspace(group.workspace ?? undefined)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-pingfang text-[11px] text-text-faint hover:bg-surface-strong hover:text-text-secondary"
                  >
                    <FolderOpen className="size-3" strokeWidth={1.75} />
                    {strings.dsh.newInWorkspace}
                  </button>
                )}
              </div>
              <ul className="divide-y divide-border-faint rounded-xl border border-border-subtle">
                {group.sessions.length === 0 ? (
                  <li className="px-3 py-3 font-pingfang text-[11px] text-text-faint">
                    {strings.dsh.emptyWorkspace}
                  </li>
                ) : (
                  group.sessions.map((session) => {
                    const status = session.running ? 'working' : 'idle'
                    return (
                      <li key={session.sessionId}>
                        <button
                          type="button"
                          data-testid="dsh-lobby-session"
                          data-session-id={session.sessionId}
                          onClick={() => onOpenSession(session.sessionId)}
                          className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-strong"
                        >
                          <span className={`size-1.5 rounded-full ${statusDot[status]}`} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-pingfang text-[12px] font-medium text-text-primary">
                              {sessionTitleOf(session)}
                            </span>
                            <span className={`block truncate font-pingfang text-[11px] ${statusTone[status]}`}>
                              {session.agentPreset ?? statusLabel(status)}
                            </span>
                          </span>
                          {session.blank && (
                            <span className="rounded bg-control px-1.5 py-0.5 font-maple text-[9px] text-text-faint">
                              {strings.dsh.blank}
                            </span>
                          )}
                        </button>
                      </li>
                    )
                  })
                )}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * dsh wire 的轻量 RPC 客户端。lobby / 投影订阅走这里，不依赖官方
 * AbstractApiClient（npm 产物是 CJS banner，不能当普通 ESM 用）。
 */

export interface DshRpcSuccess<T> {
  ok: true
  value: T
}

export interface DshRpcFailure {
  ok: false
  error: { code: string; message: string }
}

export type DshRpcResult<T> = DshRpcSuccess<T> | DshRpcFailure

export interface DshSessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  origin?: string
  cwd?: string
  agentPreset?: string
  projections?: {
    asOfSeq: number
    values?: Record<string, unknown>
  }
}

export interface DshWorkspaceView {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

export interface DshWorkspaceList {
  items: DshWorkspaceView[]
  archivedSessionIds: string[]
}

export interface DshSessionCreateValue {
  sessionId: string
  agentPreset?: string
}

interface ServerResponseEnvelope {
  type?: string
  rpcId?: string
  result?: {
    ok?: boolean
    value?: unknown
    error?: { code?: string; message?: string }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

export async function dshRpc<T>(
  method: string,
  payload: unknown = {}
): Promise<DshRpcResult<T>> {
  const rpcId = crypto.randomUUID()
  const response = await window.dshWireApi.fetch({
    requestId: rpcId,
    method: 'POST',
    path: `/api/${method}`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method,
      payload
    })
  })
  if (response.status !== 200) {
    return {
      ok: false,
      error: {
        code: 'transport',
        message: `${method} HTTP ${response.status}`
      }
    }
  }
  let envelope: ServerResponseEnvelope
  try {
    envelope = JSON.parse(response.body) as ServerResponseEnvelope
  } catch {
    return {
      ok: false,
      error: { code: 'transport', message: `${method} returned non-JSON` }
    }
  }
  const result = envelope.result
  if (!result || typeof result.ok !== 'boolean') {
    return {
      ok: false,
      error: { code: 'transport', message: `${method} missing result` }
    }
  }
  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: result.error?.code ?? 'internal',
        message: result.error?.message ?? `${method} failed`
      }
    }
  }
  return { ok: true, value: result.value as T }
}

export function sessionTitleOf(session: DshSessionSummary): string {
  const values = session.projections?.values
  const title = values?.['title']
  if (typeof title === 'string' && title.trim().length > 0) return title.trim()
  if (session.cwd) {
    const base = session.cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
    if (base) return base
  }
  return session.sessionId
}

export function parseSessionList(value: unknown): DshSessionSummary[] {
  const record = asRecord(value)
  const items = record?.['items']
  if (!Array.isArray(items)) return []
  return items.flatMap((item) => {
    const row = asRecord(item)
    if (!row || typeof row.sessionId !== 'string') return []
    const projections = asRecord(row.projections)
    return [
      {
        sessionId: row.sessionId,
        updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
        running: row.running === true,
        blank: row.blank === true,
        parentSessionId:
          typeof row.parentSessionId === 'string' ? row.parentSessionId : undefined,
        origin: typeof row.origin === 'string' ? row.origin : undefined,
        cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
        agentPreset:
          typeof row.agentPreset === 'string' ? row.agentPreset : undefined,
        projections: projections
          ? {
              asOfSeq:
                typeof projections.asOfSeq === 'number' ? projections.asOfSeq : 0,
              values: asRecord(projections.values) ?? undefined
            }
          : undefined
      }
    ]
  })
}

export function parseWorkspaceList(value: unknown): DshWorkspaceList {
  const record = asRecord(value)
  const items = Array.isArray(record?.['items']) ? record['items'] : []
  const archived = Array.isArray(record?.['archivedSessionIds'])
    ? record['archivedSessionIds']
    : []
  return {
    items: items.flatMap((item) => {
      const row = asRecord(item)
      if (
        !row ||
        typeof row.workspaceId !== 'string' ||
        typeof row.path !== 'string' ||
        typeof row.title !== 'string' ||
        !Array.isArray(row.sessionIds)
      ) {
        return []
      }
      return [
        {
          workspaceId: row.workspaceId,
          path: row.path,
          title: row.title,
          sessionIds: row.sessionIds.filter(
            (id): id is string => typeof id === 'string'
          ),
          createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
          updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : ''
        }
      ]
    }),
    archivedSessionIds: archived.filter(
      (id): id is string => typeof id === 'string'
    )
  }
}

export async function listDshSessions(): Promise<DshSessionSummary[]> {
  const result = await dshRpc<unknown>('session.list', {})
  if (!result.ok) throw new Error(result.error.message)
  return parseSessionList(result.value)
}

export async function listDshWorkspaces(): Promise<DshWorkspaceList> {
  const result = await dshRpc<unknown>('workspace.list', {})
  if (!result.ok) throw new Error(result.error.message)
  return parseWorkspaceList(result.value)
}

export async function createDshWorkspace(
  path: string
): Promise<DshWorkspaceView> {
  const result = await dshRpc<{ workspace?: unknown; created?: boolean }>(
    'workspace.create',
    { path }
  )
  if (!result.ok) throw new Error(result.error.message)
  const parsed = parseWorkspaceList({ items: [result.value.workspace] }).items[0]
  if (!parsed) throw new Error('workspace.create returned no workspace')
  return parsed
}

export async function createDshSession(input: {
  workspaceId?: string
  cwd?: string
}): Promise<DshSessionCreateValue> {
  const result = await dshRpc<DshSessionCreateValue>('session.create', input)
  if (!result.ok) throw new Error(result.error.message)
  if (typeof result.value.sessionId !== 'string') {
    throw new Error('session.create returned no sessionId')
  }
  return result.value
}

export async function renameDshSession(
  sessionId: string,
  title: string
): Promise<void> {
  const result = await dshRpc('session.rename', { sessionId, title })
  if (!result.ok) throw new Error(result.error.message)
}

export async function archiveDshSession(sessionId: string): Promise<void> {
  const result = await dshRpc('workspace.archiveSession', { sessionId })
  if (!result.ok) throw new Error(result.error.message)
}

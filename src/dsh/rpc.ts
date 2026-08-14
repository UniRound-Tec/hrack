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

/** Typert Remote: POST /api/<ns>/<method> with payload `{ args }`. */
export async function dshRemote<T>(
  endpoint: `${string}/${string}`,
  args: Record<string, unknown> = {}
): Promise<DshRpcResult<T>> {
  return dshRpc<T>(endpoint, { args })
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

export interface DshAgentPreset {
  id: string
  trust: 'system' | 'user'
  isDefault: boolean
  name?: string
  description?: string
  broken?: string
}

export interface DshModelGroup {
  id: string
  name: string
  models: Array<{ id: string; name: string }>
}

export interface DshProvider {
  provider: string
  displayName: string
  active: boolean
  settingsNs: string
  settingsPath: string[]
  declared?: boolean
}

export interface DshSettingsNamespace {
  ns: string
  applies: 'live' | 'restart'
  revision: number
  value: Record<string, unknown>
  user: Record<string, unknown>
  base: Record<string, unknown>
  schema: unknown
  secrets: Array<{ path: string[]; set: boolean }>
}

export interface DshSettingsDescribe {
  writable: boolean
  hasDocument: boolean
  namespaces: DshSettingsNamespace[]
}

export interface DshAgentPresetList {
  presets: DshAgentPreset[]
  authorable: boolean
  hasDocument: boolean
}

function parseAgentPreset(item: unknown): DshAgentPreset | null {
  const row = asRecord(item)
  if (!row || typeof row.id !== 'string') return null
  return {
    id: row.id,
    trust: row.trust === 'user' ? 'user' : 'system',
    isDefault: row.isDefault === true,
    name: typeof row.name === 'string' ? row.name : undefined,
    description:
      typeof row.description === 'string' ? row.description : undefined,
    broken: typeof row.broken === 'string' ? row.broken : undefined
  }
}

export async function listDshAgentPresets(): Promise<DshAgentPresetList> {
  const result = await dshRpc<{
    presets?: unknown
    authorable?: boolean
    hasDocument?: boolean
  }>('agentPreset.list', {})
  if (!result.ok) throw new Error(result.error.message)
  const presets = Array.isArray(result.value.presets) ? result.value.presets : []
  return {
    presets: presets.flatMap((item) => {
      const parsed = parseAgentPreset(item)
      return parsed ? [parsed] : []
    }),
    authorable: result.value.authorable === true,
    hasDocument: result.value.hasDocument === true
  }
}

export async function setDefaultDshAgentPreset(id: string): Promise<void> {
  const result = await dshRpc('settings.update', {
    ns: 'agent-presets',
    patch: { default: id }
  })
  if (!result.ok) throw new Error(result.error.message)
}

export async function copyDshAgentPreset(input: {
  from: string
  id: string
  name?: string
}): Promise<void> {
  const result = await dshRpc('agentPreset.copy', {
    from: input.from,
    agentPreset: input.id,
    ...(input.name ? { name: input.name } : {})
  })
  if (!result.ok) throw new Error(result.error.message)
}

export async function removeDshAgentPreset(id: string): Promise<void> {
  const result = await dshRpc('agentPreset.remove', { agentPreset: id })
  if (!result.ok) throw new Error(result.error.message)
}

export async function readDshAgentPreset(
  id: string
): Promise<{ content: string; name?: string }> {
  const result = await dshRpc<{ content?: unknown; name?: unknown }>(
    'agentPreset.read',
    { agentPreset: id }
  )
  if (!result.ok) throw new Error(result.error.message)
  return {
    content:
      typeof result.value.content === 'string' ? result.value.content : '',
    name: typeof result.value.name === 'string' ? result.value.name : undefined
  }
}

export async function openDshAgentPreset(id: string): Promise<string | null> {
  const result = await dshRpc<{ opened?: boolean; path?: string }>(
    'agentPreset.openDocument',
    { agentPreset: id }
  )
  if (!result.ok) throw new Error(result.error.message)
  if (result.value.opened === true) return null
  return typeof result.value.path === 'string' ? result.value.path : null
}

export async function mutateDshSettings(input: {
  ns: string
  ops: Array<{ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }>
  expectedRevision?: number
}): Promise<void> {
  const result = await dshRpc('settings.mutate', input)
  if (!result.ok) throw new Error(result.error.message)
}

export async function listDshModelGroups(): Promise<DshModelGroup[]> {
  const result = await dshRpc<{ groups?: unknown }>('llm.models', {})
  if (!result.ok) throw new Error(result.error.message)
  const groups = result.value.groups
  if (!Array.isArray(groups)) return []
  return groups.flatMap((item) => {
    const row = asRecord(item)
    if (!row || typeof row.id !== 'string' || typeof row.name !== 'string') {
      return []
    }
    const models = Array.isArray(row.models) ? row.models : []
    return [
      {
        id: row.id,
        name: row.name,
        models: models.flatMap((model) => {
          const entry = asRecord(model)
          if (!entry || typeof entry.id !== 'string') return []
          return [
            {
              id: entry.id,
              name: typeof entry.name === 'string' ? entry.name : entry.id
            }
          ]
        })
      }
    ]
  })
}

export async function listDshProviders(): Promise<DshProvider[]> {
  const result = await dshRpc<{ providers?: unknown }>('llm.providers', {})
  if (!result.ok) throw new Error(result.error.message)
  const providers = result.value.providers
  if (!Array.isArray(providers)) return []
  return providers.flatMap((item) => {
    const row = asRecord(item)
    if (!row || typeof row.provider !== 'string') return []
    const settingsNs =
      typeof row.settingsNs === 'string'
        ? row.settingsNs
        : typeof row.settings_ns === 'string'
          ? row.settings_ns
          : ''
    const rawPath = Array.isArray(row.settingsPath)
      ? row.settingsPath
      : Array.isArray(row.settings_path)
        ? row.settings_path
        : null
    const settingsPath = rawPath
      ? rawPath.filter((part): part is string => typeof part === 'string')
      : settingsNs === 'llm-pi-ai'
        ? ['providers', row.provider]
        : []
    return [
      {
        provider: row.provider,
        displayName:
          typeof row.displayName === 'string' && row.displayName.trim()
            ? row.displayName
            : row.provider,
        active: row.active === true,
        settingsNs,
        settingsPath,
        declared: row.declared === true ? true : undefined
      }
    ]
  })
}

export async function describeDshSettings(): Promise<DshSettingsDescribe> {
  const result = await dshRpc<{
    writable?: boolean
    hasDocument?: boolean
    namespaces?: unknown
  }>('settings.describe', {})
  if (!result.ok) throw new Error(result.error.message)
  const namespaces = Array.isArray(result.value.namespaces)
    ? result.value.namespaces
    : []
  return {
    writable: result.value.writable === true,
    hasDocument: result.value.hasDocument === true,
    namespaces: namespaces.flatMap((item) => {
      const row = asRecord(item)
      if (!row || typeof row.ns !== 'string') return []
      const secrets = Array.isArray(row.secrets) ? row.secrets : []
      return [
        {
          ns: row.ns,
          applies: row.applies === 'restart' ? 'restart' : 'live',
          revision: typeof row.revision === 'number' ? row.revision : 0,
          value: asRecord(row.value) ?? {},
          user: asRecord(row.user) ?? {},
          base: asRecord(row.base) ?? {},
          schema: row.schema,
          secrets: secrets.flatMap((secret) => {
            const slot = asRecord(secret)
            if (!slot || !Array.isArray(slot.path)) return []
            return [
              {
                path: slot.path.filter(
                  (part): part is string => typeof part === 'string'
                ),
                set: slot.set === true
              }
            ]
          })
        }
      ]
    })
  }
}

export async function openDshSettingsDocument(): Promise<void> {
  const result = await dshRpc('settings.openDocument', {})
  if (!result.ok) throw new Error(result.error.message)
}

export interface DshCredentialView {
  configured: boolean
  writable: boolean
  source?: string
}

export async function describeDshCredentials(
  refs: string[]
): Promise<Record<string, DshCredentialView>> {
  if (refs.length === 0) return {}
  const result = await dshRpc<{
    credentials?: Record<string, { configured?: boolean; writable?: boolean; source?: string }>
  }>('credentials.describe', { refs })
  if (!result.ok) throw new Error(result.error.message)
  const mapped: Record<string, DshCredentialView> = {}
  for (const [ref, view] of Object.entries(result.value.credentials ?? {})) {
    mapped[ref] = {
      configured: view.configured === true,
      writable: view.writable !== false,
      source: typeof view.source === 'string' ? view.source : undefined
    }
  }
  return mapped
}

export async function describeDshCredential(
  ref: string
): Promise<DshCredentialView> {
  return (
    (await describeDshCredentials([ref]))[ref] ?? {
      configured: false,
      writable: true
    }
  )
}

export type DshPluginFiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

export interface DshPluginInventoryEntry {
  entryId: string
  moduleName: string
  enabled: boolean
  fiberPhase: DshPluginFiberPhase
}

export async function listDshPluginInventory(): Promise<DshPluginInventoryEntry[]> {
  const result = await dshRemote<{ entries?: unknown }>('pluginInventory/list')
  if (!result.ok) throw new Error(result.error.message)
  const entries = Array.isArray(result.value.entries) ? result.value.entries : []
  return entries.flatMap((item) => {
    const row = asRecord(item)
    if (!row || typeof row.entryId !== 'string' || typeof row.moduleName !== 'string') {
      return []
    }
    const phase = row.fiberPhase
    const fiberPhase: DshPluginFiberPhase =
      phase === 'pending' ||
      phase === 'loading' ||
      phase === 'active' ||
      phase === 'failed' ||
      phase === 'unloading'
        ? phase
        : null
    return [
      {
        entryId: row.entryId,
        moduleName: row.moduleName,
        enabled: row.enabled !== false,
        fiberPhase
      }
    ]
  })
}

export async function setDshCredential(
  ref: string,
  value: string
): Promise<void> {
  const result = await dshRpc('credentials.set', { ref, value })
  if (!result.ok) throw new Error(result.error.message)
}

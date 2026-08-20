/**
 * HRack 远程控制协议（SPEC-REMOTE §6）。
 *
 * 权威形状与纯函数：报文守卫、加入 URL 解析、1:1:1 座位。不上网。
 * 中继与 App 同期复制本文件；抽出独立包不是开门条件。
 */

export const REMOTE_PROTOCOL_VERSION = 1 as const
export type RemoteProtocolVersion = typeof REMOTE_PROTOCOL_VERSION

export const REMOTE_PROTOCOL_LIMITS = {
  frameBytes: 1_048_576,
  idChars: 128,
  detailChars: 4_096,
  workspaceChars: 32_768,
  args: 128,
  argChars: 4_096,
  sessions: 1_024,
  launchable: 256,
  installations: 256,
  historyEvents: 20_000,
  ptyChunkBytes: 256 * 1_024,
  ptyAckBytes: 16 * 1_024 * 1_024,
  terminalDimension: 10_000
} as const

export type RemoteParseResult<T, E extends string = string> =
  | { ok: true; value: T }
  | { ok: false; reason: E }

export type RemoteJoinUrlError =
  | 'invalid-url'
  | 'invalid-scheme'
  | 'insecure-remote'
  | 'invalid-room'
  | 'missing-room'

export type RemoteRole = 'desktop' | 'phone'

export type RemoteSessionStatus =
  | 'working'
  | 'needs-you'
  | 'done'
  | 'error'
  | 'idle'
  | 'exited'

export type RemoteStatusConfidence = 'high' | 'low'

export type RemoteRuntime =
  | { kind: 'host'; platform: 'windows' | 'macos' | 'linux' }
  | { kind: 'wsl'; distro: string }

export type RemoteDriveRejectReason = 'not-found' | 'exited' | 'busy'

export type RemoteCreateRejectReason =
  | 'invalid-workspace'
  | 'installation-not-found'
  | 'launch-failed'
  | 'busy'
  | 'duplicate-mismatch'

export type RemoteUndrivenReason =
  | 'reclaim'
  | 'left'
  | 'phone-timeout'
  | 'session-exit'
  | 'desktop-offline'

export interface RemoteSession {
  sessionId: string
  name: string
  adapterId: string
  status: RemoteSessionStatus
  statusConfidence: RemoteStatusConfidence
  detail?: string
  pendingAttentionCount: number
  activeToolCount: number
  lastActivityAt: number
  workspace?: string
}

export interface RemoteLaunchable {
  definition: {
    id: string
    adapterId: string
    displayName: string
    iconId: string
  }
  skipApproval?: { label: string }
  installations: RemoteInstallation[]
}

export interface RemoteInstallation {
  id: string
  runtime: RemoteRuntime
  version?: string
}

export interface RemotePtyHistoryOutputEvent {
  sequence: number
  kind: 'output'
  data: string
  byteLength: number
}

export interface RemotePtyHistoryResizeEvent {
  sequence: number
  kind: 'resize'
  cols: number
  rows: number
}

export type RemotePtyHistoryEvent =
  | RemotePtyHistoryOutputEvent
  | RemotePtyHistoryResizeEvent

export interface RemotePtyHistorySnapshot {
  complete: boolean
  retainedOutputBytes: number
  droppedOutputBytes: number
  droppedEvents: number
  events: RemotePtyHistoryEvent[]
}

export interface RemotePeerOccupancy {
  desktop: boolean
  phone: boolean
}

export interface RemoteHello {
  v: 1
  type: 'hello'
  role: RemoteRole
  roomId: string
}

export interface RemoteHelloOk {
  v: 1
  type: 'hello-ok'
  peer: RemotePeerOccupancy
}

export interface RemotePeerJoin {
  v: 1
  type: 'peer-join'
  role: RemoteRole
}

export interface RemotePeerLeave {
  v: 1
  type: 'peer-leave'
  role: RemoteRole
}

export interface RemoteOccupied {
  v: 1
  type: 'occupied'
}

export interface RemoteBadKey {
  v: 1
  type: 'bad-key'
}

export interface RemoteRevoke {
  v: 1
  type: 'revoke'
  roomId: string
}

export interface RemoteRevoked {
  v: 1
  type: 'revoked'
}

export interface RemoteSessionsSnapshot {
  v: 1
  type: 'sessions-snapshot'
  sessions: RemoteSession[]
}

export interface RemoteSessionUpsert {
  v: 1
  type: 'session-upsert'
  session: RemoteSession
}

export interface RemoteSessionRemoved {
  v: 1
  type: 'session-removed'
  sessionId: string
}

export interface RemoteCatalog {
  v: 1
  type: 'catalog'
  launchable: RemoteLaunchable[]
  recentWorkspaces: string[]
}

export interface RemoteDriveOk {
  v: 1
  type: 'drive-ok'
  requestId: string
  sessionId: string
  cols: number
  rows: number
  history: RemotePtyHistorySnapshot
}

export interface RemoteDriveReject {
  v: 1
  type: 'drive-reject'
  requestId: string
  sessionId: string
  reason: RemoteDriveRejectReason
}

export interface RemoteUndriven {
  v: 1
  type: 'undriven'
  sessionId: string
  reason: RemoteUndrivenReason
}

export interface RemoteCreateOk {
  v: 1
  type: 'create-ok'
  requestId: string
  sessionId: string
}

export interface RemoteCreateReject {
  v: 1
  type: 'create-reject'
  requestId: string
  reason: RemoteCreateRejectReason
  detail?: string
}

export interface RemoteNotImplemented {
  v: 1
  type: 'not-implemented'
  for: string
  requestId?: string
}

export interface RemoteDrive {
  v: 1
  type: 'drive'
  requestId: string
  sessionId: string
  cols: number
  rows: number
}

export interface RemoteUndrive {
  v: 1
  type: 'undrive'
  sessionId: string
}

export interface RemoteCreate {
  v: 1
  type: 'create'
  /** 重试必须复用；桌面在房间生命周期内以它作为幂等键。 */
  requestId: string
  installationId: string
  workspace: string
  skipApproval?: boolean
  args?: string[]
}

export interface RemotePtyResize {
  v: 1
  type: 'pty-resize'
  sessionId: string
  cols: number
  rows: number
}

export interface RemotePtyOut {
  v: 1
  type: 'pty-out'
  sessionId: string
  data: string
  byteLength: number
}

export interface RemotePtyIn {
  v: 1
  type: 'pty-in'
  sessionId: string
  data: string
}

export interface RemotePtyAck {
  v: 1
  type: 'pty-ack'
  sessionId: string
  bytes: number
}

export interface RemotePtyExit {
  v: 1
  type: 'pty-exit'
  sessionId: string
  code?: number
  signal?: number
}

export type RemoteMessage =
  | RemoteHello
  | RemoteHelloOk
  | RemotePeerJoin
  | RemotePeerLeave
  | RemoteOccupied
  | RemoteBadKey
  | RemoteRevoke
  | RemoteRevoked
  | RemoteSessionsSnapshot
  | RemoteSessionUpsert
  | RemoteSessionRemoved
  | RemoteCatalog
  | RemoteDriveOk
  | RemoteDriveReject
  | RemoteUndriven
  | RemoteCreateOk
  | RemoteCreateReject
  | RemoteNotImplemented
  | RemoteDrive
  | RemoteUndrive
  | RemoteCreate
  | RemotePtyResize
  | RemotePtyOut
  | RemotePtyIn
  | RemotePtyAck
  | RemotePtyExit

export type RemoteRelayRequest = RemoteHello | RemoteRevoke
export type RemoteRelayEvent =
  | RemoteHelloOk
  | RemotePeerJoin
  | RemotePeerLeave
  | RemoteOccupied
  | RemoteBadKey
  | RemoteRevoked
export type RemoteDesktopToPhoneMessage =
  | RemoteSessionsSnapshot
  | RemoteSessionUpsert
  | RemoteSessionRemoved
  | RemoteCatalog
  | RemoteDriveOk
  | RemoteDriveReject
  | RemoteUndriven
  | RemoteCreateOk
  | RemoteCreateReject
  | RemoteNotImplemented
  | RemotePtyOut
  | RemotePtyExit
export type RemotePhoneToDesktopMessage =
  | RemoteDrive
  | RemoteUndrive
  | RemoteCreate
  | RemotePtyResize
  | RemotePtyIn
  | RemotePtyAck
export type RemoteDesktopInboundMessage =
  | RemoteRelayEvent
  | RemotePhoneToDesktopMessage

export interface JoinUrl {
  origin: string
  base: string
  roomId: string
  wsUrl: string
  href: string
}

export type SeatOwner = string | null

export type RoomRecord =
  | { status: 'open'; desktop: SeatOwner; phone: SeatOwner }
  | { status: 'revoked' }

export type RoomTable = Record<string, RoomRecord>

export interface RoomReply {
  connectionId: string
  message: RemoteMessage
}

export interface SeatOutcome {
  rooms: RoomTable
  replies: RoomReply[]
}

const SESSION_STATUSES = new Set<string>([
  'working',
  'needs-you',
  'done',
  'error',
  'idle',
  'exited'
])

const SESSION_FORBIDDEN_KEYS = new Set([
  'correlation',
  'resolvedExecutable',
  'adapterSessionId',
  'terminalId',
  'installationId',
  'observerHealth',
  'usage',
  'capabilities',
  'lastSeq',
  'activeTurnId'
])
const LAUNCHABLE_FORBIDDEN_KEYS = new Set(['hint', 'resolvedExecutable'])
const DEFINITION_FORBIDDEN_KEYS = new Set(['hint', 'resolvedExecutable'])
const INSTALLATION_FORBIDDEN_KEYS = new Set([
  'resolvedExecutable',
  'detectedVia',
  'verification',
  'definitionId'
])
const PHONE_TO_DESKTOP_TYPES = new Set<RemotePhoneToDesktopMessage['type']>([
  'drive',
  'undrive',
  'create',
  'pty-resize',
  'pty-in',
  'pty-ack'
])
const DESKTOP_TO_PHONE_TYPES = new Set<RemoteDesktopToPhoneMessage['type']>([
  'sessions-snapshot',
  'session-upsert',
  'session-removed',
  'catalog',
  'drive-ok',
  'drive-reject',
  'undriven',
  'create-ok',
  'create-reject',
  'not-implemented',
  'pty-out',
  'pty-exit'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isBoundedNonEmptyString(value: unknown, max: number): value is string {
  return isNonEmptyString(value) && value.length <= max && !value.includes('\0')
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isPosInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function isBoundedPosInt(value: unknown, max: number): value is number {
  return isPosInt(value) && value <= max
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function decodedBase64Length(value: string): number | null {
  if (value.length === 0) return 0
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    return null
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1') return true
  const match = /^(\d{1,3})(?:\.\d{1,3}){3}$/.exec(host)
  return match?.[1] === '127'
}

function isRemoteRole(value: unknown): value is RemoteRole {
  return value === 'desktop' || value === 'phone'
}

function isSessionStatus(value: unknown): value is RemoteSessionStatus {
  return typeof value === 'string' && SESSION_STATUSES.has(value)
}

function isStatusConfidence(value: unknown): value is RemoteStatusConfidence {
  return value === 'high' || value === 'low'
}

function isDriveRejectReason(value: unknown): value is RemoteDriveRejectReason {
  return value === 'not-found' || value === 'exited' || value === 'busy'
}

function isCreateRejectReason(value: unknown): value is RemoteCreateRejectReason {
  return (
    value === 'invalid-workspace' ||
    value === 'installation-not-found' ||
    value === 'launch-failed' ||
    value === 'busy' ||
    value === 'duplicate-mismatch'
  )
}

function isUndrivenReason(value: unknown): value is RemoteUndrivenReason {
  return (
    value === 'reclaim' ||
    value === 'left' ||
    value === 'phone-timeout' ||
    value === 'session-exit' ||
    value === 'desktop-offline'
  )
}

function fail<E extends string>(reason: E): { ok: false; reason: E } {
  return { ok: false, reason }
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

function otherRole(role: RemoteRole): RemoteRole {
  return role === 'desktop' ? 'phone' : 'desktop'
}

function occupancy(room: Extract<RoomRecord, { status: 'open' }>): RemotePeerOccupancy {
  return {
    desktop: room.desktop !== null,
    phone: room.phone !== null
  }
}

function originOf(url: URL): string {
  return `${url.protocol}//${url.host}`
}

/**
 * 加入 URL → origin / base / roomId / wsUrl。
 * http↔ws、https↔wss；ws/wss 保持（P1 测试中继）。短 roomId 合法。
 */
export function parseJoinUrl(
  input: string
): RemoteParseResult<JoinUrl, RemoteJoinUrlError> {
  const trimmed = input.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return fail('invalid-url')
  }

  const protocol = url.protocol
  if (
    protocol !== 'http:' &&
    protocol !== 'https:' &&
    protocol !== 'ws:' &&
    protocol !== 'wss:'
  ) {
    return fail('invalid-scheme')
  }
  if ((protocol === 'http:' || protocol === 'ws:') && !isLoopbackHost(url.hostname)) {
    return fail('insecure-remote')
  }

  let path = url.pathname
  while (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1)
  }
  const segments = path.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) return fail('missing-room')

  const roomId = segments[segments.length - 1]
  if (!roomId) return fail('missing-room')
  if (!isBoundedNonEmptyString(roomId, REMOTE_PROTOCOL_LIMITS.idChars)) {
    return fail('invalid-room')
  }
  const baseSegments = segments.slice(0, -1)
  const base = baseSegments.length === 0 ? '' : `/${baseSegments.join('/')}`
  const origin = originOf(url)
  const wsProtocol = protocol === 'https:' || protocol === 'wss:' ? 'wss:' : 'ws:'
  const wsUrl = `${wsProtocol}//${url.host}${base}/v1/ws`
  const href = `${origin}${base}/${roomId}`

  return ok({ origin, base, roomId, wsUrl, href })
}

function parseRuntime(value: unknown): RemoteRuntime | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null
  if (value.kind === 'host') {
    if (
      value.platform !== 'windows' &&
      value.platform !== 'macos' &&
      value.platform !== 'linux'
    ) {
      return null
    }
    return { kind: 'host', platform: value.platform }
  }
  if (value.kind === 'wsl') {
    if (!isNonEmptyString(value.distro)) return null
    return { kind: 'wsl', distro: value.distro }
  }
  return null
}

function parseSession(value: unknown): RemoteSession | null {
  if (!isRecord(value)) return null
  for (const key of SESSION_FORBIDDEN_KEYS) {
    if (key in value) return null
  }
  if (!isBoundedNonEmptyString(value.sessionId, REMOTE_PROTOCOL_LIMITS.idChars)) {
    return null
  }
  if (typeof value.name !== 'string' || value.name.length > 256) return null
  if (!isBoundedNonEmptyString(value.adapterId, REMOTE_PROTOCOL_LIMITS.idChars)) {
    return null
  }
  if (!isSessionStatus(value.status)) return null
  if (!isStatusConfidence(value.statusConfidence)) return null
  if (!isNonNegInt(value.pendingAttentionCount)) return null
  if (!isNonNegInt(value.activeToolCount)) return null
  if (!isNonNegInt(value.lastActivityAt)) return null
  if (
    value.detail !== undefined &&
    (typeof value.detail !== 'string' ||
      value.detail.length > REMOTE_PROTOCOL_LIMITS.detailChars)
  ) {
    return null
  }
  if (
    value.workspace !== undefined &&
    (typeof value.workspace !== 'string' ||
      value.workspace.length > REMOTE_PROTOCOL_LIMITS.workspaceChars)
  ) {
    return null
  }

  const session: RemoteSession = {
    sessionId: value.sessionId,
    name: value.name,
    adapterId: value.adapterId,
    status: value.status,
    statusConfidence: value.statusConfidence,
    pendingAttentionCount: value.pendingAttentionCount,
    activeToolCount: value.activeToolCount,
    lastActivityAt: value.lastActivityAt
  }
  if (typeof value.detail === 'string') session.detail = value.detail
  if (typeof value.workspace === 'string') session.workspace = value.workspace
  return session
}

function parseInstallation(value: unknown): RemoteInstallation | null {
  if (!isRecord(value)) return null
  for (const key of INSTALLATION_FORBIDDEN_KEYS) {
    if (key in value) return null
  }
  if (!isNonEmptyString(value.id)) return null
  const runtime = parseRuntime(value.runtime)
  if (!runtime) return null
  if (value.version !== undefined && typeof value.version !== 'string') return null
  const installation: RemoteInstallation = { id: value.id, runtime }
  if (typeof value.version === 'string') installation.version = value.version
  return installation
}

function parseLaunchable(value: unknown): RemoteLaunchable | null {
  if (!isRecord(value) || !isRecord(value.definition)) return null
  for (const key of LAUNCHABLE_FORBIDDEN_KEYS) {
    if (key in value) return null
  }
  const definition = value.definition
  for (const key of DEFINITION_FORBIDDEN_KEYS) {
    if (key in definition) return null
  }
  if (!isNonEmptyString(definition.id)) return null
  if (!isNonEmptyString(definition.adapterId)) return null
  if (typeof definition.displayName !== 'string') return null
  if (!isNonEmptyString(definition.iconId)) return null
  if (
    !Array.isArray(value.installations) ||
    value.installations.length > REMOTE_PROTOCOL_LIMITS.installations
  ) {
    return null
  }

  let skipApproval: { label: string } | undefined
  if (value.skipApproval !== undefined) {
    if (!isRecord(value.skipApproval)) return null
    if ('args' in value.skipApproval) return null
    if (typeof value.skipApproval.label !== 'string') return null
    skipApproval = { label: value.skipApproval.label }
  }

  const installations: RemoteInstallation[] = []
  for (const item of value.installations) {
    const parsed = parseInstallation(item)
    if (!parsed) return null
    installations.push(parsed)
  }

  const launchable: RemoteLaunchable = {
    definition: {
      id: definition.id,
      adapterId: definition.adapterId,
      displayName: definition.displayName,
      iconId: definition.iconId
    },
    installations
  }
  if (skipApproval) launchable.skipApproval = skipApproval
  return launchable
}

function parseHistoryEvent(value: unknown): RemotePtyHistoryEvent | null {
  if (!isRecord(value) || !isNonNegInt(value.sequence)) return null
  if (value.kind === 'output') {
    if (typeof value.data !== 'string') return null
    if (
      !isNonNegInt(value.byteLength) ||
      value.byteLength > REMOTE_PROTOCOL_LIMITS.ptyChunkBytes ||
      utf8ByteLength(value.data) !== value.byteLength
    ) {
      return null
    }
    return {
      sequence: value.sequence,
      kind: 'output',
      data: value.data,
      byteLength: value.byteLength
    }
  }
  if (value.kind === 'resize') {
    if (
      !isBoundedPosInt(value.cols, REMOTE_PROTOCOL_LIMITS.terminalDimension) ||
      !isBoundedPosInt(value.rows, REMOTE_PROTOCOL_LIMITS.terminalDimension)
    ) {
      return null
    }
    return {
      sequence: value.sequence,
      kind: 'resize',
      cols: value.cols,
      rows: value.rows
    }
  }
  return null
}

function parseHistory(value: unknown): RemotePtyHistorySnapshot | null {
  if (!isRecord(value)) return null
  if (typeof value.complete !== 'boolean') return null
  if (!isNonNegInt(value.retainedOutputBytes)) return null
  if (!isNonNegInt(value.droppedOutputBytes)) return null
  if (!isNonNegInt(value.droppedEvents)) return null
  if (
    !Array.isArray(value.events) ||
    value.events.length > REMOTE_PROTOCOL_LIMITS.historyEvents
  ) {
    return null
  }
  const events: RemotePtyHistoryEvent[] = []
  for (const item of value.events) {
    const parsed = parseHistoryEvent(item)
    if (!parsed) return null
    events.push(parsed)
  }
  return {
    complete: value.complete,
    retainedOutputBytes: value.retainedOutputBytes,
    droppedOutputBytes: value.droppedOutputBytes,
    droppedEvents: value.droppedEvents,
    events
  }
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > REMOTE_PROTOCOL_LIMITS.args) {
    return null
  }
  const items: string[] = []
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      item.length > REMOTE_PROTOCOL_LIMITS.argChars ||
      item.includes('\0')
    ) {
      return null
    }
    items.push(item)
  }
  return items
}

/**
 * 已 JSON.parse 的对象 → 报文。v 必须是数字 1。未知字段忽略；敏感字段拒绝。
 */
export function parseRemoteMessage(
  raw: unknown
): RemoteParseResult<RemoteMessage> {
  if (!isRecord(raw)) return fail('not-object')
  if (raw.v !== REMOTE_PROTOCOL_VERSION) return fail('invalid-v')
  if (typeof raw.type !== 'string') return fail('invalid-type')

  switch (raw.type) {
    case 'hello': {
      if (
        !isRemoteRole(raw.role) ||
        !isBoundedNonEmptyString(raw.roomId, REMOTE_PROTOCOL_LIMITS.idChars)
      ) {
        return fail('invalid-hello')
      }
      return ok({ v: 1, type: 'hello', role: raw.role, roomId: raw.roomId })
    }
    case 'hello-ok': {
      if (
        !isRecord(raw.peer) ||
        typeof raw.peer.desktop !== 'boolean' ||
        typeof raw.peer.phone !== 'boolean'
      ) {
        return fail('invalid-hello-ok')
      }
      return ok({
        v: 1,
        type: 'hello-ok',
        peer: { desktop: raw.peer.desktop, phone: raw.peer.phone }
      })
    }
    case 'peer-join':
    case 'peer-leave': {
      if (!isRemoteRole(raw.role)) return fail(`invalid-${raw.type}`)
      return ok({ v: 1, type: raw.type, role: raw.role })
    }
    case 'occupied':
      return ok({ v: 1, type: 'occupied' })
    case 'bad-key':
      return ok({ v: 1, type: 'bad-key' })
    case 'revoke': {
      if (!isBoundedNonEmptyString(raw.roomId, REMOTE_PROTOCOL_LIMITS.idChars)) {
        return fail('invalid-revoke')
      }
      return ok({ v: 1, type: 'revoke', roomId: raw.roomId })
    }
    case 'revoked':
      return ok({ v: 1, type: 'revoked' })
    case 'sessions-snapshot': {
      if (
        !Array.isArray(raw.sessions) ||
        raw.sessions.length > REMOTE_PROTOCOL_LIMITS.sessions
      ) {
        return fail('invalid-sessions-snapshot')
      }
      const sessions: RemoteSession[] = []
      const sessionIds = new Set<string>()
      for (const item of raw.sessions) {
        const session = parseSession(item)
        if (!session) return fail('invalid-session')
        if (sessionIds.has(session.sessionId)) return fail('duplicate-session')
        sessionIds.add(session.sessionId)
        sessions.push(session)
      }
      return ok({ v: 1, type: 'sessions-snapshot', sessions })
    }
    case 'session-upsert': {
      const session = parseSession(raw.session)
      if (!session) return fail('invalid-session')
      return ok({ v: 1, type: 'session-upsert', session })
    }
    case 'session-removed': {
      if (!isBoundedNonEmptyString(raw.sessionId, REMOTE_PROTOCOL_LIMITS.idChars)) {
        return fail('invalid-session-removed')
      }
      return ok({ v: 1, type: 'session-removed', sessionId: raw.sessionId })
    }
    case 'catalog': {
      if (
        !Array.isArray(raw.launchable) ||
        raw.launchable.length > REMOTE_PROTOCOL_LIMITS.launchable
      ) {
        return fail('invalid-catalog')
      }
      const recentWorkspaces = parseStringArray(raw.recentWorkspaces)
      if (!recentWorkspaces) return fail('invalid-catalog')
      const launchable: RemoteLaunchable[] = []
      for (const item of raw.launchable) {
        const parsed = parseLaunchable(item)
        if (!parsed) return fail('invalid-launchable')
        launchable.push(parsed)
      }
      return ok({ v: 1, type: 'catalog', launchable, recentWorkspaces })
    }
    case 'drive-ok': {
      if (
        !isBoundedNonEmptyString(raw.requestId, REMOTE_PROTOCOL_LIMITS.idChars) ||
        !isBoundedNonEmptyString(raw.sessionId, REMOTE_PROTOCOL_LIMITS.idChars)
      ) {
        return fail('invalid-drive-ok')
      }
      if (
        !isBoundedPosInt(raw.cols, REMOTE_PROTOCOL_LIMITS.terminalDimension) ||
        !isBoundedPosInt(raw.rows, REMOTE_PROTOCOL_LIMITS.terminalDimension)
      ) {
        return fail('invalid-drive-ok')
      }
      const history = parseHistory(raw.history)
      if (!history) return fail('invalid-history')
      return ok({
        v: 1,
        type: 'drive-ok',
        requestId: raw.requestId,
        sessionId: raw.sessionId,
        cols: raw.cols,
        rows: raw.rows,
        history
      })
    }
    case 'drive-reject': {
      if (
        !isBoundedNonEmptyString(raw.requestId, REMOTE_PROTOCOL_LIMITS.idChars) ||
        !isBoundedNonEmptyString(raw.sessionId, REMOTE_PROTOCOL_LIMITS.idChars) ||
        !isDriveRejectReason(raw.reason)
      ) {
        return fail('invalid-drive-reject')
      }
      return ok({
        v: 1,
        type: 'drive-reject',
        requestId: raw.requestId,
        sessionId: raw.sessionId,
        reason: raw.reason
      })
    }
    case 'undriven': {
      if (
        !isBoundedNonEmptyString(raw.sessionId, REMOTE_PROTOCOL_LIMITS.idChars) ||
        !isUndrivenReason(raw.reason)
      ) {
        return fail('invalid-undriven')
      }
      return ok({
        v: 1,
        type: 'undriven',
        sessionId: raw.sessionId,
        reason: raw.reason
      })
    }
    case 'create-ok': {
      if (
        !isBoundedNonEmptyString(raw.requestId, REMOTE_PROTOCOL_LIMITS.idChars) ||
        !isBoundedNonEmptyString(raw.sessionId, REMOTE_PROTOCOL_LIMITS.idChars)
      ) {
        return fail('invalid-create-ok')
      }
      return ok({
        v: 1,
        type: 'create-ok',
        requestId: raw.requestId,
        sessionId: raw.sessionId
      })
    }
    case 'create-reject': {
      if (
        !isBoundedNonEmptyString(raw.requestId, REMOTE_PROTOCOL_LIMITS.idChars) ||
        !isCreateRejectReason(raw.reason)
      ) {
        return fail('invalid-create-reject')
      }
      if (
        raw.detail !== undefined &&
        (typeof raw.detail !== 'string' ||
          raw.detail.length > REMOTE_PROTOCOL_LIMITS.detailChars)
      ) {
        return fail('invalid-create-reject')
      }
      const message: RemoteCreateReject = {
        v: 1,
        type: 'create-reject',
        requestId: raw.requestId,
        reason: raw.reason
      }
      if (typeof raw.detail === 'string') message.detail = raw.detail
      return ok(message)
    }
    case 'not-implemented': {
      if (!isBoundedNonEmptyString(raw.for, 64)) {
        return fail('invalid-not-implemented')
      }
      if (
        raw.requestId !== undefined &&
        !isBoundedNonEmptyString(raw.requestId, REMOTE_PROTOCOL_LIMITS.idChars)
      ) {
        return fail('invalid-not-implemented')
      }
      const message: RemoteNotImplemented = {
        v: 1,
        type: 'not-implemented',
        for: raw.for
      }
      if (typeof raw.requestId === 'string') message.requestId = raw.requestId
      return ok(message)
    }
    case 'drive': {
      if (
        !isBoundedNonEmptyString(raw.requestId, REMOTE_PROTOCOL_LIMITS.idChars) ||
        !isBoundedNonEmptyString(raw.sessionId, REMOTE_PROTOCOL_LIMITS.idChars) ||
        !isBoundedPosInt(raw.cols, REMOTE_PROTOCOL_LIMITS.terminalDimension) ||
        !isBoundedPosInt(raw.rows, REMOTE_PROTOCOL_LIMITS.terminalDimension)
      ) {
        return fail('invalid-drive')
      }
      return ok({
        v: 1,
        type: 'drive',
        requestId: raw.requestId,
        sessionId: raw.sessionId,
        cols: raw.cols,
        rows: raw.rows
      })
    }
    case 'pty-resize': {
      if (
        !isBoundedNonEmptyString(raw.sessionId, REMOTE_PROTOCOL_LIMITS.idChars) ||
        !isBoundedPosInt(raw.cols, REMOTE_PROTOCOL_LIMITS.terminalDimension) ||
        !isBoundedPosInt(raw.rows, REMOTE_PROTOCOL_LIMITS.terminalDimension)
      ) {
        return fail('invalid-pty-resize')
      }
      return ok({
        v: 1,
        type: 'pty-resize',
        sessionId: raw.sessionId,
        cols: raw.cols,
        rows: raw.rows
      })
    }
    case 'undrive': {
      if (!isBoundedNonEmptyString(raw.sessionId, REMOTE_PROTOCOL_LIMITS.idChars)) {
        return fail('invalid-undrive')
      }
      return ok({ v: 1, type: 'undrive', sessionId: raw.sessionId })
    }
    case 'create': {
      if (
        !isBoundedNonEmptyString(raw.requestId, REMOTE_PROTOCOL_LIMITS.idChars) ||
        !isBoundedNonEmptyString(raw.installationId, REMOTE_PROTOCOL_LIMITS.idChars)
      ) {
        return fail('invalid-create')
      }
      if (
        typeof raw.workspace !== 'string' ||
        raw.workspace.trim().length === 0 ||
        raw.workspace.length > REMOTE_PROTOCOL_LIMITS.workspaceChars ||
        raw.workspace.includes('\0')
      ) {
        return fail('invalid-create')
      }
      if (
        raw.skipApproval !== undefined &&
        typeof raw.skipApproval !== 'boolean'
      ) {
        return fail('invalid-create')
      }
      const args = raw.args === undefined ? undefined : parseStringArray(raw.args)
      if (raw.args !== undefined && !args) return fail('invalid-create')
      const message: RemoteCreate = {
        v: 1,
        type: 'create',
        requestId: raw.requestId,
        installationId: raw.installationId,
        workspace: raw.workspace
      }
      if (typeof raw.skipApproval === 'boolean') {
        message.skipApproval = raw.skipApproval
      }
      if (args) message.args = args
      return ok(message)
    }
    case 'pty-out': {
      const decodedLength =
        typeof raw.data === 'string' ? decodedBase64Length(raw.data) : null
      if (
        !isBoundedNonEmptyString(raw.sessionId, REMOTE_PROTOCOL_LIMITS.idChars) ||
        typeof raw.data !== 'string' ||
        decodedLength === null ||
        !isNonNegInt(raw.byteLength) ||
        raw.byteLength > REMOTE_PROTOCOL_LIMITS.ptyChunkBytes ||
        decodedLength !== raw.byteLength
      ) {
        return fail('invalid-pty-out')
      }
      return ok({
        v: 1,
        type: 'pty-out',
        sessionId: raw.sessionId,
        data: raw.data,
        byteLength: raw.byteLength
      })
    }
    case 'pty-in': {
      if (
        !isBoundedNonEmptyString(raw.sessionId, REMOTE_PROTOCOL_LIMITS.idChars) ||
        typeof raw.data !== 'string' ||
        utf8ByteLength(raw.data) > REMOTE_PROTOCOL_LIMITS.ptyChunkBytes
      ) {
        return fail('invalid-pty-in')
      }
      return ok({
        v: 1,
        type: 'pty-in',
        sessionId: raw.sessionId,
        data: raw.data
      })
    }
    case 'pty-ack': {
      if (
        !isBoundedNonEmptyString(raw.sessionId, REMOTE_PROTOCOL_LIMITS.idChars) ||
        !isNonNegInt(raw.bytes) ||
        raw.bytes > REMOTE_PROTOCOL_LIMITS.ptyAckBytes
      ) {
        return fail('invalid-pty-ack')
      }
      return ok({
        v: 1,
        type: 'pty-ack',
        sessionId: raw.sessionId,
        bytes: raw.bytes
      })
    }
    case 'pty-exit': {
      if (!isBoundedNonEmptyString(raw.sessionId, REMOTE_PROTOCOL_LIMITS.idChars)) {
        return fail('invalid-pty-exit')
      }
      if (raw.code !== undefined && !Number.isInteger(raw.code)) {
        return fail('invalid-pty-exit')
      }
      if (raw.signal !== undefined && !Number.isInteger(raw.signal)) {
        return fail('invalid-pty-exit')
      }
      const message: RemotePtyExit = {
        v: 1,
        type: 'pty-exit',
        sessionId: raw.sessionId
      }
      if (typeof raw.code === 'number') message.code = raw.code
      if (typeof raw.signal === 'number') message.signal = raw.signal
      return ok(message)
    }
    default:
      return fail('unknown-type')
  }
}

/** 文本 WebSocket 帧的唯一解析入口；在 JSON.parse 前先限制内存。 */
export function parseRemoteFrame(text: string): RemoteParseResult<RemoteMessage> {
  if (
    text.length > REMOTE_PROTOCOL_LIMITS.frameBytes ||
    utf8ByteLength(text) > REMOTE_PROTOCOL_LIMITS.frameBytes
  ) {
    return fail('frame-too-large')
  }
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    return fail('invalid-json')
  }
  return parseRemoteMessage(raw)
}

export function isRemotePhoneToDesktopMessage(
  message: RemoteMessage
): message is RemotePhoneToDesktopMessage {
  return PHONE_TO_DESKTOP_TYPES.has(message.type as RemotePhoneToDesktopMessage['type'])
}

export function isRemoteDesktopToPhoneMessage(
  message: RemoteMessage
): message is RemoteDesktopToPhoneMessage {
  return DESKTOP_TO_PHONE_TYPES.has(
    message.type as RemoteDesktopToPhoneMessage['type']
  )
}

export function emptyRooms(): RoomTable {
  return {}
}

/** 开放空座。已存在（含已吊销）的 id 原样返回，不复活。 */
export function openRoom(rooms: RoomTable, roomId: string): RoomTable {
  if (rooms[roomId]) return rooms
  return {
    ...rooms,
    [roomId]: { status: 'open', desktop: null, phone: null }
  }
}

export function hello(
  rooms: RoomTable,
  input: { roomId: string; role: RemoteRole; connectionId: string }
): SeatOutcome {
  const room = rooms[input.roomId]
  if (!room || room.status === 'revoked') {
    return {
      rooms,
      replies: [
        { connectionId: input.connectionId, message: { v: 1, type: 'bad-key' } }
      ]
    }
  }

  const existingSeats: Array<{ roomId: string; role: RemoteRole }> = []
  for (const [existingRoomId, existingRoom] of Object.entries(rooms)) {
    if (existingRoom.status !== 'open') continue
    for (const existingRole of ['desktop', 'phone'] as const) {
      if (existingRoom[existingRole] !== input.connectionId) continue
      existingSeats.push({ roomId: existingRoomId, role: existingRole })
    }
  }
  const repeatsExistingHello =
    existingSeats.length === 1 &&
    existingSeats[0].roomId === input.roomId &&
    existingSeats[0].role === input.role
  if (existingSeats.length > 0 && !repeatsExistingHello) {
    return {
      rooms,
      replies: [
        { connectionId: input.connectionId, message: { v: 1, type: 'occupied' } }
      ]
    }
  }

  const occupant = room[input.role]
  if (occupant !== null && occupant !== input.connectionId) {
    return {
      rooms,
      replies: [
        { connectionId: input.connectionId, message: { v: 1, type: 'occupied' } }
      ]
    }
  }

  const seated = occupant === input.connectionId
  const nextRoom = seated
    ? room
    : { ...room, [input.role]: input.connectionId }
  const nextRooms = seated ? rooms : { ...rooms, [input.roomId]: nextRoom }
  const replies: RoomReply[] = [
    {
      connectionId: input.connectionId,
      message: { v: 1, type: 'hello-ok', peer: occupancy(nextRoom) }
    }
  ]

  if (!seated) {
    const peerId = nextRoom[otherRole(input.role)]
    if (peerId !== null) {
      replies.push({
        connectionId: peerId,
        message: { v: 1, type: 'peer-join', role: input.role }
      })
    }
  }

  return { rooms: nextRooms, replies }
}

export function disconnect(
  rooms: RoomTable,
  connectionId: string
): SeatOutcome {
  let nextRooms = rooms
  const replies: RoomReply[] = []
  for (const [roomId, room] of Object.entries(rooms)) {
    if (room.status !== 'open') continue
    let nextRoom = room
    let changed = false
    for (const role of ['desktop', 'phone'] as const) {
      if (room[role] !== connectionId) continue
      nextRoom = { ...nextRoom, [role]: null }
      changed = true
      const peerId = room[otherRole(role)]
      if (peerId !== null && peerId !== connectionId) {
        replies.push({
          connectionId: peerId,
          message: { v: 1, type: 'peer-leave', role }
        })
      }
    }
    if (changed) nextRooms = { ...nextRooms, [roomId]: nextRoom }
  }
  return { rooms: nextRooms, replies }
}

export function revoke(rooms: RoomTable, roomId: string): SeatOutcome {
  const room = rooms[roomId]
  if (!room) {
    return {
      rooms: { ...rooms, [roomId]: { status: 'revoked' } },
      replies: []
    }
  }
  if (room.status === 'revoked') return { rooms, replies: [] }

  const message: RemoteRevoked = { v: 1, type: 'revoked' }
  const replies: RoomReply[] = []
  if (room.desktop !== null) {
    replies.push({ connectionId: room.desktop, message })
  }
  if (room.phone !== null) {
    replies.push({ connectionId: room.phone, message })
  }
  return {
    rooms: { ...rooms, [roomId]: { status: 'revoked' } },
    replies
  }
}

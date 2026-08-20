/**
 * HRack 远程控制协议（SPEC-REMOTE §6）。
 *
 * 权威形状与纯函数：报文守卫、加入 URL 解析、1:1:1 座位。不上网。
 * 中继与 App 同期复制本文件；抽出独立包不是开门条件。
 */

export const REMOTE_PROTOCOL_VERSION = 1 as const
export type RemoteProtocolVersion = typeof REMOTE_PROTOCOL_VERSION

export type RemoteParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string }

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
  sessionId: string
  cols: number
  rows: number
  history: RemotePtyHistorySnapshot
}

export interface RemoteDriveReject {
  v: 1
  type: 'drive-reject'
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
  sessionId: string
}

export interface RemoteCreateReject {
  v: 1
  type: 'create-reject'
  reason: string
  detail?: string
}

export interface RemoteNotImplemented {
  v: 1
  type: 'not-implemented'
  for: string
}

export interface RemoteDrive {
  v: 1
  type: 'drive'
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

const SESSION_FORBIDDEN_KEYS = new Set(['correlation', 'resolvedExecutable'])
const INSTALLATION_FORBIDDEN_KEYS = new Set(['resolvedExecutable'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
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

function isUndrivenReason(value: unknown): value is RemoteUndrivenReason {
  return (
    value === 'reclaim' ||
    value === 'left' ||
    value === 'phone-timeout' ||
    value === 'session-exit' ||
    value === 'desktop-offline'
  )
}

function fail(reason: string): { ok: false; reason: string } {
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
export function parseJoinUrl(input: string): RemoteParseResult<JoinUrl> {
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

  let path = url.pathname
  while (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1)
  }
  const segments = path.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) return fail('missing-room')

  const roomId = segments[segments.length - 1]
  if (!roomId) return fail('missing-room')
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
  if (!isNonEmptyString(value.sessionId)) return null
  if (typeof value.name !== 'string') return null
  if (!isNonEmptyString(value.adapterId)) return null
  if (!isSessionStatus(value.status)) return null
  if (!isStatusConfidence(value.statusConfidence)) return null
  if (!isNonNegInt(value.pendingAttentionCount)) return null
  if (!isNonNegInt(value.activeToolCount)) return null
  if (!isFiniteNumber(value.lastActivityAt)) return null
  if (value.detail !== undefined && typeof value.detail !== 'string') return null
  if (value.workspace !== undefined && typeof value.workspace !== 'string') {
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
  const definition = value.definition
  if (!isNonEmptyString(definition.id)) return null
  if (!isNonEmptyString(definition.adapterId)) return null
  if (typeof definition.displayName !== 'string') return null
  if (!isNonEmptyString(definition.iconId)) return null
  if (!Array.isArray(value.installations)) return null

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
    if (!isNonNegInt(value.byteLength)) return null
    return {
      sequence: value.sequence,
      kind: 'output',
      data: value.data,
      byteLength: value.byteLength
    }
  }
  if (value.kind === 'resize') {
    if (!isPosInt(value.cols) || !isPosInt(value.rows)) return null
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
  if (!Array.isArray(value.events)) return null
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
  if (!Array.isArray(value)) return null
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
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
      if (!isRemoteRole(raw.role) || !isNonEmptyString(raw.roomId)) {
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
      if (!isNonEmptyString(raw.roomId)) return fail('invalid-revoke')
      return ok({ v: 1, type: 'revoke', roomId: raw.roomId })
    }
    case 'revoked':
      return ok({ v: 1, type: 'revoked' })
    case 'sessions-snapshot': {
      if (!Array.isArray(raw.sessions)) return fail('invalid-sessions-snapshot')
      const sessions: RemoteSession[] = []
      for (const item of raw.sessions) {
        const session = parseSession(item)
        if (!session) return fail('invalid-session')
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
      if (!isNonEmptyString(raw.sessionId)) return fail('invalid-session-removed')
      return ok({ v: 1, type: 'session-removed', sessionId: raw.sessionId })
    }
    case 'catalog': {
      if (!Array.isArray(raw.launchable)) return fail('invalid-catalog')
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
      if (!isNonEmptyString(raw.sessionId)) return fail('invalid-drive-ok')
      if (!isPosInt(raw.cols) || !isPosInt(raw.rows)) return fail('invalid-drive-ok')
      const history = parseHistory(raw.history)
      if (!history) return fail('invalid-history')
      return ok({
        v: 1,
        type: 'drive-ok',
        sessionId: raw.sessionId,
        cols: raw.cols,
        rows: raw.rows,
        history
      })
    }
    case 'drive-reject': {
      if (!isDriveRejectReason(raw.reason)) return fail('invalid-drive-reject')
      return ok({ v: 1, type: 'drive-reject', reason: raw.reason })
    }
    case 'undriven': {
      if (!isNonEmptyString(raw.sessionId) || !isUndrivenReason(raw.reason)) {
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
      if (!isNonEmptyString(raw.sessionId)) return fail('invalid-create-ok')
      return ok({ v: 1, type: 'create-ok', sessionId: raw.sessionId })
    }
    case 'create-reject': {
      if (typeof raw.reason !== 'string') return fail('invalid-create-reject')
      if (raw.detail !== undefined && typeof raw.detail !== 'string') {
        return fail('invalid-create-reject')
      }
      const message: RemoteCreateReject = {
        v: 1,
        type: 'create-reject',
        reason: raw.reason
      }
      if (typeof raw.detail === 'string') message.detail = raw.detail
      return ok(message)
    }
    case 'not-implemented': {
      if (typeof raw.for !== 'string') return fail('invalid-not-implemented')
      return ok({ v: 1, type: 'not-implemented', for: raw.for })
    }
    case 'drive':
    case 'pty-resize': {
      if (
        !isNonEmptyString(raw.sessionId) ||
        !isPosInt(raw.cols) ||
        !isPosInt(raw.rows)
      ) {
        return fail(`invalid-${raw.type}`)
      }
      return ok({
        v: 1,
        type: raw.type,
        sessionId: raw.sessionId,
        cols: raw.cols,
        rows: raw.rows
      })
    }
    case 'undrive': {
      if (!isNonEmptyString(raw.sessionId)) return fail('invalid-undrive')
      return ok({ v: 1, type: 'undrive', sessionId: raw.sessionId })
    }
    case 'create': {
      if (!isNonEmptyString(raw.installationId)) return fail('invalid-create')
      if (typeof raw.workspace !== 'string' || raw.workspace.length === 0) {
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
      if (
        !isNonEmptyString(raw.sessionId) ||
        typeof raw.data !== 'string' ||
        !isNonNegInt(raw.byteLength)
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
      if (!isNonEmptyString(raw.sessionId) || typeof raw.data !== 'string') {
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
      if (!isNonEmptyString(raw.sessionId) || !isNonNegInt(raw.bytes)) {
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
      if (!isNonEmptyString(raw.sessionId)) return fail('invalid-pty-exit')
      if (raw.code !== undefined && !isFiniteNumber(raw.code)) {
        return fail('invalid-pty-exit')
      }
      if (raw.signal !== undefined && !isFiniteNumber(raw.signal)) {
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
  for (const [roomId, room] of Object.entries(rooms)) {
    if (room.status !== 'open') continue
    for (const role of ['desktop', 'phone'] as const) {
      if (room[role] !== connectionId) continue
      const nextRoom = { ...room, [role]: null }
      const peerId = room[otherRole(role)]
      const replies: RoomReply[] =
        peerId === null
          ? []
          : [
              {
                connectionId: peerId,
                message: { v: 1, type: 'peer-leave', role }
              }
            ]
      return {
        rooms: { ...rooms, [roomId]: nextRoom },
        replies
      }
    }
  }
  return { rooms, replies: [] }
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

/**
 * OpenCode Bridge 契约（SPEC-OPENCODE-BRIDGE）。
 * CLI 与主进程共用同一套请求/响应/事件形状。
 */

import type { CliRuntime } from './ipc-contract'

export const BRIDGE_PROTOCOL_VERSION = 1 as const

export const MODEL_ID_PATTERN =
  /^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:+-]*$/

export const SEND_TEXT_LIMIT_BYTES = 64 * 1024
export const DELTA_TEXT_LIMIT_BYTES = 64 * 1024
export const DELTA_TOOL_JSON_LIMIT_BYTES = 32 * 1024
export const DELTA_TOOL_LIMIT = 64
export const DELTA_PACKET_LIMIT_BYTES = 256 * 1024
export const SESSION_NAME_LIMIT = 128

export type BridgeAgent = 'build' | 'plan'

export type BridgeRuntime = CliRuntime

export interface BridgeModel {
  id: string
  provider: string
  model: string
  label?: string
}

export interface BridgeDelta {
  text: string
  tools: BridgeToolDelta[]
  truncated?: boolean
}

export interface BridgeToolDelta {
  name: string
  callId: string
  input?: unknown
  output?: unknown
  error?: string
}

export interface BridgeBlocked {
  kind: 'permission' | 'question' | 'other'
  requestId?: string
  summary?: string
  form?: unknown
}

export interface BridgeWatchEvent {
  v: 1
  type: 'blocked' | 'turn' | 'failed' | 'exited'
  sessionId: string
  installationId: string
  runtime: BridgeRuntime
  status: 'needs-you' | 'done' | 'idle' | 'error' | 'exited'
  delta: BridgeDelta
  blocked?: BridgeBlocked
  error?: { message: string }
  occurredAt: number
}

export interface BridgeSessionInfo {
  sessionId: string
  terminalId: string
  name: string
  status: string
  agent?: BridgeAgent
  model?: string
  workspace: string
  installationId: string
  runtime: BridgeRuntime
  pendingAttentionCount: number
}

export interface BridgeModelsResult {
  installationId: string
  runtime: BridgeRuntime
  models: BridgeModel[]
}

export interface BridgeCreateResult {
  sessionId: string
  terminalId: string
  name: string
  model: string
  agent: BridgeAgent
  workspace: string
  installationId: string
  runtime: BridgeRuntime
}

export interface BridgeTurnResult {
  sessionId: string
  installationId: string
  runtime: BridgeRuntime
  delta: BridgeDelta
}

export const P1_METHODS = [
  'opencode.models',
  'opencode.create',
  'sessions.list',
  'session.send',
  'session.turn',
  'session.watch',
  'session.close'
] as const

export const P2_METHODS = [
  'session.rename',
  'session.mode',
  'session.approve',
  'session.deny',
  'session.questions',
  'session.answer',
  'session.reject-question',
  'session.wait'
] as const

export type BridgeP1Method = (typeof P1_METHODS)[number]
export type BridgeP2Method = (typeof P2_METHODS)[number]
export type BridgeMethod = BridgeP1Method | BridgeP2Method

export interface BridgeRequest {
  id: string
  token: string
  method: string
  params?: unknown
}

export type BridgeSocketMessage =
  | { kind: 'result'; id: string; ok: true; result: unknown }
  | { kind: 'result'; id: string; ok: false; error: BridgeErrorBody }
  | { kind: 'event'; id: string; event: BridgeWatchEvent }

export interface BridgeErrorBody {
  code: string
  message: string
}

export const BRIDGE_ERROR = {
  notImplemented: 'not-implemented',
  invalid: 'invalid',
  notFound: 'not-found',
  notAllowed: 'not-allowed',
  unavailable: 'unavailable',
  unauthorized: 'unauthorized',
  uncontrolled: 'uncontrolled',
  timeout: 'timeout',
  disconnected: 'disconnected'
} as const

export type {
  BridgeLaunchAck,
  BridgeLaunchRequest
} from './ipc-contract'

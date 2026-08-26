import type { CliRuntime, CliRuntimeError } from './ipc-contract'

/**
 * DSH host IPC 契约 —— 主进程 / preload / renderer 三方共享。
 *
 * hrack 把已发现的 deepseek-harness（dsh）作为 agent 运行时：主进程启动
 * 本机或 WSL 上的 dsh web profile（HTTP 上行 / WebSocket 下行），
 * renderer 通过这里暴露的 baseUrl 直连 host。本文件只描述 host 生命周期，
 * 不描述 dsh wire 协议本身。
 */

// ───── Renderer → Main（ipcMain.handle，请求-响应）─────────

export enum DshInvokeChannel {
  GetStatus = 'dsh:get-status',
  EnsureStarted = 'dsh:ensure-started',
  Restart = 'dsh:restart',
  Stop = 'dsh:stop',
  /** wire 转发：上行 HTTP（POST /api/<method> 与 /api/respond）。 */
  WireFetch = 'dsh:wire-fetch',
  WireFetchAbort = 'dsh:wire-fetch-abort',
  /** wire 转发：下行流（/api/events.mux 与 /api/events.host 的 WS）。 */
  WireStreamOpen = 'dsh:wire-stream-open',
  WireStreamClose = 'dsh:wire-stream-close',
  /** 取回 host 注入的 __DSH_BOOT__ 清单（renderer 装配 client 模块表用）。 */
  GetBootManifest = 'dsh:get-boot-manifest',
  GetConfig = 'dsh:get-config',
  ScanRuntimes = 'dsh:scan-runtimes',
  SetRuntime = 'dsh:set-runtime',
  SetHomeMode = 'dsh:set-home-mode',
  SetRetention = 'dsh:set-retention',
  /** 隔离官方 Web surface：语义 show 与高频 bounds 更新分离。 */
  SurfaceShow = 'dsh:surface-show',
  SurfaceSetBounds = 'dsh:surface-set-bounds',
  SurfaceHide = 'dsh:surface-hide',
  /** Kill the dsh process, spawn a new one, and reload the official page. */
  SurfaceRestart = 'dsh:surface-restart',
  /** 只移除 HRack 的当前投影，不修改或归档 DSH 会话。 */
  SurfaceUnfollow = 'dsh:surface-unfollow'
}

// ───── Main → Renderer（webContents.send，广播）─────────

export enum DshEventChannel {
  StatusChanged = 'dsh:status-changed',
  WireStreamOpened = 'dsh:wire-stream-opened',
  WireStreamMessage = 'dsh:wire-stream-message',
  WireStreamClosed = 'dsh:wire-stream-closed'
}

/** Official Web preload → its owning controller only. */
export const DSH_SURFACE_ACTIVE_SESSION_REPORT_CHANNEL =
  'dsh:surface-active-session-report'

/** dsh wire 上行 body：默认 utf8 文本；附件等二进制走 base64。 */
export type DshWireBodyEncoding = 'utf8' | 'base64'

export interface DshWireFetchRequest {
  requestId: string
  method: string
  /** 仅路径+查询（/api/...），base 由主进程按当前 host 注入。 */
  path: string
  headers?: Record<string, string>
  body?: string
  /** 缺省按 utf8 文本；base64 时主进程解码后再转发给 host。 */
  bodyEncoding?: DshWireBodyEncoding
}

export interface DshWireFetchResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export interface DshWireStreamOpenRequest {
  streamId: string
  /** /api/events.mux 或 /api/events.host。 */
  path: string
}

export interface DshWireStreamOpenedEvent {
  streamId: string
}

export interface DshWireStreamMessageEvent {
  streamId: string
  /** 原样透传的文本帧（server-request JSON）。 */
  data: string
}

export interface DshWireStreamClosedEvent {
  streamId: string
  code?: number
  reason?: string
  /** 传输层错误描述（与正常 close 区分）。 */
  error?: string
}

/** DSH 跟踪位没有真实 PTY；用稳定 slotId 接入既有导航/投影管道。 */
export function dshTerminalId(slotId: string): string {
  return `dsh:${slotId}`
}

export function isDshTerminalId(terminalId: string): boolean {
  return terminalId.startsWith('dsh:')
}

export type DshHostState = 'stopped' | 'starting' | 'ready' | 'failed'

export interface DshHostStatus {
  state: DshHostState
  /** state === 'ready' 时的 host 根地址（http://127.0.0.1:<port>）。 */
  baseUrl?: string
  /** 本次 host 使用的 DSH_HOME（隔离或共享，见设置）。 */
  dshHome?: string
  /** state === 'failed' 时的人类可读原因（含 host 最近输出摘录）。 */
  error?: string
  pid?: number
  /** 本次实际启动的运行时；auto 发生回退时以这里为准。 */
  activeRuntime?: DshRuntimeCandidate
}

export type DshHomeMode = 'isolated' | 'shared'

export type DshRuntimePreference =
  | { kind: 'auto' }
  | { kind: 'installation'; installationId: string }

export type DshRuntimeCandidate = {
  id: string
  kind: 'installation'
  runtime: CliRuntime
  resolvedExecutable: string
  version?: string
}

export interface DshRuntimeScanReport {
  startedAt: number
  finishedAt: number
  candidates: DshRuntimeCandidate[]
  runtimeErrors: CliRuntimeError[]
}

export type DshRetentionPolicy =
  | { kind: 'all' }
  | { kind: 'days'; days: number }
  | { kind: 'count'; count: number }

export interface DshRuntimeConfig {
  homeMode: DshHomeMode
  isolatedHome: string
  sharedHome: string
  activeHome: string
  envOverride: boolean
  retention: DshRetentionPolicy
  runtimePreference: DshRuntimePreference
  activeRuntime?: DshRuntimeCandidate
}

export interface DshApi {
  getStatus(): Promise<DshHostStatus>
  /** 幂等：已 ready/starting 时直接返回当前状态（starting 会等待结果）。 */
  ensureStarted(): Promise<DshHostStatus>
  /** 停掉当前 host 再冷启动，用于安装插件后重新加载官方页面。 */
  restart(): Promise<DshHostStatus>
  stop(): Promise<DshHostStatus>
  getConfig(): Promise<DshRuntimeConfig>
  scanRuntimes(force?: boolean): Promise<DshRuntimeScanReport>
  setRuntime(preference: DshRuntimePreference): Promise<DshHostStatus>
  setHomeMode(mode: DshHomeMode): Promise<DshHostStatus>
  setRetention(policy: DshRetentionPolicy): Promise<DshRuntimeConfig>
  onStatusChanged(cb: (status: DshHostStatus) => void): () => void
  /**
   * host serve 的 index.html 里注入的 window.__DSH_BOOT__ 原始值。
   * 形状由 @deepseek-ai/dsh-client-modules 定义（WebBootGraph）；hrack 不重复
   * 声明该类型，renderer 侧交给 dsh-client-web 的 parseBootManifest 校验。
   */
  getBootManifest(): Promise<unknown>
}

// ───── Official Web surface（Renderer → Main）──────────

export interface DshSurfaceBounds {
  x: number
  y: number
  width: number
  height: number
  /** Native view corner radius (DIP)；主题圆角开启时为 20，否则 0。 */
  cornerRadius: number
}

/** HRack 只负责 DSH Web surface 的宿主级显示参数，不干预 DSH 自身主题。 */
export interface DshSurfaceAppearance {
  locale: 'zh' | 'en'
  /** Electron zoom factor；0.75–1.25。 */
  scale: number
}

export interface DshSurfaceShowRequest {
  /** Home 创建的稳定 HRack 跟踪位；官方页内切换不会改变它。 */
  slotId: string
  /** Home 新建必须回到官方默认页；已有 slot 才恢复绑定会话。 */
  intent: 'new' | 'resume'
  /**
   * 已有跟踪位绑定的官方 DSH session；仅 resume 时提供。
   */
  sessionId?: string
  bounds: DshSurfaceBounds
  appearance: DshSurfaceAppearance
}

export type DshSurfacePhase = 'hidden' | 'loading' | 'ready' | 'failed'

export interface DshSurfaceSnapshot {
  phase: DshSurfacePhase
  visible: boolean
  slotId?: string
  sessionId?: string
  bounds?: DshSurfaceBounds
  url?: string
  error?: string
}

/**
 * HRack renderer 的唯一 DSH presentation seam。官方页面的装配、DOM 与
 * Cordis runtime 全部留在主进程 Adapter 后面。
 */
export interface DshSurfaceApi {
  show(request: DshSurfaceShowRequest): Promise<DshSurfaceSnapshot>
  setBounds(bounds: DshSurfaceBounds): Promise<void>
  hide(): Promise<void>
  /** Kill the dsh process, spawn a new host, and reload the official page. */
  restart(): Promise<DshSurfaceSnapshot>
  /** Stop projecting one HRack slot locally; official DSH state is untouched. */
  unfollow(slotId: string): Promise<void>
}

/**
 * dsh wire 转发 API —— renderer 内 IpcApiClient（AbstractApiClient 子类）的
 * 传输底座。主进程作为 loopback 客户端直连 host（可通过信任栅栏），
 * renderer 永远不直接对 host 发 HTTP/WS（file:// 与 dev origin 都会被拦）。
 */
export interface DshWireApi {
  fetch(request: DshWireFetchRequest): Promise<DshWireFetchResponse>
  abortFetch(requestId: string): Promise<void>
  openStream(request: DshWireStreamOpenRequest): Promise<void>
  closeStream(streamId: string): Promise<void>
  onStreamOpened(cb: (event: DshWireStreamOpenedEvent) => void): () => void
  onStreamMessage(cb: (event: DshWireStreamMessageEvent) => void): () => void
  onStreamClosed(cb: (event: DshWireStreamClosedEvent) => void): () => void
}

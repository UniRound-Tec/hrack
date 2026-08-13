/**
 * DSH host IPC 契约 —— 主进程 / preload / renderer 三方共享。
 *
 * vibing 把 deepseek-harness（dsh）作为内置 agent 运行时：主进程用
 * utilityProcess 启动 dsh 的 web profile（HTTP 上行 / WebSocket 下行），
 * renderer 通过这里暴露的 baseUrl 直连 host。本文件只描述 host 生命周期，
 * 不描述 dsh wire 协议本身（那是 @deepseek-ai/dsh-client-* 的领域）。
 */

// ───── Renderer → Main（ipcMain.handle，请求-响应）─────────

export enum DshInvokeChannel {
  GetStatus = 'dsh:get-status',
  EnsureStarted = 'dsh:ensure-started',
  Stop = 'dsh:stop',
  /** wire 转发：上行 HTTP（POST /api/<method> 与 /api/respond）。 */
  WireFetch = 'dsh:wire-fetch',
  WireFetchAbort = 'dsh:wire-fetch-abort',
  /** wire 转发：下行流（/api/events.mux 与 /api/events.host 的 WS）。 */
  WireStreamOpen = 'dsh:wire-stream-open',
  WireStreamClose = 'dsh:wire-stream-close',
  /** 取回 host 注入的 __DSH_BOOT__ 清单（renderer 装配 client 模块表用）。 */
  GetBootManifest = 'dsh:get-boot-manifest'
}

// ───── Main → Renderer（webContents.send，广播）─────────

export enum DshEventChannel {
  StatusChanged = 'dsh:status-changed',
  WireStreamOpened = 'dsh:wire-stream-opened',
  WireStreamMessage = 'dsh:wire-stream-message',
  WireStreamClosed = 'dsh:wire-stream-closed'
}

/** dsh wire 协议只有 JSON 文本：body 一律 string，无需二进制通道。 */
export interface DshWireFetchRequest {
  requestId: string
  method: string
  /** 仅路径+查询（/api/...），base 由主进程按当前 host 注入。 */
  path: string
  headers?: Record<string, string>
  body?: string
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

/** DSH 会话没有真实 PTY；用合成 terminalId 接入既有导航/投影管道。 */
export function dshTerminalId(sessionId: string): string {
  return `dsh:${sessionId}`
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
}

export interface DshApi {
  getStatus(): Promise<DshHostStatus>
  /** 幂等：已 ready/starting 时直接返回当前状态（starting 会等待结果）。 */
  ensureStarted(): Promise<DshHostStatus>
  stop(): Promise<DshHostStatus>
  onStatusChanged(cb: (status: DshHostStatus) => void): () => void
  /**
   * host serve 的 index.html 里注入的 window.__DSH_BOOT__ 原始值。
   * 形状由 @deepseek-ai/dsh-client-modules 定义（WebBootGraph）；vibing 不重复
   * 声明该类型，renderer 侧交给 dsh-client-web 的 parseBootManifest 校验。
   */
  getBootManifest(): Promise<unknown>
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

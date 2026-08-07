/**
 * AgentSessionRuntime（PLAN-S1 §3.2, §7）——主进程深模块。
 *
 * 调用者只需要知道“启动”和“停止”；安装解析、Adapter 选择、临时资源、
 * Observer attach、降级和清理全部留在模块实现内部。Runtime 不向调用者
 * 暴露具体 Adapter、hook 文件、socket、transcript path 或协议连接。
 *
 * 职责链：validate selection → choose adapter → prepare observation →
 * compose safe launch → PTY spawn → attach observer → normalize events →
 * reduce state → persist/project → rollback / dispose。
 */

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AgentEventChannel,
  NO_OBSERVER_CAPABILITIES,
  capabilitiesHaveSemantics,
  type AgentEvent,
  type AgentEventSource,
  type AgentSessionProjection,
  type ObserverCapabilities,
  type PublishAgentCaption,
  type StartAgentSession,
  type StartedAgentSession
} from '../../shared/agent-events'
import type {
  CliInstallation,
  CliLaunchSelection,
  CliRuntime,
  ExitPayload,
  HistoryEvent,
  SpawnOptions
} from '../../shared/ipc-contract'
import { AgentEventQueue, type AgentQueueLimits } from './AgentEventQueue'
import { normalizeAdapterEvent } from './AgentEventNormalizer'
import { AgentEventProjector } from './AgentEventProjector'
import {
  createInitialAgentProjection,
  reduceAgentSession
} from './AgentEventReducer'
import type { ObserverRegistry } from './ObserverRegistry'
import type {
  AdapterEvent,
  LaunchAugmentation,
  ObserverHandle,
  PreparedObserver
} from './adapters/types'

const DEFAULT_SILENCE_AFTER_MS = 300_000
const DEFAULT_IDLE_CHECK_MS = 60_000
const HOOK_HANDSHAKE_TIMEOUT_MS = 10_000

const MAX_TERMINAL_ID_LENGTH = 128
const MAX_SESSION_NAME_LENGTH = 256
const MAX_ENV_KEY_LENGTH = 128
const MAX_ENV_VALUE_LENGTH = 4_096
const MAX_ARG_LENGTH = 1_024
const MAX_AUGMENTED_ARGS = 32
const MAX_PRESTART_OBSERVER_EVENTS = 2_000
const MAX_CAPTION_LENGTH = 128
const MAX_TOKEN_COUNT = 10_000_000_000

// ───── 依赖 seam（保持 Runtime 与 Electron / node-pty 解耦，interface 可测） ─────

/** PTYManager 的主进程内部生命周期子集。 */
export interface AgentPtyHost {
  spawn(opts: SpawnOptions): Promise<{ ptyId: string }>
  kill(ptyId: string): void
  onExit(ptyId: string, cb: (payload: ExitPayload) => void): () => void
  /** 不读取内容，只提供沉默 watchdog 所需的时间/存活事实。 */
  lastOutputAt?(ptyId: string): number | null
  isRunning?(ptyId: string): boolean
  /** 只报告 CR/LF 提交边界，不暴露输入正文。 */
  onInputSubmitted?(ptyId: string, cb: () => void): () => void
}

/** CLI 安装解析与启动选项合成（AiCliDiscoveryService 实现）。 */
export interface AgentLaunchProvider {
  resolveInstallation(installationId: string): Promise<CliInstallation | null>
  resolveWorkspace(installationId: string, workspace: string): Promise<string>
  definitionAdapterId(installation: CliInstallation): string | null
  /**
   * 与正式启动完全相同的运行环境片段。Adapter 的 capability probe
   * 必须复用它，不能另起 login shell 或裸执行包装器。
   */
  runtimeEnvironment?(
    installation: CliInstallation
  ): Readonly<Record<string, string>>
  prepareLaunch(
    selection: CliLaunchSelection,
    augmentation?: {
      env?: Readonly<Record<string, string>>
      prependArgs?: readonly string[]
      appendArgs?: readonly string[]
      unsetEnv?: readonly string[]
    }
  ): Promise<SpawnOptions>
}

/** 低敏历史投影落盘（EventLog 实现）。 */
export interface AgentHistorySink {
  record(event: HistoryEvent): Promise<void>
}

export interface AgentWorkspaceHost {
  mount(terminalId: string, runtime: CliRuntime, workspace: string): Promise<void>
}

export interface AgentRuntimeOptions {
  /** 每个会话的临时目录根：`<userData>/observer-runs/`。 */
  runDirRoot: string
  broadcast(channel: string, payload: unknown): void
  /** 0 表示禁用沉默兜底（测试用）。 */
  silenceAfterMs?: number
  idleCheckMs?: number
  limits?: AgentQueueLimits
}

interface ActiveAgentSession {
  sessionId: string
  terminalId: string
  ptyId: string
  installationId: string
  adapterId: string
  name: string
  source: AgentEventSource
  capabilities: ObserverCapabilities
  runDir: string
  queue: AgentEventQueue
  projector: AgentEventProjector
  projection: AgentSessionProjection
  prepared: PreparedObserver | null
  observerHandle: ObserverHandle | null
  seq: number
  lastActivityAt: number
  flushScheduled: boolean
  overflowReported: boolean
  finalized: boolean
  rejectedEventCount: number
  unsubscribeExit: (() => void) | null
  unsubscribeDisconnect: (() => void) | null
  unsubscribeInput: (() => void) | null
  reconnectAttempted: boolean
  reconnecting: boolean
  observerEventsOpen: boolean
  observerDelivered: boolean
  handshakeTimer: ReturnType<typeof setTimeout> | null
  pendingObserverEvents: AdapterEvent[]
  pendingObserverOverflow: boolean
  idleTimer: ReturnType<typeof setInterval> | null
  cleanupPromise: Promise<void> | null
}

// ───── 输入校验 ─────

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

function bounded(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  return trimmed ? trimmed.slice(0, maxLength) : undefined
}

function validateStartAgentSession(value: unknown): StartAgentSession | null {
  const raw = recordOf(value)
  const selection = recordOf(raw?.selection)
  if (!raw || !selection) return null
  const terminalId = bounded(raw.terminalId, MAX_TERMINAL_ID_LENGTH)
  if (!terminalId) return null
  const installationId = bounded(selection.installationId, MAX_ENV_VALUE_LENGTH)
  const workspace =
    typeof selection.workspace === 'string'
      ? selection.workspace.slice(0, 32_768)
      : undefined
  const argsRaw = Array.isArray(selection.args) ? selection.args : null
  if (
    !installationId ||
    workspace === undefined ||
    !argsRaw ||
    argsRaw.length > 128
  ) {
    return null
  }
  const args: string[] = []
  for (const argument of argsRaw) {
    if (typeof argument !== 'string') return null
    if (argument.length > 4_096 || argument.includes('\0')) return null
    args.push(argument)
  }
  const cols = raw.cols
  const rows = raw.rows
  if (
    typeof cols !== 'number' ||
    !Number.isInteger(cols) ||
    cols < 1 ||
    cols > 10_000 ||
    typeof rows !== 'number' ||
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > 10_000
  ) {
    return null
  }
  const name = bounded(raw.name, MAX_SESSION_NAME_LENGTH)
  return {
    terminalId,
    selection: { installationId, workspace, args },
    name,
    cols,
    rows
  }
}

function sanitizeAugmentation(
  augmentation: LaunchAugmentation | undefined
): LaunchAugmentation {
  if (!augmentation) return {}
  const env: Record<string, string> = {}
  const rawEnv = recordOf(augmentation.env)
  if (rawEnv) {
    for (const [key, value] of Object.entries(rawEnv)) {
      if (
        key.length > 0 &&
        key.length <= MAX_ENV_KEY_LENGTH &&
        typeof value === 'string' &&
        value.length <= MAX_ENV_VALUE_LENGTH &&
        !key.includes('\0') &&
        !value.includes('\0')
      ) {
        env[key] = value
      }
    }
  }
  const cleanArgs = (values: string[] | undefined): string[] | undefined => {
    if (!values) return undefined
    const cleaned = values
      .filter(
        (value) =>
          typeof value === 'string' &&
          value.length <= MAX_ARG_LENGTH &&
          !value.includes('\0')
      )
      .slice(0, MAX_AUGMENTED_ARGS)
    return cleaned.length > 0 ? cleaned : undefined
  }
  return {
    env: Object.keys(env).length > 0 ? env : undefined,
    unsetEnv: Array.isArray(augmentation.unsetEnv)
      ? augmentation.unsetEnv
          .filter(
            (key) =>
              typeof key === 'string' &&
              key.length > 0 &&
              key.length <= MAX_ENV_KEY_LENGTH &&
              /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
          )
          .slice(0, 32)
      : undefined,
    prependArgs: cleanArgs(augmentation.prependArgs),
    appendArgs: cleanArgs(augmentation.appendArgs)
  }
}

function mergeEnvironmentAugmentation(
  base: SpawnOptions,
  augmentation: LaunchAugmentation
): SpawnOptions {
  const merged: SpawnOptions = { ...base }
  if (augmentation.env || augmentation.unsetEnv) {
    merged.env = {
      ...(base.env ?? (process.env as Record<string, string>)),
      ...(augmentation.env ?? {})
    }
    for (const key of augmentation.unsetEnv ?? []) delete merged.env[key]
  }
  return merged
}

async function disposeResources(
  resources: ReadonlyArray<
    { label: string; dispose: (() => Promise<void>) | undefined } | undefined
  >
): Promise<void> {
  const active = resources.filter(
    (resource): resource is { label: string; dispose: () => Promise<void> } =>
      Boolean(resource?.dispose)
  )
  const results = await Promise.allSettled(
    active.map((resource) => resource.dispose())
  )
  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    if (result.status === 'rejected') {
      console.error(
        `[agent-runtime] ${active[index].label} cleanup failed:`,
        result.reason
      )
    }
  }
}

function validatePublishCaption(value: unknown): PublishAgentCaption | null {
  const raw = recordOf(value)
  if (!raw) return null
  const terminalId = bounded(raw.terminalId, MAX_TERMINAL_ID_LENGTH)
  const text = bounded(raw.text, MAX_CAPTION_LENGTH)
  if (!terminalId || !text) return null
  const outputTokens = raw.outputTokens
  if (
    outputTokens !== undefined &&
    (typeof outputTokens !== 'number' ||
      !Number.isFinite(outputTokens) ||
      outputTokens < 0 ||
      outputTokens > MAX_TOKEN_COUNT)
  ) {
    return null
  }
  return { terminalId, text, outputTokens }
}

export class AgentSessionRuntime {
  private readonly sessions = new Map<string, ActiveAgentSession>()
  private runRootReady: Promise<void> | null = null
  private readonly options: Required<
    Pick<AgentRuntimeOptions, 'silenceAfterMs' | 'idleCheckMs'>
  > &
    AgentRuntimeOptions

  constructor(
    private readonly deps: {
      pty: AgentPtyHost
      discovery: AgentLaunchProvider
      history: AgentHistorySink
      registry: ObserverRegistry
      workspace?: AgentWorkspaceHost
      options: AgentRuntimeOptions
    }
  ) {
    this.options = {
      silenceAfterMs: deps.options.silenceAfterMs ?? DEFAULT_SILENCE_AFTER_MS,
      idleCheckMs: deps.options.idleCheckMs ?? DEFAULT_IDLE_CHECK_MS,
      ...deps.options
    }
  }

  /** 每次应用生命周期只清一次上次崩溃遗留目录，并收紧 POSIX 权限。 */
  private ensureRunRoot(): Promise<void> {
    if (!this.runRootReady) {
      this.runRootReady = (async () => {
        const root = this.deps.options.runDirRoot
        await mkdir(root, { recursive: true, mode: 0o700 })
        if (process.platform !== 'win32') await chmod(root, 0o700)
        const staleEntries = await readdir(root)
        await Promise.allSettled(
          staleEntries.map((entry) =>
            rm(join(root, entry), { recursive: true, force: true })
          )
        )
      })()
    }
    return this.runRootReady
  }

  async start(inputValue: StartAgentSession): Promise<StartedAgentSession> {
    const input = validateStartAgentSession(inputValue)
    if (!input) throw new Error('Invalid agent session request')

    const installation = await this.deps.discovery.resolveInstallation(
      input.selection.installationId
    )
    if (!installation) {
      throw new Error(
        'CLI installation is no longer available; refresh the scan'
      )
    }
    const adapterId =
      this.deps.discovery.definitionAdapterId(installation) ?? 'unknown'
    const workspace = await this.deps.discovery.resolveWorkspace(
      installation.id,
      input.selection.workspace
    )
    const selection: CliLaunchSelection = {
      ...input.selection,
      workspace
    }

    await this.ensureRunRoot()
    const sessionId = randomUUID()
    const runDir = join(this.deps.options.runDirRoot, sessionId)
    await mkdir(runDir, { recursive: false, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(runDir, 0o700)

    // 1. Adapter 选择与 prepare（失败默认降级 lifecycle，不中止 CLI）。
    const context = {
      sessionId,
      installation,
      adapterId,
      platform: process.platform,
      workspace,
      args: selection.args,
      runtimeEnvironment:
        this.deps.discovery.runtimeEnvironment?.(installation) ?? {},
      runDir
    }
    const adapter = this.deps.registry.resolve(context)
    let prepared: PreparedObserver | null = null
    let degraded: { reason: string } | null = null
    if (adapter.id !== 'lifecycle') {
      try {
        prepared = await adapter.prepare(context)
      } catch (error) {
        prepared = null
        degraded = {
          reason: `observer prepare failed: ${String(error).slice(0, 512)}`
        }
      }
    }

    // 2. 合成安全启动选项（安装失效/工作区非法在此抛错并整体回滚）。
    const augmentation = sanitizeAugmentation(prepared?.launch)
    let baseOptions: SpawnOptions
    try {
      baseOptions = await this.deps.discovery.prepareLaunch(selection, {
        env: augmentation.env,
        prependArgs: augmentation.prependArgs,
        appendArgs: augmentation.appendArgs,
        unsetEnv: augmentation.unsetEnv
      })
    } catch (error) {
      await disposeResources([
        prepared
          ? { label: 'prepared observer', dispose: () => prepared.dispose() }
          : undefined
      ])
      await rm(runDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    const spawnOptions = mergeEnvironmentAugmentation(baseOptions, augmentation)
    const name = input.name?.trim() ?? ''

    // 3. PTY spawn；失败必须 dispose prepared observer 并删除临时资源。
    let ptyId: string
    try {
      ptyId = (
        await this.deps.pty.spawn({
          ...spawnOptions,
          cols: input.cols,
          rows: input.rows,
          terminal: {
            terminalId: input.terminalId,
            kind: 'agent',
            name: name || installation.definitionId,
            shellId: adapterId,
            cwd: workspace,
            agentSelection: selection
          }
        })
      ).ptyId
    } catch (error) {
      await disposeResources([
        prepared
          ? { label: 'prepared observer', dispose: () => prepared.dispose() }
          : undefined
      ])
      await rm(runDir, { recursive: true, force: true }).catch(() => {})
      throw new Error(`Failed to start CLI: ${String(error).slice(0, 512)}`)
    }

    // 工作区阅读器是附属能力：挂载失败不得杀死已经成功启动的 CLI。
    if (this.deps.workspace) {
      await this.deps.workspace
        .mount(input.terminalId, installation.runtime, workspace)
        .catch((error) => {
          console.warn('[workspace-reader] mount degraded:', error)
        })
    }

    const capabilities: ObserverCapabilities = degraded
      ? NO_OBSERVER_CAPABILITIES
      : (prepared?.capabilities ?? adapter.capabilities)
    const now = Date.now()
    const projection = createInitialAgentProjection({
      sessionId,
      terminalId: input.terminalId,
      installationId: installation.id,
      adapterId,
      name: name || undefined,
      capabilities,
      lastActivityAt: now
    })
    projection.observerHealth = capabilitiesHaveSemantics(capabilities)
      ? 'unconfirmed'
      : 'lifecycle-only'

    const session: ActiveAgentSession = {
      sessionId,
      terminalId: input.terminalId,
      ptyId,
      installationId: installation.id,
      adapterId,
      name,
      source: adapter.source,
      capabilities,
      runDir,
      queue: new AgentEventQueue(this.options.limits),
      projector: new AgentEventProjector({
        sessionId,
        name,
        workspace,
        adapterId
      }),
      projection,
      prepared,
      observerHandle: null,
      seq: 0,
      lastActivityAt: now,
      flushScheduled: false,
      overflowReported: false,
      finalized: false,
      rejectedEventCount: 0,
      unsubscribeExit: null,
      unsubscribeDisconnect: null,
      unsubscribeInput: null,
      reconnectAttempted: false,
      reconnecting: false,
      observerEventsOpen: false,
      observerDelivered: false,
      handshakeTimer: null,
      pendingObserverEvents: [],
      pendingObserverOverflow: false,
      idleTimer: null,
      cleanupPromise: null
    }

    // 4. attach；失败保持 CLI 运行，能力降为 lifecycle。
    if (prepared) {
      try {
        const handle = await prepared.attach(
          {
            sessionId,
            installationId: installation.id,
            adapterId,
            ptyId,
            runDir,
            cols: input.cols,
            rows: input.rows
          },
          (event) => this.receiveObserverEvent(session, event)
        )
        this.bindObserverHandle(session, handle)
        session.capabilities = handle.capabilities ?? capabilities
        session.projection = {
          ...session.projection,
          capabilities: session.capabilities,
          observerHealth: capabilitiesHaveSemantics(session.capabilities)
            ? 'unconfirmed'
            : 'lifecycle-only'
        }
      } catch (error) {
        session.observerHandle = null
        degraded = {
          reason: `observer attach failed: ${String(error).slice(0, 512)}`
        }
        await disposeResources([
          {
            label: 'prepared observer after attach failure',
            dispose: () => prepared.dispose()
          }
        ])
        session.prepared = null
        session.capabilities = NO_OBSERVER_CAPABILITIES
        session.projection = {
          ...session.projection,
          capabilities: NO_OBSERVER_CAPABILITIES,
          observerHealth: 'lifecycle-only'
        }
      }
    }

    // 5. PTY exit seam：退出事实只归约一次，再推送 renderer。
    session.unsubscribeExit = this.deps.pty.onExit(ptyId, (payload) => {
      if (session.finalized) return
      this.acceptAdapterEvent(session, {
        kind: 'session.exited',
        payload: { exitCode: payload.code, signal: payload.signal },
        nativeId: `pty-exit:${ptyId}`
      })
    })

    // 先注册到权威表再开放事件，确保同步 flush/退出也能被 listActive 与 stop 看见。
    this.sessions.set(sessionId, session)

    if (
      capabilitiesHaveSemantics(session.capabilities) &&
      this.deps.pty.onInputSubmitted
    ) {
      session.unsubscribeInput = this.deps.pty.onInputSubmitted(ptyId, () => {
        if (
          session.finalized ||
          session.observerDelivered ||
          session.handshakeTimer
        )
          return
        session.handshakeTimer = setTimeout(() => {
          session.handshakeTimer = null
          if (session.finalized || session.observerDelivered) return
          this.acceptAdapterEvent(session, {
            kind: 'observer.degraded',
            payload: {
              reason: 'hook-handshake-timeout',
              remaining: session.capabilities
            },
            nativeId: `hook-handshake-timeout:${session.sessionId}`
          })
        }, HOOK_HANDSHAKE_TIMEOUT_MS)
      })
    }

    // 6. 会话开放事实 + 降级事实（顺序固定，先 started 后 degraded）。
    this.acceptAdapterEvent(session, {
      kind: 'session.started',
      payload: { cwd: workspace },
      nativeId: `start:${sessionId}`
    })
    if (degraded) {
      this.acceptAdapterEvent(session, {
        kind: 'observer.degraded',
        payload: { reason: degraded.reason, remaining: session.capabilities },
        nativeId: `degraded:${sessionId}`
      })
    }
    session.observerEventsOpen = true
    const pendingObserverEvents = session.pendingObserverEvents
    session.pendingObserverEvents = []
    for (const event of pendingObserverEvents) {
      this.acceptAdapterEvent(session, event)
    }
    if (session.pendingObserverOverflow) {
      this.acceptAdapterEvent(session, {
        kind: 'observer.degraded',
        payload: {
          reason: 'observer emitted too many events before attach completed',
          remaining: session.capabilities
        },
        nativeId: `prestart-overflow:${session.sessionId}`
      })
    }

    if (this.options.idleCheckMs > 0) {
      session.idleTimer = setInterval(
        () => this.checkIdle(session),
        this.options.idleCheckMs
      )
    }

    return {
      sessionId,
      terminalId: input.terminalId,
      ptyId,
      installationId: installation.id,
      adapterId,
      capabilities: session.capabilities,
      projection: session.projection
    }
  }

  /** 幂等停止：手动关闭、进程自行退出或应用退出都最多执行一次清理。 */
  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (!session.finalized && !session.projection.correlation.exited) {
      // 手动关闭本身也是退出事实。先归约/投影，再由 exit flush 终止 PTY，
      // 避免异步 node-pty exit 回调被提前退订而丢失 session_exit。
      this.acceptAdapterEvent(session, {
        kind: 'session.exited',
        payload: {},
        nativeId: `manual-stop:${session.sessionId}`
      })
      this.flush(session)
      try {
        this.deps.pty.kill(session.ptyId)
      } catch {
        /* 进程可能已退出；kill 同时负责移除保留的终端历史。 */
      }
    }
    await this.finalize(session, true)
  }

  /** 活动 Session 显示名属于权威 projection；改名不伪造语义活动时间。 */
  rename(sessionId: string, rawName: string): AgentSessionProjection | null {
    const session = this.sessions.get(sessionId)
    const name = bounded(rawName, 128)?.trim()
    if (!session || session.finalized || !name) return null
    session.name = name
    session.projection = {
      ...session.projection,
      name,
      lastSeq: ++session.seq
    }
    this.deps.options.broadcast(
      AgentEventChannel.Projection,
      session.projection
    )
    return session.projection
  }

  /**
   * Renderer 只上报已经由 xterm 解析完成的低敏状态标记；不接受屏幕正文。
   * terminalId 在主进程重新关联到权威 Session，伪造/过期 id 会被忽略。
   */
  publishCaption(inputValue: unknown): void {
    const input = validatePublishCaption(inputValue)
    if (!input) return
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.terminalId === input.terminalId
    )
    if (!session || session.finalized || session.projection.correlation.exited)
      return
    this.acceptAdapterEvent(session, {
      kind: 'activity.caption',
      payload: {
        text: input.text,
        confidence: 'low',
        outputTokens: input.outputTokens
      },
      nativeType: 'TerminalBufferCaption'
    })
  }

  listActive(): AgentSessionProjection[] {
    return [...this.sessions.values()]
      .filter(
        (session) =>
          !session.finalized && !session.projection.correlation.exited
      )
      .map((session) => session.projection)
  }

  /** 应用退出：对所有会话幂等清理，不遗留 hook server、socket 或 temp settings。 */
  async disposeAll(): Promise<void> {
    const sessions = [...this.sessions.values()]
    await Promise.allSettled(
      sessions.map((session) => this.stop(session.sessionId))
    )
  }

  // ───── 事件管线 ─────

  private receiveObserverEvent(
    session: ActiveAgentSession,
    event: AdapterEvent
  ): void {
    if (event.kind !== 'observer.degraded') {
      session.observerDelivered = true
      if (session.handshakeTimer) clearTimeout(session.handshakeTimer)
      session.handshakeTimer = null
    }
    if (session.observerEventsOpen) {
      this.acceptAdapterEvent(session, event)
      return
    }
    if (session.pendingObserverEvents.length < MAX_PRESTART_OBSERVER_EVENTS) {
      session.pendingObserverEvents.push(event)
    } else {
      session.pendingObserverOverflow = true
    }
  }

  private acceptAdapterEvent(
    session: ActiveAgentSession,
    rawEvent: unknown
  ): void {
    if (session.finalized) return
    const normalized = normalizeAdapterEvent(rawEvent)
    if (!normalized) {
      session.rejectedEventCount++
      return
    }
    const event: AgentEvent = {
      id: randomUUID(),
      sessionId: session.sessionId,
      adapterId: session.adapterId,
      installationId: session.installationId,
      seq: ++session.seq,
      occurredAt: Date.now(),
      source: session.source,
      nativeId: normalized.nativeId,
      nativeType: normalized.nativeType,
      kind: normalized.kind,
      payload: normalized.payload
    } as AgentEvent
    session.lastActivityAt = event.occurredAt
    let result = session.queue.push(event)
    while (result === 'requires-flush' && session.queue.length > 0) {
      this.flush(session)
      if (session.finalized) return
      result = session.queue.push(event)
    }
    if (result === 'requires-flush') {
      console.error(
        `[agent-runtime] critical event exceeds queue byte limit: ${event.kind}`
      )
      return
    }
    if (result === 'dropped-overflow') {
      this.scheduleFlush(session)
      return
    }
    this.scheduleFlush(session)
  }

  private scheduleFlush(session: ActiveAgentSession): void {
    if (session.flushScheduled || session.finalized) return
    session.flushScheduled = true
    queueMicrotask(() => this.flush(session))
  }

  private flush(session: ActiveAgentSession): void {
    session.flushScheduled = false
    const batch = session.queue.flush()
    if (batch.length === 0) return

    const processed: AgentEvent[] = []
    let exited = false
    for (const event of batch) {
      const nextProjection = reduceAgentSession(session.projection, event)
      if (nextProjection === session.projection) continue
      session.projection = nextProjection
      processed.push(event)
      const history = session.projector.record(event)
      if (history) {
        this.deps.history.record(history).catch((error) => {
          console.error('[agent-runtime] history projection failed:', error)
        })
      }
      if (event.kind === 'session.exited') {
        exited = true
        break
      }
    }

    if (processed.length > 0) {
      this.deps.options.broadcast(
        AgentEventChannel.Projection,
        session.projection
      )
      this.deps.options.broadcast(AgentEventChannel.Events, processed)
    }

    if (exited) {
      // 最终投影已经广播；清理在独立幂等 Promise 中完成。
      void this.finalize(session, true)
      return
    }

    if (session.queue.hasOverflowed() && !session.overflowReported) {
      session.overflowReported = true
      this.acceptAdapterEvent(session, {
        kind: 'observer.degraded',
        payload: {
          reason: 'agent event queue overflow; progress details may be missing',
          remaining: session.capabilities
        },
        nativeId: `overflow:${session.sessionId}`
      })
    }
  }

  private bindObserverHandle(
    session: ActiveAgentSession,
    handle: ObserverHandle
  ): void {
    session.unsubscribeDisconnect?.()
    session.unsubscribeDisconnect = null
    if (handle.onDisconnect) {
      try {
        session.unsubscribeDisconnect = handle.onDisconnect((reason) => {
          void this.handleObserverDisconnect(session, reason)
        })
      } catch (error) {
        console.error('[agent-runtime] disconnect subscription failed:', error)
      }
    }
    session.observerHandle = handle
  }

  /** Event source 中断只允许一次 Adapter 自管重连；失败后诚实降级，不杀 PTY。 */
  private async handleObserverDisconnect(
    session: ActiveAgentSession,
    rawReason: string
  ): Promise<void> {
    if (session.finalized || session.reconnecting) return
    session.reconnecting = true
    const reason = bounded(rawReason, 512) ?? 'observer disconnected'
    const current = session.observerHandle

    this.acceptAdapterEvent(session, {
      kind: 'observer.degraded',
      payload: {
        reason: `observer disconnected: ${reason}`,
        remaining: session.capabilities
      },
      nativeId: `observer-disconnected:${session.sessionId}`
    })

    try {
      if (session.reconnectAttempted || !current?.reconnect) {
        throw new Error('observer does not support reconnect')
      }
      session.reconnectAttempted = true
      const replacement = await current.reconnect()
      if (session.finalized) {
        await disposeResources([
          {
            label: 'late reconnected observer',
            dispose: () => replacement.dispose()
          }
        ])
        return
      }

      session.unsubscribeDisconnect?.()
      session.unsubscribeDisconnect = null
      await disposeResources([
        { label: 'disconnected observer', dispose: () => current.dispose() }
      ])
      this.bindObserverHandle(session, replacement)
      const reconnectedCapabilities =
        replacement.capabilities ?? session.capabilities
      if (
        JSON.stringify(reconnectedCapabilities) !==
        JSON.stringify(session.capabilities)
      ) {
        session.capabilities = reconnectedCapabilities
        this.acceptAdapterEvent(session, {
          kind: 'observer.degraded',
          payload: {
            reason: 'observer reconnected with changed capabilities',
            remaining: reconnectedCapabilities
          },
          nativeId: `observer-reconnected-capabilities:${session.sessionId}`
        })
      }
    } catch (error) {
      session.unsubscribeDisconnect?.()
      session.unsubscribeDisconnect = null
      await disposeResources([
        current
          ? {
              label: 'disconnected observer',
              dispose: () => current.dispose()
            }
          : undefined,
        session.prepared
          ? {
              label: 'prepared observer after reconnect failure',
              dispose: () => session.prepared!.dispose()
            }
          : undefined
      ])
      session.observerHandle = null
      session.prepared = null
      session.capabilities = NO_OBSERVER_CAPABILITIES
      this.acceptAdapterEvent(session, {
        kind: 'observer.degraded',
        payload: {
          reason: `observer reconnect failed: ${String(error).slice(0, 512)}`,
          remaining: NO_OBSERVER_CAPABILITIES
        },
        nativeId: `observer-reconnect-failed:${session.sessionId}`
      })
    } finally {
      session.reconnecting = false
    }
  }

  private async finalize(
    session: ActiveAgentSession,
    quiet: boolean
  ): Promise<void> {
    if (session.cleanupPromise) return session.cleanupPromise
    session.finalized = true
    session.cleanupPromise = this.runFinalize(session, quiet)
    return session.cleanupPromise
  }

  private async runFinalize(
    session: ActiveAgentSession,
    quiet: boolean
  ): Promise<void> {
    if (session.idleTimer) {
      clearInterval(session.idleTimer)
      session.idleTimer = null
    }
    session.unsubscribeExit?.()
    session.unsubscribeExit = null
    session.unsubscribeDisconnect?.()
    session.unsubscribeDisconnect = null
    session.unsubscribeInput?.()
    session.unsubscribeInput = null
    if (session.handshakeTimer) clearTimeout(session.handshakeTimer)
    session.handshakeTimer = null

    // 排空剩余队列（exited 后的迟到事件被归约器忽略，不丢也不重复投影）。
    const rest = session.queue.flush()
    if (rest.length > 0) {
      for (const event of rest) {
        const nextProjection = reduceAgentSession(session.projection, event)
        if (nextProjection === session.projection) continue
        session.projection = nextProjection
        const history = session.projector.record(event)
        if (history) {
          this.deps.history.record(history).catch(() => {})
        }
      }
    }

    try {
      await disposeResources([
        session.observerHandle
          ? {
              label: 'observer handle',
              dispose: () => session.observerHandle!.dispose()
            }
          : undefined,
        session.prepared
          ? {
              label: 'prepared observer',
              dispose: () => session.prepared!.dispose()
            }
          : undefined
      ])
      session.observerHandle = null
      session.prepared = null

      if (!quiet) {
        this.deps.options.broadcast(
          AgentEventChannel.Projection,
          session.projection
        )
      }
    } finally {
      await rm(session.runDir, { recursive: true, force: true }).catch(
        (error) => {
          console.error('[agent-runtime] run directory cleanup failed:', error)
        }
      )
      this.sessions.delete(session.sessionId)
    }
  }

  // ───── Idle 计时（PLAN-S1 §6.2：由主进程显式生成事实，renderer 不猜） ─────

  private checkIdle(session: ActiveAgentSession): void {
    if (session.finalized) return
    const projection = session.projection
    if (
      projection.status === 'exited' ||
      projection.pendingAttentionCount > 0
    ) {
      return
    }
    if (
      projection.status !== 'working' ||
      !capabilitiesHaveSemantics(session.capabilities) ||
      (this.deps.pty.isRunning && !this.deps.pty.isRunning(session.ptyId))
    ) {
      return
    }
    const now = Date.now()
    const lastOutputAt = this.deps.pty.lastOutputAt?.(session.ptyId) ?? 0
    const since = Math.max(projection.lastActivityAt, lastOutputAt)
    if (
      this.options.silenceAfterMs > 0 &&
      projection.observerHealth === 'healthy' &&
      !projection.correlation.lowConfidenceIdle &&
      now - since >= this.options.silenceAfterMs
    ) {
      this.acceptAdapterEvent(session, {
        kind: 'observer.degraded',
        payload: {
          reason: 'silent-session',
          remaining: session.capabilities
        },
        nativeId: `silent-session:${session.sessionId}:${since}`
      })
      this.acceptAdapterEvent(session, {
        kind: 'session.idle',
        payload: { since, reason: 'observer-silence', confidence: 'low' },
        nativeId: `silence:${session.sessionId}:${since}`
      })
    }
  }
}

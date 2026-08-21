import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { CliInstallation } from '../../shared/ipc-contract'
import {
  DshEventChannel,
  type DshHomeMode,
  type DshHostStatus,
  type DshRetentionPolicy,
  type DshRuntimeCandidate,
  type DshRuntimeConfig,
  type DshRuntimePreference,
  type DshRuntimeScanReport
} from '../../shared/dsh-ipc'
import {
  DSH_CLI_DEFINITION_ID,
  type AiCliDiscoveryService
} from '../ai-cli-discovery'
import { getMainPrefs, persistMainPrefs } from '../main-prefs'
import { resolveNativeDshHome, resolveWslDshHome } from '../app-paths'
import {
  DSH_WSL_PID_MARKER,
  buildDshExternalSpawnSpec,
  dshCandidateFromInstallation,
  dshRejectedNoOpenOption,
  dshWebOpensBrowserByDefault,
  selectDshRuntimeCandidates
} from './DshRuntime'

/**
 * DshHostManager —— 对外只暴露一个 DSH Web host，内部由当前主机安装或
 * 指定 WSL 发行版提供。未发现安装时不启动。surface / wire / projector
 * 不需要知道运行时来自哪里，始终只消费通过能力门禁的 loopback baseUrl。
 */

const HOST_STARTUP_TIMEOUT_MS = 30_000
const HOST_READY_POLL_MS = 250
const OUTPUT_TAIL_LIMIT = 32 * 1024
const REQUIRED_CONTROL_PLANE_METHODS = [
  'session.list',
  'workspace.list'
] as const

function dshHomeOverride(): string | undefined {
  return process.env['HRACK_DSH_HOME']?.trim() || undefined
}

interface ManagedDshChild {
  readonly pid?: number
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  kill(): void
  onceExit(listener: (code: number | null, error?: Error) => void): void
}

interface DshLaunchTarget {
  candidate: DshRuntimeCandidate
  installation?: CliInstallation
}

function wrapSpawnedProcess(child: ChildProcess): ManagedDshChild {
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => {
      child.kill()
    },
    onceExit: (listener) => {
      let settled = false
      const finish = (code: number | null, error?: Error): void => {
        if (settled) return
        settled = true
        listener(code, error)
      }
      child.once('error', (error) => finish(null, error))
      child.once('exit', (code) => finish(code))
    }
  }
}

export interface DshHostManagerOptions {
  /** 默认 DSH_HOME（<userData>/dsh-home），由 main 注入。 */
  defaultDshHome: string
  discovery: Pick<
    AiCliDiscoveryService,
    'scanDefinition' | 'runtimeEnvironment' | 'runtimeHome'
  >
  broadcast: (channel: string, payload: DshHostStatus) => void
  onBecameReady?: () => void
  onLeftReady?: () => void
}

/** 预分配一个 Windows/当前主机 loopback 空闲端口。 */
function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'object' && !address.port) {
        server.close()
        reject(new Error('failed to allocate a loopback port'))
        return
      }
      const port = typeof address === 'object' ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function isRuntimePreference(value: unknown): value is DshRuntimePreference {
  if (!value || typeof value !== 'object') return false
  const raw = value as { kind?: unknown; installationId?: unknown }
  return (
    raw.kind === 'auto' ||
    (
      raw.kind === 'installation' &&
      typeof raw.installationId === 'string' &&
      raw.installationId.length > 0 &&
      raw.installationId.length <= 4_096
    )
  )
}

function trimPosixHome(home: string): string {
  return home === '/' ? '' : home.replace(/\/+$/, '')
}

export class DshHostManager {
  private child: ManagedDshChild | null = null
  private status: DshHostStatus = { state: 'stopped' }
  private starting: Promise<DshHostStatus> | null = null
  private outputTail = ''
  private activeWslProcess: { distro: string; pid: number } | null = null
  private activeWindowsProcessTreePid: number | null = null
  private activePosixProcessGroupPid: number | null = null

  constructor(private readonly options: DshHostManagerOptions) {}

  getStatus(): DshHostStatus {
    return this.status
  }

  /** 内置版与 native 安装沿用现有 Windows/macOS/Linux DSH_HOME 语义。 */
  resolveHome(): string {
    const override = dshHomeOverride()
    if (override) return override
    const mode = getMainPrefs().dshHomeMode
    return resolveNativeDshHome(
      mode,
      app.getPath('home'),
      this.options.defaultDshHome
    )
  }

  getConfig(): DshRuntimeConfig {
    const prefs = getMainPrefs()
    return {
      homeMode: prefs.dshHomeMode,
      isolatedHome: this.options.defaultDshHome,
      sharedHome: join(app.getPath('home'), '.dsh'),
      activeHome: this.status.dshHome ?? this.resolveHome(),
      envOverride: Boolean(dshHomeOverride()),
      retention: prefs.dshRetention,
      runtimePreference: prefs.dshRuntimePreference,
      activeRuntime: this.status.activeRuntime
    }
  }

  async scanRuntimes(force = false): Promise<DshRuntimeScanReport> {
    const report = await this.options.discovery.scanDefinition(
      DSH_CLI_DEFINITION_ID,
      force
    )
    const localCandidates = report.installations.map(
      dshCandidateFromInstallation
    )
    return {
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      candidates: selectDshRuntimeCandidates(
        { kind: 'auto' },
        localCandidates
      ),
      runtimeErrors: report.runtimeErrors
    }
  }

  async setRuntime(
    preference: DshRuntimePreference
  ): Promise<DshHostStatus> {
    if (!isRuntimePreference(preference)) {
      throw new Error('invalid dsh runtime preference')
    }
    const shouldRestart = this.status.state !== 'stopped'
    await persistMainPrefs({ dshRuntimePreference: preference })
    return shouldRestart ? this.restart() : this.status
  }

  async setHomeMode(mode: DshHomeMode): Promise<DshHostStatus> {
    if (mode !== 'isolated' && mode !== 'shared') {
      throw new Error('invalid dsh home mode')
    }
    await persistMainPrefs({ dshHomeMode: mode })
    return this.restart()
  }

  async setRetention(policy: DshRetentionPolicy): Promise<DshRuntimeConfig> {
    await persistMainPrefs({ dshRetention: policy })
    return this.getConfig()
  }

  async restart(): Promise<DshHostStatus> {
    await this.stop()
    return this.ensureStarted()
  }

  /** 幂等启动；starting 中的并发调用共享同一个 Promise。 */
  ensureStarted(): Promise<DshHostStatus> {
    if (this.status.state === 'ready') return Promise.resolve(this.status)
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async stop(): Promise<DshHostStatus> {
    await this.stopChild()
    this.setStatus({
      state: 'stopped',
      dshHome: this.status.dshHome,
      activeRuntime: this.status.activeRuntime
    })
    return this.status
  }

  async dispose(): Promise<void> {
    await this.stop()
  }

  private setStatus(next: DshHostStatus): void {
    const previous = this.status.state
    this.status = next
    this.options.broadcast(DshEventChannel.StatusChanged, next)
    if (previous !== 'ready' && next.state === 'ready') {
      this.options.onBecameReady?.()
    } else if (previous === 'ready' && next.state !== 'ready') {
      this.options.onLeftReady?.()
    }
  }

  private appendOutput(chunk: string): void {
    this.outputTail = (this.outputTail + chunk).slice(-OUTPUT_TAIL_LIMIT)
  }

  private async resolveLaunchTargets(): Promise<DshLaunchTarget[]> {
    const preference = getMainPrefs().dshRuntimePreference
    let report: Awaited<
      ReturnType<AiCliDiscoveryService['scanDefinition']>
    >
    try {
      report = await this.options.discovery.scanDefinition(
        DSH_CLI_DEFINITION_ID,
        false
      )
    } catch (error) {
      this.appendOutput(`runtime scan failed: ${String(error)}\n`)
      throw error
    }
    const installations = new Map(
      report.installations.map((installation) => [installation.id, installation])
    )
    const localCandidates = report.installations.map(
      dshCandidateFromInstallation
    )
    const selected = selectDshRuntimeCandidates(preference, localCandidates)
    if (selected.length === 0) {
      throw new Error(
        'No DeepSeek Harness installation was found; install dsh to use this surface'
      )
    }
    return selected.map((candidate) => ({
      candidate,
      installation: installations.get(candidate.id)
    }))
  }

  private resolveTargetHome(target: DshLaunchTarget): string {
    if (
      target.candidate.kind !== 'installation' ||
      target.candidate.runtime.kind !== 'wsl'
    ) {
      return this.resolveHome()
    }
    const override = dshHomeOverride()
    if (override) {
      if (!override.startsWith('/') || override.includes('\0')) {
        throw new Error(
          'HRACK_DSH_HOME must be a Linux absolute path for a WSL DSH runtime'
        )
      }
      return override
    }
    if (!target.installation) {
      throw new Error('selected WSL DSH installation is missing')
    }
    const home = this.options.discovery.runtimeHome(target.installation)
    if (!home || !home.startsWith('/') || home.includes('\0')) {
      throw new Error(
        `cannot resolve HOME for ${target.candidate.runtime.distro}`
      )
    }
    return resolveWslDshHome(getMainPrefs().dshHomeMode, trimPosixHome(home))
  }

  private async start(): Promise<DshHostStatus> {
    this.outputTail = ''
    this.setStatus({ state: 'starting' })
    try {
      const targets = await this.resolveLaunchTargets()
      const failures: string[] = []
      for (const target of targets) {
        try {
          return await this.startTarget(target)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          failures.push(`${target.candidate.id}: ${detail}`)
          this.appendOutput(`\n[${target.candidate.id}] ${detail}\n`)
          await this.stopChild()
        }
      }
      throw new Error(failures.join('\n'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.stopChild()
      this.setStatus({
        state: 'failed',
        dshHome: this.status.dshHome,
        activeRuntime: this.status.activeRuntime,
        error: `${message}\n${this.outputTail.slice(-2048)}`
      })
      return this.status
    }
  }

  private async startTarget(target: DshLaunchTarget): Promise<DshHostStatus> {
    const dshHome = this.resolveTargetHome(target)
    const port = await allocatePort()
    const preferNoOpen = dshWebOpensBrowserByDefault(target.candidate.version)
    try {
      return await this.bootTarget(target, port, dshHome, preferNoOpen)
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (!preferNoOpen || !dshRejectedNoOpenOption(this.outputTail)) {
        throw error
      }
      console.warn('[dsh-host] --no-open rejected; retrying without it')
      await this.stopChild()
      this.outputTail = ''
      return this.bootTarget(target, port, dshHome, false)
    }
  }

  private async bootTarget(
    target: DshLaunchTarget,
    port: number,
    dshHome: string,
    noOpen: boolean
  ): Promise<DshHostStatus> {
    const baseUrl = `http://127.0.0.1:${port}`
    const child = this.spawnTarget(target, port, dshHome, noOpen)
    this.child = child
    this.activeWslProcess = null
    this.activeWindowsProcessTreePid =
      target.candidate.kind === 'installation' &&
      target.candidate.runtime.kind === 'host' &&
      target.candidate.runtime.platform === 'windows' &&
      child.pid
        ? child.pid
        : null
    this.activePosixProcessGroupPid =
      target.candidate.kind === 'installation' &&
      target.candidate.runtime.kind === 'host' &&
      target.candidate.runtime.platform !== 'windows' &&
      child.pid
        ? child.pid
        : null
    let ready = false

    const handleOutput = (data: Buffer | string, isError: boolean): void => {
      const text = data.toString()
      this.appendOutput(text)
      if (
        target.candidate.kind === 'installation' &&
        target.candidate.runtime.kind === 'wsl'
      ) {
        const match = this.outputTail.match(
          new RegExp(`${DSH_WSL_PID_MARKER}(\\d+)`)
        )
        const pid = Number(match?.[1])
        if (Number.isSafeInteger(pid) && pid > 1) {
          this.activeWslProcess = {
            distro: target.candidate.runtime.distro,
            pid
          }
        }
      }
      const clean = text.trimEnd()
      if (!clean) return
      if (isError) console.error('[dsh-host]', clean)
      else console.log('[dsh-host]', clean)
    }
    child.stdout?.on('data', (data: Buffer) => handleOutput(data, false))
    child.stderr?.on('data', (data: Buffer) => handleOutput(data, true))
    child.onceExit((code, error) => {
      if (this.child !== child) return
      this.child = null
      this.activeWslProcess = null
      this.activeWindowsProcessTreePid = null
      this.activePosixProcessGroupPid = null
      if (!ready) return
      this.setStatus({
        state: 'failed',
        dshHome,
        activeRuntime: target.candidate,
        error: error
          ? `dsh host failed: ${error.message}`
          : `dsh host exited (code ${code}). tail:\n${this.outputTail.slice(-2048)}`
      })
    })
    this.setStatus({
      state: 'starting',
      dshHome,
      pid: child.pid,
      activeRuntime: target.candidate
    })
    console.log(
      '[dsh-host] started',
      target.candidate.id,
      'port',
      port,
      'home',
      dshHome
    )
    await this.waitReady(baseUrl, HOST_STARTUP_TIMEOUT_MS)
    if (this.child !== child) {
      throw new Error('dsh host exited before becoming ready')
    }
    ready = true
    this.setStatus({
      state: 'ready',
      dshHome,
      baseUrl,
      pid: child.pid,
      activeRuntime: target.candidate
    })
    return this.status
  }

  private spawnTarget(
    target: DshLaunchTarget,
    port: number,
    dshHome: string,
    noOpen?: boolean
  ): ManagedDshChild {
    if (!target.installation) {
      throw new Error('selected DSH installation is missing')
    }
    const spec = buildDshExternalSpawnSpec({
      candidate: target.candidate,
      port,
      dshHome,
      environmentPath:
        this.options.discovery.runtimeEnvironment(target.installation).PATH,
      commandInterpreter: process.env.ComSpec,
      inheritedEnv: process.env,
      noOpen
    })
    const detached =
      target.candidate.runtime.kind === 'host' &&
      target.candidate.runtime.platform !== 'windows'
    return wrapSpawnedProcess(spawn(spec.file, spec.args, {
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments ?? false
    }))
  }

  private async stopChild(): Promise<void> {
    const child = this.child
    const remote = this.activeWslProcess
    const windowsTreePid = this.activeWindowsProcessTreePid
    const posixGroupPid = this.activePosixProcessGroupPid
    this.child = null
    this.activeWslProcess = null
    this.activeWindowsProcessTreePid = null
    this.activePosixProcessGroupPid = null
    if (remote) await this.terminateWslProcess(remote)
    if (windowsTreePid) await this.terminateWindowsProcessTree(windowsTreePid)
    if (posixGroupPid) {
      try {
        process.kill(-posixGroupPid, 'SIGTERM')
      } catch {
        // Already exited.
      }
    }
    child?.kill()
  }

  /** npm 的 dsh.cmd 会再拉起 node；只 kill cmd 会留下真正的 host。 */
  private terminateWindowsProcessTree(pid: number): Promise<void> {
    return new Promise((resolve) => {
      execFile(
        'taskkill.exe',
        ['/pid', String(pid), '/t', '/f'],
        { timeout: 3_000, windowsHide: true },
        () => resolve()
      )
    })
  }

  /** 先按捕获到的 Linux PID 结束目标，再回收 wsl.exe，避免遗留 host。 */
  private terminateWslProcess(target: { distro: string; pid: number }): Promise<void> {
    return new Promise((resolve) => {
      execFile(
        'wsl.exe',
        [
          '--distribution', target.distro,
          '--exec', 'kill', '-TERM', String(target.pid)
        ],
        { timeout: 2_000, windowsHide: true },
        () => resolve()
      )
    })
  }

  /**
   * 静态首页会早于 RPC control plane 开始响应。只有 projector 依赖的
   * RPC 均成功后，host 才能进入 ready；这同时是本机/WSL 的能力门禁。
   */
  private async waitReady(baseUrl: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown = null
    while (Date.now() < deadline) {
      if (!this.child) throw new Error('dsh host exited before becoming ready')
      try {
        for (const method of REQUIRED_CONTROL_PLANE_METHODS) {
          const rpcId = crypto.randomUUID()
          const response = await fetch(`${baseUrl}/api/${method}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'client-request',
              rpcId,
              method,
              payload: {}
            }),
            signal: AbortSignal.timeout(2000)
          })
          if (!response.ok) throw new Error(`${method} HTTP ${response.status}`)
          const envelope = (await response.json()) as {
            result?: { ok?: boolean; error?: { message?: string } }
          }
          if (envelope.result?.ok !== true) {
            throw new Error(
              envelope.result?.error?.message ?? `${method} is not ready`
            )
          }
        }
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, HOST_READY_POLL_MS))
      }
    }
    throw new Error(
      `dsh host did not become ready within ${timeoutMs}ms: ${String(lastError)}`
    )
  }
}

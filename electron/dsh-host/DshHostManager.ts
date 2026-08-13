import { app, utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import {
  DshEventChannel,
  type DshHomeMode,
  type DshHostStatus,
  type DshRetentionPolicy,
  type DshRuntimeConfig
} from '../../shared/dsh-ipc'
import { getMainPrefs, persistMainPrefs } from '../main-prefs'

/**
 * DshHostManager —— 以内置 utilityProcess 运行 dsh 的 web profile。
 *
 * 形态选择（PLAN-DSH-INTEGRATION §2）：fork @deepseek-ai/dsh 自带的
 * lib/bin.js（`dsh web --host 127.0.0.1 --port <预分配>`），把 dsh 当黑盒，
 * 不 import 其内部模块——上游 rc 阶段内部导出随时会变，bin 是唯一稳定入口。
 * utilityProcess 提供纯 Node 语义（无 Chromium），崩溃与主进程隔离。
 *
 * DSH_HOME 默认指向 vibing 私有目录（<userData>/dsh-home），与命令行 dsh
 * 互不污染；首次 boot 时 dsh 会自动初始化 profile 并把安装目录依赖闭包
 * 链接进 $DSH_HOME/profiles/node_modules（dsh-app-boot 的
 * healProfilesModuleFallback），全程不需要 pnpm/网络。
 */

const HOST_STARTUP_TIMEOUT_MS = 60_000
const HOST_READY_POLL_MS = 250
const OUTPUT_TAIL_LIMIT = 32 * 1024

export interface DshHostManagerOptions {
  /** 默认 DSH_HOME（<userData>/dsh-home），由 main 注入。 */
  defaultDshHome: string
  broadcast: (channel: string, payload: DshHostStatus) => void
  onBecameReady?: () => void
  onLeftReady?: () => void
}

/** 预分配一个 127.0.0.1 空闲端口。listen(0) → 取端口 → close 存在竞态，
 *  但仅本机开发面；host 绑定失败会落入 failed 态并可重启，可接受。 */
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

const DSH_BIN_SEGMENTS = [
  'dsh-runtime',
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'lib',
  'bin.js'
] as const

/**
 * 解析内置 dsh CLI 入口。dsh 全家桶住在隔离子树 dsh-runtime/（单一扁平
 * node_modules，npm 提升不再拆散家族——cordis Loader 按 importer 实路径
 * 向上查找插件，跨树混布会 ERR_MODULE_NOT_FOUND）。
 *
 * 不要用 app.getAppPath()：e2e / `electron <script>` 会把它指到脚本目录
 * （out/main 或 scripts），而不是仓库根。unpackaged 从本文件编译产物
 * （out/main）上两级回到 repo；packaged 走 extraResources。
 */
export function resolveDshBinPath(): string {
  const relative = join(...DSH_BIN_SEGMENTS)
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, relative)]
    : [
        join(__dirname, '..', '..', relative),
        join(process.cwd(), relative)
      ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(`dsh bin not found. tried:\n${candidates.join('\n')}`)
  }
  return found
}

export class DshHostManager {
  private child: UtilityProcess | null = null
  private status: DshHostStatus = { state: 'stopped' }
  private starting: Promise<DshHostStatus> | null = null
  private outputTail = ''

  constructor(private readonly options: DshHostManagerOptions) {}

  getStatus(): DshHostStatus {
    return this.status
  }

  resolveHome(): string {
    const override = process.env['VIBING_DSH_HOME']
    if (override && override.trim().length > 0) return override.trim()
    const mode = getMainPrefs().dshHomeMode
    if (mode === 'shared') return join(app.getPath('home'), '.dsh')
    return this.options.defaultDshHome
  }

  getConfig(): DshRuntimeConfig {
    const prefs = getMainPrefs()
    return {
      homeMode: prefs.dshHomeMode,
      isolatedHome: this.options.defaultDshHome,
      sharedHome: join(app.getPath('home'), '.dsh'),
      activeHome: this.status.dshHome ?? this.resolveHome(),
      envOverride: Boolean(process.env['VIBING_DSH_HOME']?.trim()),
      retention: prefs.dshRetention
    }
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
    const child = this.child
    this.child = null
    if (child) {
      child.kill()
    }
    this.setStatus({ state: 'stopped', dshHome: this.status.dshHome })
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

  private async start(): Promise<DshHostStatus> {
    const dshHome = this.resolveHome()
    this.setStatus({ state: 'starting', dshHome })
    try {
      const binPath = resolveDshBinPath()
      const port = await allocatePort()
      const baseUrl = `http://127.0.0.1:${port}`
      // cordis-plugin-hmr 需要 Node 内部 ESM loader；Electron 的 Node 没有
      // 预编译 node-addon-require-builtin，必须显式 --expose-internals，
      // 否则 host 打印 URL 后立刻以 "HMR service" 崩掉。
      const child = utilityProcess.fork(binPath, [
        'web',
        '--host', '127.0.0.1',
        '--port', String(port)
      ], {
        serviceName: 'dsh-host',
        stdio: ['ignore', 'pipe', 'pipe'],
        execArgv: ['--expose-internals'],
        env: {
          ...process.env,
          DSH_HOME: dshHome,
          // 内嵌形态默认关闭遥测；用户仍可在共享 ~/.dsh 模式下自行管理。
          DSH_TELEMETRY_DISABLED: process.env['DSH_TELEMETRY_DISABLED'] ?? '1'
        }
      })
      console.log('[dsh-host] forked', binPath, 'port', port, 'home', dshHome)
      this.child = child
      this.outputTail = ''
      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString('utf8')
        this.appendOutput(text)
        console.log('[dsh-host]', text.trimEnd())
      })
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString('utf8')
        this.appendOutput(text)
        console.error('[dsh-host]', text.trimEnd())
      })
      child.once('exit', (code) => {
        if (this.child !== child) return
        this.child = null
        // ready 之前退出 = 启动失败；ready 之后退出 = 异常崩溃（P1 再做自动重启）。
        this.setStatus({
          state: 'failed',
          dshHome,
          error: `dsh host exited (code ${code}). tail:\n${this.outputTail.slice(-2048)}`
        })
      })
      this.setStatus({ state: 'starting', dshHome, pid: child.pid })
      await this.waitReady(baseUrl)
      this.setStatus({ state: 'ready', dshHome, baseUrl, pid: child.pid })
      return this.status
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.stop()
      this.setStatus({
        state: 'failed',
        dshHome,
        error: `${message}\n${this.outputTail.slice(-2048)}`
      })
      return this.status
    }
  }

  /** host 起来后任意 HTTP 响应（含 404）都说明 server 已监听。 */
  private async waitReady(baseUrl: string): Promise<void> {
    const deadline = Date.now() + HOST_STARTUP_TIMEOUT_MS
    let lastError: unknown = null
    while (Date.now() < deadline) {
      if (!this.child) throw new Error('dsh host exited before becoming ready')
      try {
        await fetch(baseUrl + '/', { signal: AbortSignal.timeout(2000) })
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, HOST_READY_POLL_MS))
      }
    }
    throw new Error(
      `dsh host did not become ready within ${HOST_STARTUP_TIMEOUT_MS}ms: ${String(lastError)}`
    )
  }
}

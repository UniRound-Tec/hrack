import type { UpdateSnapshot } from '../../shared/ipc-contract'
import type {
  UpdateDescriptor,
  UpdateDriver,
  UpdateTransfer
} from './UpdateDriver'

const DEFAULT_INITIAL_CHECK_DELAY_MS = 10_000
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000

export interface UpdateServiceOptions {
  enabled: boolean
  currentVersion: string
  driver: UpdateDriver
  broadcast(snapshot: UpdateSnapshot): void
  beforeInstall(): Promise<void>
  now?: () => number
  autoDownload?: boolean
  initialCheckDelayMs?: number
  checkIntervalMs?: number
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function progressSnapshot(progress: UpdateTransfer) {
  return {
    percent: Math.min(100, finiteNonNegative(progress.percent)),
    transferred: finiteNonNegative(progress.transferred),
    total: finiteNonNegative(progress.total),
    bytesPerSecond: finiteNonNegative(progress.bytesPerSecond)
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.trim() || 'Unknown update error').slice(0, 512)
}

/**
 * Owns one authoritative update snapshot. Driver events replace the visible
 * phase directly; there is deliberately no second transition/state-machine layer.
 */
export class UpdateService {
  private state: UpdateSnapshot
  private readonly now: () => number
  private readonly autoDownload: boolean
  private readonly initialCheckDelayMs: number
  private readonly checkIntervalMs: number
  private readonly unsubscribeDriver: (() => void) | null
  private checkPromise: Promise<UpdateSnapshot> | null = null
  private downloadPromise: Promise<UpdateSnapshot> | null = null
  private installPromise: Promise<void> | null = null
  private automaticTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(private readonly options: UpdateServiceOptions) {
    this.now = options.now ?? Date.now
    this.autoDownload = options.autoDownload ?? true
    this.initialCheckDelayMs =
      options.initialCheckDelayMs ?? DEFAULT_INITIAL_CHECK_DELAY_MS
    this.checkIntervalMs =
      options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
    this.state = {
      phase: options.enabled ? 'idle' : 'disabled',
      currentVersion: options.currentVersion,
      availableVersion: null,
      releaseDate: null,
      releaseNotes: null,
      progress: null,
      checkedAt: null,
      error: null
    }
    this.unsubscribeDriver = options.enabled
      ? options.driver.subscribe({
          checking: () => this.publish({ phase: 'checking', error: null }),
          available: (update) => this.onAvailable(update),
          notAvailable: (update) => this.onNotAvailable(update),
          progress: (progress) => this.onProgress(progress),
          downloaded: (update) => this.onDownloaded(update),
          cancelled: () => this.onError(new Error('Update download was cancelled.')),
          error: (error) => this.onError(error)
        })
      : null
  }

  getState(): UpdateSnapshot {
    return {
      ...this.state,
      progress: this.state.progress ? { ...this.state.progress } : null
    }
  }

  startAutomaticChecks(): void {
    if (!this.options.enabled || this.disposed || this.automaticTimer) return
    this.scheduleAutomaticCheck(this.initialCheckDelayMs)
  }

  async check(): Promise<UpdateSnapshot> {
    if (!this.options.enabled || this.disposed) return this.getState()
    if (this.state.phase === 'downloading' || this.state.phase === 'downloaded') {
      return this.getState()
    }
    if (this.checkPromise) return this.checkPromise

    this.publish({ phase: 'checking', error: null })
    const task = (async () => {
      try {
        await this.options.driver.checkForUpdates()
      } catch (error) {
        this.onError(error)
      }
      return this.getState()
    })()
    this.checkPromise = task
    void task.finally(() => {
      if (this.checkPromise === task) this.checkPromise = null
    })
    return task
  }

  async download(): Promise<UpdateSnapshot> {
    if (!this.options.enabled || this.disposed) return this.getState()
    if (!this.state.availableVersion || this.state.phase === 'downloaded') {
      return this.getState()
    }
    if (this.downloadPromise) return this.downloadPromise

    this.publish({ phase: 'downloading', error: null })
    const task = (async () => {
      try {
        await this.options.driver.downloadUpdate()
      } catch (error) {
        this.onError(error)
      }
      return this.getState()
    })()
    this.downloadPromise = task
    void task.finally(() => {
      if (this.downloadPromise === task) this.downloadPromise = null
    })
    return task
  }

  async install(): Promise<void> {
    if (!this.options.enabled || this.disposed) return
    if (this.state.phase !== 'downloaded') {
      throw new Error('Update is not ready to install.')
    }
    if (this.installPromise) return this.installPromise

    const task = (async () => {
      try {
        await this.options.beforeInstall()
        this.options.driver.quitAndInstall()
      } catch (error) {
        this.onError(error)
        throw error
      }
    })()
    this.installPromise = task
    void task.finally(() => {
      if (this.installPromise === task) this.installPromise = null
    }).catch(() => {})
    return task
  }

  /** E2E/调试：不经过网络直接进入 available 状态，便于验证更新确认 UI。 */
  debugSetAvailable(version: string, releaseNotes: string | null = null): void {
    this.onAvailable({
      version,
      releaseDate: null,
      releaseNotes
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.automaticTimer) {
      clearTimeout(this.automaticTimer)
      this.automaticTimer = null
    }
    this.unsubscribeDriver?.()
  }

  private publish(patch: Partial<UpdateSnapshot>): void {
    this.state = { ...this.state, ...patch }
    this.options.broadcast(this.getState())
  }

  private onAvailable(update: UpdateDescriptor): void {
    this.publish({
      phase: 'available',
      availableVersion: update.version,
      releaseDate: update.releaseDate,
      releaseNotes: update.releaseNotes ?? null,
      progress: null,
      checkedAt: this.now(),
      error: null
    })
    if (this.autoDownload) void this.download()
  }

  private onNotAvailable(update: UpdateDescriptor): void {
    this.publish({
      phase: 'up-to-date',
      availableVersion: null,
      releaseDate: update.releaseDate,
      releaseNotes: null,
      progress: null,
      checkedAt: this.now(),
      error: null
    })
  }

  private onProgress(progress: UpdateTransfer): void {
    this.publish({
      phase: 'downloading',
      progress: progressSnapshot(progress),
      error: null
    })
  }

  private onDownloaded(update: UpdateDescriptor): void {
    this.publish({
      phase: 'downloaded',
      availableVersion: update.version,
      releaseDate: update.releaseDate,
      releaseNotes: update.releaseNotes ?? null,
      progress: this.state.progress
        ? { ...this.state.progress, percent: 100 }
        : { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
      checkedAt: this.now(),
      error: null
    })
  }

  private onError(error: unknown): void {
    this.publish({
      phase: 'error',
      checkedAt: this.now(),
      error: safeError(error)
    })
  }

  private scheduleAutomaticCheck(delay: number): void {
    if (this.disposed || !this.options.enabled) return
    this.automaticTimer = setTimeout(() => {
      this.automaticTimer = null
      void this.check().finally(() => {
        this.scheduleAutomaticCheck(this.checkIntervalMs)
      })
    }, Math.max(0, delay))
    this.automaticTimer.unref()
  }
}


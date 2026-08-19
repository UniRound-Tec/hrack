import { autoUpdater, type AppUpdater } from 'electron-updater'

export interface UpdateDescriptor {
  version: string
  releaseDate: string | null
  releaseNotes?: string | null
}

export interface UpdateTransfer {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface UpdateDriverHandlers {
  checking(): void
  available(update: UpdateDescriptor): void
  notAvailable(update: UpdateDescriptor): void
  progress(progress: UpdateTransfer): void
  downloaded(update: UpdateDescriptor): void
  cancelled(): void
  error(error: Error): void
}

/** Narrow seam around electron-updater so update policy can be tested offline. */
export interface UpdateDriver {
  subscribe(handlers: UpdateDriverHandlers): () => void
  checkForUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  quitAndInstall(): void
}

function releaseNotesText(
  releaseNotes: string | Array<{ note?: string | null }> | null | undefined
): string | null {
  if (typeof releaseNotes === 'string') return releaseNotes.trim() || null
  if (Array.isArray(releaseNotes)) {
    const text = releaseNotes
      .map((item) => item.note?.trim() ?? '')
      .filter(Boolean)
      .join('\n\n')
    return text || null
  }
  return null
}

function descriptor(info: {
  version: string
  releaseDate?: string
  releaseNotes?: string | Array<{ note?: string | null }> | null
}): UpdateDescriptor {
  return {
    version: info.version,
    releaseDate: typeof info.releaseDate === 'string' ? info.releaseDate : null,
    releaseNotes: releaseNotesText(info.releaseNotes)
  }
}

export class ElectronUpdaterDriver implements UpdateDriver {
  constructor(private readonly updater: AppUpdater = autoUpdater) {
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true
    updater.autoRunAppAfterInstall = true
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.disableWebInstaller = true
    updater.logger = {
      info: (...args: unknown[]) => console.info('[hrack:update]', ...args),
      warn: (...args: unknown[]) => console.warn('[hrack:update]', ...args),
      error: (...args: unknown[]) => console.error('[hrack:update]', ...args)
    }
  }

  subscribe(handlers: UpdateDriverHandlers): () => void {
    const onChecking = (): void => handlers.checking()
    const onAvailable = (info: {
      version: string
      releaseDate?: string
      releaseNotes?: string | Array<{ note?: string | null }> | null
    }): void => handlers.available(descriptor(info))
    const onNotAvailable = (info: {
      version: string
      releaseDate?: string
      releaseNotes?: string | Array<{ note?: string | null }> | null
    }): void => handlers.notAvailable(descriptor(info))
    const onProgress = (progress: UpdateTransfer): void =>
      handlers.progress(progress)
    const onDownloaded = (info: {
      version: string
      releaseDate?: string
      releaseNotes?: string | Array<{ note?: string | null }> | null
    }): void => handlers.downloaded(descriptor(info))
    const onCancelled = (): void => handlers.cancelled()
    const onError = (error: Error): void => handlers.error(error)

    this.updater.on('checking-for-update', onChecking)
    this.updater.on('update-available', onAvailable)
    this.updater.on('update-not-available', onNotAvailable)
    this.updater.on('download-progress', onProgress)
    this.updater.on('update-downloaded', onDownloaded)
    this.updater.on('update-cancelled', onCancelled)
    this.updater.on('error', onError)

    return () => {
      this.updater.removeListener('checking-for-update', onChecking)
      this.updater.removeListener('update-available', onAvailable)
      this.updater.removeListener('update-not-available', onNotAvailable)
      this.updater.removeListener('download-progress', onProgress)
      this.updater.removeListener('update-downloaded', onDownloaded)
      this.updater.removeListener('update-cancelled', onCancelled)
      this.updater.removeListener('error', onError)
    }
  }

  async checkForUpdates(): Promise<void> {
    await this.updater.checkForUpdates()
  }

  async downloadUpdate(): Promise<void> {
    await this.updater.downloadUpdate()
  }

  quitAndInstall(): void {
    // electron-updater 6.x uses positional arguments. Keep the installer visible
    // and relaunch HRack after it completes.
    this.updater.quitAndInstall(false, true)
  }
}


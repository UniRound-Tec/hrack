import { expect, test } from '@playwright/test'
import { UpdateService } from '../electron/update/UpdateService'
import type {
  UpdateDescriptor,
  UpdateDriver,
  UpdateDriverHandlers,
  UpdateTransfer
} from '../electron/update/UpdateDriver'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class FakeUpdateDriver implements UpdateDriver {
  handlers: UpdateDriverHandlers | null = null
  subscriptions = 0
  checks = 0
  downloads = 0
  installs = 0
  checkGate: Promise<void> = Promise.resolve()
  downloadGate: Promise<void> = Promise.resolve()

  subscribe(handlers: UpdateDriverHandlers): () => void {
    this.handlers = handlers
    this.subscriptions++
    return () => {
      if (this.handlers === handlers) this.handlers = null
    }
  }

  async checkForUpdates(): Promise<void> {
    this.checks++
    await this.checkGate
  }

  async downloadUpdate(): Promise<void> {
    this.downloads++
    await this.downloadGate
  }

  quitAndInstall(): void {
    this.installs++
  }

  checking(): void {
    this.handlers?.checking()
  }

  available(update: UpdateDescriptor): void {
    this.handlers?.available(update)
  }

  notAvailable(update: UpdateDescriptor): void {
    this.handlers?.notAvailable(update)
  }

  progress(update: UpdateTransfer): void {
    this.handlers?.progress(update)
  }

  downloaded(update: UpdateDescriptor): void {
    this.handlers?.downloaded(update)
  }

  error(error: Error): void {
    this.handlers?.error(error)
  }
}

function createService(
  driver: FakeUpdateDriver,
  options: {
    enabled?: boolean
    autoDownload?: boolean
    initialCheckDelayMs?: number
  } = {}
) {
  const broadcasts: string[] = []
  let installsPrepared = 0
  const service = new UpdateService({
    enabled: options.enabled ?? true,
    currentVersion: '0.3.0',
    driver,
    autoDownload: options.autoDownload,
    initialCheckDelayMs: options.initialCheckDelayMs,
    now: () => 1_234,
    broadcast: (snapshot) => broadcasts.push(snapshot.phase),
    beforeInstall: async () => {
      installsPrepared++
    }
  })
  return { service, broadcasts, installsPrepared: () => installsPrepared }
}

test('keeps development builds disabled without subscribing or checking', async () => {
  const driver = new FakeUpdateDriver()
  const { service, broadcasts } = createService(driver, { enabled: false })

  expect(service.getState()).toMatchObject({
    phase: 'disabled',
    currentVersion: '0.3.0'
  })
  await service.check()
  expect(driver.subscriptions).toBe(0)
  expect(driver.checks).toBe(0)
  expect(broadcasts).toEqual([])
})

test('starts an automatic check when startAutomaticChecks is called', async () => {
  const driver = new FakeUpdateDriver()
  const { service } = createService(driver, {
    autoDownload: false,
    initialCheckDelayMs: 5
  })

  service.startAutomaticChecks()
  await expect
    .poll(() => driver.checks, { timeout: 2_000 })
    .toBeGreaterThan(0)

  service.dispose()
})

test('deduplicates concurrent checks and lets the latest event replace the snapshot', async () => {
  const driver = new FakeUpdateDriver()
  const gate = deferred()
  driver.checkGate = gate.promise
  const { service } = createService(driver, { autoDownload: false })

  const first = service.check()
  const second = service.check()
  expect(driver.checks).toBe(1)
  expect(service.getState().phase).toBe('checking')

  driver.error(new Error('offline'))
  expect(service.getState().phase).toBe('error')
  driver.notAvailable({ version: '0.3.0', releaseDate: null })
  expect(service.getState()).toMatchObject({
    phase: 'up-to-date',
    checkedAt: 1_234,
    error: null
  })

  gate.resolve()
  await Promise.all([first, second])
  service.dispose()
})

test('automatically downloads an available update and reports progress', async () => {
  const driver = new FakeUpdateDriver()
  const gate = deferred()
  driver.downloadGate = gate.promise
  const { service, broadcasts } = createService(driver)

  driver.available({ version: '0.4.0', releaseDate: '2026-08-17' })
  expect(driver.downloads).toBe(1)
  expect(service.getState()).toMatchObject({
    phase: 'downloading',
    availableVersion: '0.4.0'
  })

  driver.progress({
    percent: 42.4,
    transferred: 424,
    total: 1_000,
    bytesPerSecond: 100
  })
  expect(service.getState().progress).toEqual({
    percent: 42.4,
    transferred: 424,
    total: 1_000,
    bytesPerSecond: 100
  })

  driver.downloaded({ version: '0.4.0', releaseDate: '2026-08-17' })
  expect(service.getState()).toMatchObject({
    phase: 'downloaded',
    availableVersion: '0.4.0',
    progress: { percent: 100 }
  })
  expect(broadcasts).toContain('available')
  expect(broadcasts.at(-1)).toBe('downloaded')

  gate.resolve()
  await Promise.resolve()
  service.dispose()
})

test('carries release notes into the available update snapshot', () => {
  const driver = new FakeUpdateDriver()
  const { service } = createService(driver, { autoDownload: false })

  driver.available({
    version: '0.4.0',
    releaseDate: '2026-08-17',
    releaseNotes: 'What’s new in 0.4.0'
  })
  expect(service.getState()).toMatchObject({
    phase: 'available',
    availableVersion: '0.4.0',
    releaseNotes: 'What’s new in 0.4.0'
  })
  expect(driver.downloads).toBe(0)

  service.dispose()
})

test('prepares shutdown exactly once before installing a downloaded update', async () => {
  const driver = new FakeUpdateDriver()
  const { service, installsPrepared } = createService(driver, {
    autoDownload: false
  })
  driver.downloaded({ version: '0.4.0', releaseDate: null })

  await Promise.all([service.install(), service.install()])
  expect(installsPrepared()).toBe(1)
  expect(driver.installs).toBe(1)
  service.dispose()
})


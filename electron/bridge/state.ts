import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface PersistedBridgeState {
  lastOpenCodeInstallationId?: string
}

export class BridgeStateStore {
  private lastOpenCodeInstallationId: string | null = null
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  static inUserData(userDataDir: string): BridgeStateStore {
    return new BridgeStateStore(join(userDataDir, 'bridge-state.json'))
  }

  async lastInstallationId(): Promise<string | null> {
    await this.load()
    return this.lastOpenCodeInstallationId
  }

  async rememberInstallation(installationId: string): Promise<void> {
    await this.load()
    if (this.lastOpenCodeInstallationId === installationId) return
    this.lastOpenCodeInstallationId = installationId
    this.writeQueue = this.writeQueue.then(() => this.save())
    await this.writeQueue
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as PersistedBridgeState
      if (
        typeof raw.lastOpenCodeInstallationId === 'string' &&
        raw.lastOpenCodeInstallationId.length > 0 &&
        raw.lastOpenCodeInstallationId.length <= 4_096
      ) {
        this.lastOpenCodeInstallationId = raw.lastOpenCodeInstallationId
      }
    } catch {
      this.lastOpenCodeInstallationId = null
    }
  }

  private async save(): Promise<void> {
    const payload: PersistedBridgeState = {}
    if (this.lastOpenCodeInstallationId) {
      payload.lastOpenCodeInstallationId = this.lastOpenCodeInstallationId
    }
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(
      this.filePath,
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf8'
    )
  }
}

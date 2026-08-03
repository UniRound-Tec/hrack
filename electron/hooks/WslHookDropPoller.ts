import { readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_DROP_BYTES = 1024 * 1024
const MAX_FILES_PER_TICK = 64

export class WslHookDropPoller {
  private timer: ReturnType<typeof setInterval> | null = null
  private consuming = false
  private disposed = false

  constructor(
    private readonly dropDir: string,
    private readonly listener: (payload: unknown) => void,
    private readonly intervalMs = 300
  ) {}

  start(): void {
    if (this.timer || this.disposed) return
    this.timer = setInterval(() => void this.consume(), this.intervalMs)
    void this.consume()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    while (this.consuming) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  private async consume(): Promise<void> {
    if (this.disposed || this.consuming) return
    this.consuming = true
    try {
      const names = (await readdir(this.dropDir))
        .filter((name) => name.endsWith('.json') && !name.includes('/') && !name.includes('\\'))
        .slice(0, MAX_FILES_PER_TICK)
      const ordered = await Promise.all(
        names.map(async (name) => ({ name, metadata: await stat(join(this.dropDir, name)) }))
      )
      ordered.sort(
        (left, right) =>
          left.metadata.mtimeMs - right.metadata.mtimeMs ||
          left.name.localeCompare(right.name)
      )
      for (const item of ordered) {
        const path = join(this.dropDir, item.name)
        const consumingPath = `${path}.consuming`
        try {
          await rename(path, consumingPath)
          const metadata = await stat(consumingPath)
          if (metadata.size <= 0 || metadata.size > MAX_DROP_BYTES) continue
          const payload = JSON.parse(await readFile(consumingPath, 'utf8')) as unknown
          this.listener(payload)
        } catch (error) {
          console.warn('[wsl-hook-poller] ignored invalid drop:', String(error))
        } finally {
          await rm(consumingPath, { force: true }).catch(() => {})
        }
      }
    } catch (error) {
      if (!this.disposed) console.warn('[wsl-hook-poller] consume failed:', String(error))
    } finally {
      this.consuming = false
    }
  }
}

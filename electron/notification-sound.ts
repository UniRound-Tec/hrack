import { session } from 'electron'
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink
} from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import {
  NOTIFICATION_SOUND_MAX_BYTES,
  NOTIFICATION_SOUND_SCHEME,
  isAllowedSoundExtension,
  mimeForSoundExtension,
  type NotificationSoundPickResult
} from '../shared/notification-sound'

export class NotificationSoundStore {
  constructor(
    private readonly directory: string,
    private readonly defaultSoundPath: string
  ) {}

  /**
   * 返回当前可播放文件：优先用户上传，其次打包默认 done.mp3。
   * 返回 null 表示当前没有可播放提示音。
   */
  async resolveCurrent(): Promise<{ path: string; mime: string } | null> {
    await mkdir(this.directory, { recursive: true })
    const uploaded = (await readdir(this.directory)).find((name) => {
      if (!name.toLowerCase().startsWith('current.')) return false
      return isAllowedSoundExtension(extname(name))
    })
    if (uploaded) {
      return {
        path: join(this.directory, uploaded),
        mime: mimeForSoundExtension(extname(uploaded))
      }
    }

    const extension = extname(this.defaultSoundPath)
    if (!isAllowedSoundExtension(extension)) return null
    try {
      const info = await stat(this.defaultSoundPath)
      if (!info.isFile()) return null
      return {
        path: this.defaultSoundPath,
        mime: mimeForSoundExtension(extension)
      }
    } catch {
      return null
    }
  }

  async importFile(sourcePath: string): Promise<NotificationSoundPickResult> {
    const extension = extname(sourcePath)
    if (!isAllowedSoundExtension(extension)) {
      throw new Error('unsupported-audio-type')
    }
    const info = await stat(sourcePath)
    if (!info.isFile()) {
      throw new Error('unsupported-audio-type')
    }
    if (info.size > NOTIFICATION_SOUND_MAX_BYTES) {
      throw new Error('audio-too-large')
    }

    await mkdir(this.directory, { recursive: true })
    const temporary = join(
      this.directory,
      `.import.${process.pid}.${Date.now()}.tmp`
    )
    const target = join(this.directory, `current${extension.toLowerCase()}`)
    try {
      await copyFile(sourcePath, temporary)
      await this.clearCurrentSounds()
      await rename(temporary, target)
    } finally {
      await unlink(temporary).catch(() => {})
    }

    return {
      name: basename(sourcePath),
      revision: Date.now()
    }
  }

  async clear(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    await this.clearCurrentSounds()
  }

  private async clearCurrentSounds(): Promise<void> {
    const entries = await readdir(this.directory).catch(() => [])
    await Promise.all(
      entries
        .filter((name) => name.toLowerCase().startsWith('current.'))
        .map((name) => unlink(join(this.directory, name)).catch(() => {}))
    )
  }
}

export function installNotificationSoundProtocol(
  store: NotificationSoundStore
): void {
  session.defaultSession.protocol.handle(
    NOTIFICATION_SOUND_SCHEME,
    async (request) => {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405 })
      }
      const file = await store.resolveCurrent()
      if (!file) return new Response('Not found', { status: 404 })
      try {
        const data = await readFile(file.path)
        return new Response(data, {
          headers: {
            'content-type': file.mime,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff'
          }
        })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    }
  )
}

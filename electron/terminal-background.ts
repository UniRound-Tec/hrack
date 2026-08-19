import { session } from 'electron'
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import {
  TERMINAL_BACKGROUND_MAX_BYTES,
  TERMINAL_BACKGROUND_SCHEME,
  isAllowedBackgroundExtension,
  mimeForImageExtension,
  type TerminalBackgroundPickResult
} from '../shared/terminal-background'

export class TerminalBackgroundStore {
  constructor(private readonly directory: string) {}

  async currentFile(): Promise<{ path: string; mime: string } | null> {
    await mkdir(this.directory, { recursive: true })
    const current = (await readdir(this.directory)).find((name) => {
      if (!name.toLowerCase().startsWith('current.')) return false
      return isAllowedBackgroundExtension(extname(name))
    })
    if (!current) return null
    return {
      path: join(this.directory, current),
      mime: mimeForImageExtension(extname(current))
    }
  }

  async importFile(sourcePath: string): Promise<TerminalBackgroundPickResult> {
    const extension = extname(sourcePath)
    if (!isAllowedBackgroundExtension(extension)) {
      throw new Error('unsupported-image-type')
    }
    const info = await stat(sourcePath)
    if (!info.isFile()) {
      throw new Error('unsupported-image-type')
    }
    if (info.size > TERMINAL_BACKGROUND_MAX_BYTES) {
      throw new Error('image-too-large')
    }

    await mkdir(this.directory, { recursive: true })
    const temporary = join(
      this.directory,
      `.import.${process.pid}.${Date.now()}.tmp`
    )
    const target = join(this.directory, `current${extension.toLowerCase()}`)
    try {
      await copyFile(sourcePath, temporary)
      await this.clearCurrentImages()
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
    await this.clearCurrentImages()
  }

  private async clearCurrentImages(): Promise<void> {
    const entries = await readdir(this.directory).catch(() => [])
    await Promise.all(
      entries
        .filter((name) => name.toLowerCase().startsWith('current.'))
        .map((name) => unlink(join(this.directory, name)).catch(() => {}))
    )
  }
}

export function installTerminalBackgroundProtocol(
  store: TerminalBackgroundStore
): void {
  session.defaultSession.protocol.handle(
    TERMINAL_BACKGROUND_SCHEME,
    async (request) => {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405 })
      }
      const file = await store.currentFile()
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

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CUSTOM_UI_THEME_FILENAME,
  CUSTOM_UI_THEME_ID,
  validateUiTheme,
  type UserThemeFile
} from '../shared/theme-schema'

const MAX_USER_THEME_FILES = 128
const MAX_USER_THEME_BYTES = 256 * 1024

export class UserThemeStore {
  constructor(private readonly directory: string) {}

  async list(): Promise<UserThemeFile[]> {
    await mkdir(this.directory, { recursive: true })
    const entries = (await readdir(this.directory, { withFileTypes: true }))
      .filter(
        (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json')
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_USER_THEME_FILES)

    return Promise.all(
      entries.map(async (entry) => {
        const path = join(this.directory, entry.name)
        const metadata = await stat(path)
        if (metadata.size > MAX_USER_THEME_BYTES) {
          return {
            filename: entry.name,
            error: `File is ${metadata.size} bytes; the limit is 256 KB`
          }
        }
        return { filename: entry.name, source: await readFile(path, 'utf8') }
      })
    )
  }

  async saveCustom(value: unknown): Promise<void> {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      Buffer.byteLength(value, 'utf8') > MAX_USER_THEME_BYTES
    ) {
      throw new Error('Theme source must be non-empty and no larger than 256 KB')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error('Theme source is not valid JSON')
    }
    const validation = validateUiTheme(parsed)
    if (!validation.ok) {
      throw new Error(`Invalid theme: ${validation.errors.join('; ')}`)
    }
    if (validation.theme.id !== CUSTOM_UI_THEME_ID) {
      throw new Error(`Custom theme id must be ${CUSTOM_UI_THEME_ID}`)
    }

    await mkdir(this.directory, { recursive: true })
    const target = join(this.directory, CUSTOM_UI_THEME_FILENAME)
    const temporary = join(
      this.directory,
      `.${CUSTOM_UI_THEME_FILENAME}.${process.pid}.${Date.now()}.tmp`
    )
    try {
      await writeFile(temporary, value, 'utf8')
      await rename(temporary, target)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }
}

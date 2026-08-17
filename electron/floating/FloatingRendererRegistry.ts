import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { watch, type Dirent, type FSWatcher } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  BUILTIN_FLOATING_RENDERER_ID,
  BUILTIN_LIVE2D_FLOATING_RENDERER_ID,
  FLOATING_RENDERER_SCHEMA_VERSION,
  type FloatingRendererInfo,
  type FloatingRendererLoadError,
  type FloatingRendererManifest
} from '../../shared/floating-window'

const MAX_RENDERERS = 64
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_WATCHED_DIRECTORIES = 256
const RENDERER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

export interface FloatingRendererDefinition extends FloatingRendererInfo {
  root: string
  entry: string
  width: number
  minHeight: number
  maxHeight: number
}

export interface FloatingRendererRegistrySnapshot {
  definitions: readonly FloatingRendererDefinition[]
  errors: readonly FloatingRendererLoadError[]
}

interface FloatingRendererRegistryOptions {
  userDirectory: string
  builtinRoot: string
  builtinLive2dRoot: string
  onChanged?: (snapshot: FloatingRendererRegistrySnapshot) => void
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.round(value)))
    : fallback
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function parseManifest(value: unknown): FloatingRendererManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('manifest 根节点必须是对象')
  }
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== FLOATING_RENDERER_SCHEMA_VERSION) {
    throw new Error(`schemaVersion 必须是 ${FLOATING_RENDERER_SCHEMA_VERSION}`)
  }
  if (typeof raw.id !== 'string' || !RENDERER_ID.test(raw.id)) {
    throw new Error('id 必须是 1–64 位小写字母、数字、点、下划线或连字符')
  }
  if (
    typeof raw.name !== 'string' ||
    raw.name.trim().length === 0 ||
    raw.name.trim().length > 128
  ) {
    throw new Error('name 必须是 1–128 位字符串')
  }
  if (
    raw.version !== undefined &&
    (typeof raw.version !== 'string' || raw.version.length > 64)
  ) {
    throw new Error('version 必须是不超过 64 位的字符串')
  }
  if (
    typeof raw.entry !== 'string' ||
    raw.entry.length === 0 ||
    raw.entry.length > 512 ||
    raw.entry.includes('\0') ||
    isAbsolute(raw.entry) ||
    !raw.entry.toLowerCase().endsWith('.html')
  ) {
    throw new Error('entry 必须是实现目录内的相对 HTML 路径')
  }
  return {
    schemaVersion: 1,
    id: raw.id,
    name: raw.name.trim(),
    version: typeof raw.version === 'string' ? raw.version : undefined,
    entry: raw.entry,
    width: boundedNumber(raw.width, 248, 180, 640),
    minHeight: boundedNumber(raw.minHeight, 92, 64, 800),
    maxHeight: boundedNumber(raw.maxHeight, 360, 92, 1200)
  }
}

/**
 * Owns renderer discovery and filesystem observation. Consumers only see
 * validated definitions; malformed manifests and path escapes become errors.
 */
export class FloatingRendererRegistry {
  private definitions: readonly FloatingRendererDefinition[] = []
  private errors: readonly FloatingRendererLoadError[] = []
  private watchers: FSWatcher[] = []
  private refreshTimer: NodeJS.Timeout | null = null
  private refreshOperation: Promise<FloatingRendererRegistrySnapshot> =
    Promise.resolve({ definitions: [], errors: [] })
  private disposed = false

  constructor(private readonly options: FloatingRendererRegistryOptions) {}

  async start(): Promise<FloatingRendererRegistrySnapshot> {
    await mkdir(this.options.userDirectory, { recursive: true })
    return this.refresh()
  }

  refresh(): Promise<FloatingRendererRegistrySnapshot> {
    this.refreshOperation = this.refreshOperation
      .catch(() => ({ definitions: this.definitions, errors: this.errors }))
      .then(() => this.scan())
    return this.refreshOperation
  }

  snapshot(): FloatingRendererRegistrySnapshot {
    return { definitions: this.definitions, errors: this.errors }
  }

  find(rendererId: string): FloatingRendererDefinition | undefined {
    return this.definitions.find((definition) => definition.id === rendererId)
  }

  dispose(): void {
    this.disposed = true
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    this.closeWatchers()
  }

  private async scan(): Promise<FloatingRendererRegistrySnapshot> {
    if (this.disposed) return this.snapshot()
    const builtin: FloatingRendererDefinition = {
      id: BUILTIN_FLOATING_RENDERER_ID,
      name: 'HRack Default',
      version: null,
      source: 'builtin',
      root: this.options.builtinRoot,
      entry: 'index.html',
      width: 248,
      minHeight: 92,
      maxHeight: 360
    }
    const live2d: FloatingRendererDefinition = {
      id: BUILTIN_LIVE2D_FLOATING_RENDERER_ID,
      name: 'Live2D · Mao',
      version: '5-r.4',
      source: 'builtin',
      root: this.options.builtinLive2dRoot,
      entry: 'index.html',
      width: 420,
      minHeight: 620,
      maxHeight: 620
    }
    const definitions: FloatingRendererDefinition[] = [builtin, live2d]
    const errors: FloatingRendererLoadError[] = []
    let entries: Dirent[] = []
    let userRoot = this.options.userDirectory
    try {
      userRoot = await realpath(this.options.userDirectory)
      entries = (await readdir(this.options.userDirectory, {
        withFileTypes: true
      }))
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAX_RENDERERS)
    } catch (error) {
      errors.push({
        rendererId: null,
        filename: this.options.userDirectory,
        message: error instanceof Error ? error.message : String(error)
      })
    }

    for (const directory of entries) {
      const manifestPath = resolve(
        this.options.userDirectory,
        directory.name,
        'manifest.json'
      )
      try {
        const metadata = await stat(manifestPath)
        if (!metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES) {
          throw new Error('manifest.json 不存在或超过 64 KB')
        }
        const manifest = parseManifest(
          JSON.parse(await readFile(manifestPath, 'utf8'))
        )
        const id = `user/${manifest.id}`
        if (definitions.some((definition) => definition.id === id)) {
          throw new Error(`渲染器 id 冲突：${manifest.id}`)
        }
        const root = await realpath(resolve(this.options.userDirectory, directory.name))
        if (!inside(userRoot, root)) {
          throw new Error('渲染器目录不能通过符号链接离开用户目录')
        }
        const entry = await realpath(resolve(root, manifest.entry))
        if (!inside(root, entry)) {
          throw new Error('entry 不能离开渲染器目录')
        }
        const entryMetadata = await stat(entry)
        if (!entryMetadata.isFile()) throw new Error('entry 不是文件')
        const minHeight = manifest.minHeight ?? 92
        const maxHeight = Math.max(minHeight, manifest.maxHeight ?? 360)
        definitions.push({
          id,
          name: manifest.name,
          version: manifest.version ?? null,
          source: 'user',
          root,
          entry: relative(root, entry).replaceAll('\\', '/'),
          width: manifest.width ?? 248,
          minHeight,
          maxHeight
        })
      } catch (error) {
        errors.push({
          rendererId: directory.name ? `user/${directory.name}` : null,
          filename: manifestPath,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }

    this.definitions = definitions
    this.errors = errors
    await this.resetWatchers()
    const snapshot = this.snapshot()
    this.options.onChanged?.(snapshot)
    return snapshot
  }

  private async resetWatchers(): Promise<void> {
    this.closeWatchers()
    if (this.disposed) return
    const directories = new Set<string>([this.options.userDirectory])
    for (const definition of this.definitions) {
      if (definition.source !== 'user') continue
      await this.collectDirectories(definition.root, directories)
    }
    for (const directory of directories) {
      try {
        this.watchers.push(watch(directory, () => this.scheduleRefresh()))
      } catch {
        // A directory may disappear between scan and watch; the parent watcher
        // will schedule the next scan.
      }
    }
  }

  private async collectDirectories(
    root: string,
    target: Set<string>
  ): Promise<void> {
    if (target.size >= MAX_WATCHED_DIRECTORIES) return
    target.add(root)
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        target.size >= MAX_WATCHED_DIRECTORIES
      ) {
        continue
      }
      await this.collectDirectories(resolve(root, entry.name), target)
    }
  }

  private scheduleRefresh(): void {
    if (this.disposed || this.refreshTimer) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refresh().catch((error) => {
        console.warn('[floating-renderers] refresh failed:', error)
      })
    }, 250)
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
  }
}

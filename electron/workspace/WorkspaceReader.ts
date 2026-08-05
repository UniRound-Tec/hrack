import { open, opendir, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CliRuntime } from '../../shared/ipc-contract'
import type {
  WorkspaceDescription,
  WorkspaceEntry,
  WorkspacePathRequest,
  WorkspaceTextFile
} from '../../shared/workspace-reader'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 5_000
const MAX_TERMINAL_ID_LENGTH = 128
const MAX_RELATIVE_PATH_LENGTH = 8_192

export type WorkspaceReaderErrorCode =
  | 'invalid-request'
  | 'not-mounted'
  | 'not-found'
  | 'denied'
  | 'outside-root'
  | 'not-a-directory'
  | 'not-a-file'
  | 'file-too-large'
  | 'binary-file'
  | 'unsupported-encoding'
  | 'runtime-unavailable'
  | 'too-many-entries'

export class WorkspaceReaderError extends Error {
  constructor(readonly code: WorkspaceReaderErrorCode) {
    super(`workspace-reader:${code}`)
    this.name = 'WorkspaceReaderError'
  }
}

interface WorkspaceMount {
  root: string
  name: string
  runtime: WorkspaceDescription['runtime']
}

function validTerminalId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TERMINAL_ID_LENGTH &&
    !value.includes('\0')
  )
}

function relativeSegments(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > MAX_RELATIVE_PATH_LENGTH) {
    throw new WorkspaceReaderError('invalid-request')
  }
  if (value.includes('\0') || isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new WorkspaceReaderError('outside-root')
  }
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '')
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.some((segment) => segment === '..')) {
    throw new WorkspaceReaderError('outside-root')
  }
  return segments
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return (
    fromRoot === '' ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot))
  )
}

async function wslWorkspacePath(workspace: string, distro: string): Promise<string> {
  if (process.platform !== 'win32' || !workspace.startsWith('/')) return workspace
  if (!distro || distro.length > 128 || /[\u0000\r\n]/.test(distro)) {
    throw new WorkspaceReaderError('invalid-request')
  }
  const execute = promisify(execFile)
  const { stdout } = await execute(
    'wsl.exe',
    ['--distribution', distro, '--exec', 'wslpath', '-w', workspace],
    { timeout: 5_000, windowsHide: true, maxBuffer: 32 * 1024 }
  )
  const translated = stdout.replaceAll('\0', '').trim()
  if (!translated) throw new WorkspaceReaderError('runtime-unavailable')
  return translated
}

async function checkedRoot(workspace: string, runtime: CliRuntime): Promise<WorkspaceMount> {
  const requested =
    runtime.kind === 'wsl'
      ? await wslWorkspacePath(workspace, runtime.distro)
      : workspace
  const root = await realpath(requested)
  const metadata = await stat(root)
  if (!metadata.isDirectory()) throw new WorkspaceReaderError('not-a-directory')
  return {
    root,
    name: basename(root) || root,
    runtime:
      runtime.kind === 'wsl'
        ? 'wsl'
        : runtime.platform
  }
}

function normalizedError(error: unknown): WorkspaceReaderError {
  if (error instanceof WorkspaceReaderError) return error
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
  if (code === 'ENOENT') return new WorkspaceReaderError('not-found')
  if (code === 'EACCES' || code === 'EPERM') {
    return new WorkspaceReaderError('denied')
  }
  return new WorkspaceReaderError('runtime-unavailable')
}

function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3))
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le')
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2))
    for (let index = 0; index + 1 < body.length; index += 2) {
      const first = body[index]
      body[index] = body[index + 1]
      body[index + 1] = first
    }
    return body.toString('utf16le')
  }
  if (bytes.includes(0)) throw new WorkspaceReaderError('binary-file')
  const controlCount = bytes.reduce(
    (count, value) =>
      value < 0x20 && value !== 0x09 && value !== 0x0a && value !== 0x0d
        ? count + 1
        : count,
    0
  )
  if (bytes.length > 0 && controlCount / bytes.length > 0.01) {
    throw new WorkspaceReaderError('binary-file')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new WorkspaceReaderError('unsupported-encoding')
  }
}

function eolOf(text: string): WorkspaceTextFile['eol'] {
  const hasCrlf = text.includes('\r\n')
  const hasBareLf = /(^|[^\r])\n/.test(text)
  if (hasCrlf && hasBareLf) return 'mixed'
  if (hasCrlf) return 'crlf'
  if (hasBareLf) return 'lf'
  return 'none'
}

export class WorkspaceReader {
  private readonly mounts = new Map<string, WorkspaceMount>()

  async mount(terminalId: string, runtime: CliRuntime, workspace: string): Promise<void> {
    if (!validTerminalId(terminalId) || typeof workspace !== 'string' || !workspace.trim()) {
      throw new WorkspaceReaderError('invalid-request')
    }
    try {
      this.mounts.set(terminalId, await checkedRoot(workspace.trim(), runtime))
    } catch (error) {
      throw normalizedError(error)
    }
  }

  unmount(terminalId: string): void {
    this.mounts.delete(terminalId)
  }

  clear(): void {
    this.mounts.clear()
  }

  describe(terminalId: unknown): WorkspaceDescription | null {
    if (!validTerminalId(terminalId)) throw new WorkspaceReaderError('invalid-request')
    const mount = this.mounts.get(terminalId)
    return mount
      ? {
          terminalId,
          label: mount.name,
          name: mount.name,
          runtime: mount.runtime
        }
      : null
  }

  private mountFor(request: unknown): { mount: WorkspaceMount; segments: string[]; path: string } {
    if (!request || typeof request !== 'object') {
      throw new WorkspaceReaderError('invalid-request')
    }
    const raw = request as Partial<WorkspacePathRequest>
    if (!validTerminalId(raw.terminalId)) {
      throw new WorkspaceReaderError('invalid-request')
    }
    const mount = this.mounts.get(raw.terminalId)
    if (!mount) throw new WorkspaceReaderError('not-mounted')
    const segments = relativeSegments(raw.path)
    return { mount, segments, path: segments.join('/') }
  }

  private async resolveInside(mount: WorkspaceMount, segments: string[]): Promise<string> {
    const candidate = resolve(mount.root, ...segments)
    if (!contained(mount.root, candidate)) {
      throw new WorkspaceReaderError('outside-root')
    }
    const canonical = await realpath(candidate)
    if (!contained(mount.root, canonical)) {
      throw new WorkspaceReaderError('outside-root')
    }
    return canonical
  }

  async list(request: unknown): Promise<WorkspaceEntry[]> {
    try {
      const { mount, segments, path } = this.mountFor(request)
      const directory = await this.resolveInside(mount, segments)
      const metadata = await stat(directory)
      if (!metadata.isDirectory()) throw new WorkspaceReaderError('not-a-directory')
      const entries = []
      const handle = await opendir(directory)
      for await (const entry of handle) {
        entries.push(entry)
        if (entries.length > MAX_DIRECTORY_ENTRIES) {
          throw new WorkspaceReaderError('too-many-entries')
        }
      }
      return entries
        .filter((entry) => entry.name !== '.' && entry.name !== '..')
        .map((entry): WorkspaceEntry => ({
          name: entry.name,
          path: path ? `${path}/${entry.name}` : entry.name,
          kind: entry.isDirectory()
            ? 'directory'
            : entry.isSymbolicLink()
              ? 'symlink'
              : 'file'
        }))
        .sort((left, right) => {
          if (left.kind === 'directory' && right.kind !== 'directory') return -1
          if (right.kind === 'directory' && left.kind !== 'directory') return 1
          return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
        })
    } catch (error) {
      throw normalizedError(error)
    }
  }

  async read(request: unknown): Promise<WorkspaceTextFile> {
    try {
      const { mount, segments, path } = this.mountFor(request)
      const filePath = await this.resolveInside(mount, segments)
      const handle = await open(filePath, 'r')
      try {
        const metadata = await handle.stat()
        if (!metadata.isFile()) throw new WorkspaceReaderError('not-a-file')
        if (metadata.size > MAX_FILE_BYTES) {
          throw new WorkspaceReaderError('file-too-large')
        }
        const buffer = Buffer.alloc(metadata.size)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        const afterRead = await handle.stat()
        if (afterRead.size > MAX_FILE_BYTES) {
          throw new WorkspaceReaderError('file-too-large')
        }
        if (afterRead.size !== metadata.size || bytesRead !== metadata.size) {
          throw new WorkspaceReaderError('runtime-unavailable')
        }
        const bytes = buffer.subarray(0, bytesRead)
        const text = decodeText(bytes)
        return {
          path,
          text,
          byteLength: bytesRead,
          size: bytesRead,
          languageHint: extname(path).slice(1).toLowerCase() || undefined,
          eol: eolOf(text),
          truncated: false
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      throw normalizedError(error)
    }
  }
}

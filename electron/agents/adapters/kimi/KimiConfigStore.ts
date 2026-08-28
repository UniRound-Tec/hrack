import { randomBytes } from 'node:crypto'
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  mergeKimiManagedHooks,
  type KimiHookPlatform
} from './KimiHookConfig'

const DEFAULT_LOCK_TIMEOUT_MS = 2_000
const DEFAULT_LOCK_POLL_INTERVAL_MS = 25
const DEFAULT_STALE_LOCK_MS = 30_000
const DEFAULT_CONCURRENT_EDIT_RETRIES = 2
const inProcessConfigTails = new Map<string, Promise<void>>()

export type EnsureKimiManagedHooksResult =
  | { ok: true; changed: boolean }
  | {
      ok: false
      reason:
        | 'kimi-config-lock-timeout'
        | 'kimi-config-marker-conflict'
        | 'kimi-config-read-failed'
        | 'kimi-wsl-env-timeout'
        | 'kimi-wsl-env-unavailable'
        | 'kimi-home-path-invalid'
        | 'kimi-config-validation-failed'
        | 'kimi-config-concurrent-change'
        | 'kimi-config-write-failed'
    }

export interface EnsureKimiManagedHooksOptions {
  configPath: string
  platform: KimiHookPlatform
  validate(candidatePath: string): Promise<boolean>
  lockTimeoutMs?: number
  lockPollIntervalMs?: number
  staleLockMs?: number
  concurrentEditRetries?: number
}

interface ConfigLock {
  path: string
  token: string
}

type ConfigLockResult =
  | { ok: true; lock: ConfigLock }
  | { ok: false; reason: 'timeout' | 'write' }

function boundedNonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value >= 0
    ? Math.floor(value)
    : fallback
}

function canonicalConfigKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

async function withConfigMutex<T>(
  path: string,
  action: () => Promise<T>
): Promise<T> {
  const key = canonicalConfigKey(path)
  const previous = (inProcessConfigTails.get(key) ?? Promise.resolve()).catch(
    () => {}
  )
  let release!: () => void
  const gate = new Promise<void>((resolveGate) => (release = resolveGate))
  const tail = previous.then(() => gate)
  inProcessConfigTails.set(key, tail)
  await previous
  try {
    return await action()
  } finally {
    release()
    if (inProcessConfigTails.get(key) === tail) inProcessConfigTails.delete(key)
  }
}

async function readConfig(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

async function lockTimestamp(lockPath: string): Promise<number | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as {
      createdAt?: unknown
    }
    if (typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)) {
      return raw.createdAt
    }
  } catch {
    // A creator can briefly own the directory before owner.json is visible.
  }
  try {
    return (await stat(lockPath)).mtimeMs
  } catch {
    return undefined
  }
}

async function recoverStaleLock(
  lockPath: string,
  staleLockMs: number
): Promise<boolean> {
  const createdAt = await lockTimestamp(lockPath)
  if (createdAt === undefined || Date.now() - createdAt <= staleLockMs) {
    return false
  }
  const quarantine = `${lockPath}.stale-${randomBytes(8).toString('hex')}`
  try {
    await rename(lockPath, quarantine)
    await rm(quarantine, { recursive: true, force: true })
    return true
  } catch {
    await rm(quarantine, { recursive: true, force: true }).catch(() => {})
    return false
  }
}

async function acquireConfigLock(
  lockPath: string,
  timeoutMs: number,
  pollIntervalMs: number,
  staleLockMs: number
): Promise<ConfigLockResult> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const token = randomBytes(16).toString('hex')
    try {
      await mkdir(lockPath, { mode: 0o700 })
      try {
        const owner = await open(join(lockPath, 'owner.json'), 'wx', 0o600)
        try {
          await owner.writeFile(
            JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }),
            'utf8'
          )
          await owner.sync()
        } finally {
          await owner.close()
        }
        return { ok: true, lock: { path: lockPath, token } }
      } catch {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {})
        return { ok: false, reason: 'write' }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { ok: false, reason: 'write' }
      }
    }

    if (await recoverStaleLock(lockPath, staleLockMs)) continue
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { ok: false, reason: 'timeout' }
    await new Promise<void>((resolveDelay) =>
      setTimeout(resolveDelay, Math.min(Math.max(1, pollIntervalMs), remaining))
    )
  }
}

async function releaseConfigLock(lock: ConfigLock): Promise<void> {
  try {
    const owner = JSON.parse(
      await readFile(join(lock.path, 'owner.json'), 'utf8')
    ) as { token?: unknown }
    if (owner.token !== lock.token) return
    await rm(lock.path, { recursive: true, force: true })
  } catch {
    // A stale-lock recovery may already have replaced our ownership.
  }
}

async function writeCandidate(path: string, content: string): Promise<void> {
  const candidate = await open(path, 'wx', 0o600)
  try {
    await candidate.writeFile(content, 'utf8')
    await candidate.sync()
  } finally {
    await candidate.close()
  }
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

async function ensureWhileLocked(
  options: EnsureKimiManagedHooksOptions
): Promise<EnsureKimiManagedHooksResult> {
  const configDir = dirname(options.configPath)
  // Stable across the rebrand so an older process cannot edit concurrently.
  const lockPath = `${options.configPath}.vibing.lock`
  try {
    await mkdir(configDir, { recursive: true, mode: 0o700 })
  } catch {
    return { ok: false, reason: 'kimi-config-read-failed' }
  }

  const acquired = await acquireConfigLock(
    lockPath,
    boundedNonNegative(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS),
    boundedNonNegative(
      options.lockPollIntervalMs,
      DEFAULT_LOCK_POLL_INTERVAL_MS
    ),
    boundedNonNegative(options.staleLockMs, DEFAULT_STALE_LOCK_MS)
  )
  if (!acquired.ok) {
    return {
      ok: false,
      reason:
        acquired.reason === 'timeout'
          ? 'kimi-config-lock-timeout'
          : 'kimi-config-write-failed'
    }
  }

  const retries = boundedNonNegative(
    options.concurrentEditRetries,
    DEFAULT_CONCURRENT_EDIT_RETRIES
  )
  try {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let source: string
      try {
        source = await readConfig(options.configPath)
      } catch {
        return { ok: false, reason: 'kimi-config-read-failed' }
      }

      const merged = mergeKimiManagedHooks(source, options.platform)
      if (!merged.ok) return merged
      if (!merged.changed) return { ok: true, changed: false }

      const candidatePath = join(
        configDir,
        `.${basename(options.configPath)}.hrack-${randomBytes(8).toString('hex')}.tmp`
      )
      try {
        try {
          await writeCandidate(candidatePath, merged.content)
        } catch {
          return { ok: false, reason: 'kimi-config-write-failed' }
        }

        let valid = false
        try {
          valid = await options.validate(candidatePath)
        } catch {
          return { ok: false, reason: 'kimi-config-validation-failed' }
        }
        if (!valid) {
          return { ok: false, reason: 'kimi-config-validation-failed' }
        }

        let current: string
        try {
          current = await readConfig(options.configPath)
        } catch {
          return { ok: false, reason: 'kimi-config-read-failed' }
        }
        if (current !== source) {
          if (attempt < retries) continue
          return { ok: false, reason: 'kimi-config-concurrent-change' }
        }

        try {
          await rename(candidatePath, options.configPath)
          return { ok: true, changed: true }
        } catch {
          return { ok: false, reason: 'kimi-config-write-failed' }
        }
      } finally {
        await rm(candidatePath, { force: true }).catch(() => {})
      }
    }
    return { ok: false, reason: 'kimi-config-concurrent-change' }
  } finally {
    await releaseConfigLock(acquired.lock)
  }
}

export function ensureKimiManagedHooks(
  options: EnsureKimiManagedHooksOptions
): Promise<EnsureKimiManagedHooksResult> {
  return withConfigMutex(options.configPath, () => ensureWhileLocked(options))
}

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'

export function sanitizePipeUser(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64)
  return cleaned || 'user'
}

export function bridgeSocketPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\hrack-bridge-${sanitizePipeUser(userInfo().username)}`
  }
  const runtime = process.env.XDG_RUNTIME_DIR?.trim()
  if (runtime) return join(runtime, 'hrack', 'bridge.sock')
  return join(homedir(), '.hrack', 'bridge.sock')
}

export function bridgeTokenPath(userDataDir: string): string {
  return join(userDataDir, 'bridge.token')
}

export function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

export async function readOrCreateBridgeToken(
  userDataDir: string
): Promise<string> {
  const path = bridgeTokenPath(userDataDir)
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (/^[a-f0-9]{64}$/.test(existing)) return existing
  } catch {
    // create below
  }
  const token = randomBytes(32).toString('hex')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, token, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') await chmod(path, 0o600)
  return token
}

export async function readBridgeTokenFile(
  userDataDir: string
): Promise<string | null> {
  try {
    const token = (await readFile(bridgeTokenPath(userDataDir), 'utf8')).trim()
    return /^[a-f0-9]{64}$/.test(token) ? token : null
  } catch {
    return null
  }
}

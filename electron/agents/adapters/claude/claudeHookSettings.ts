import { chmod, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_HOOK_EVENTS, type ClaudeHookEventName } from './types'

export type ClaudeHookHandler =
  | { type: 'http'; url: string; timeout: number }
  | { type: 'command'; command: string; args: string[]; timeout: number }

interface ClaudeSettings {
  $schema: string
  hooks: Record<
    ClaudeHookEventName,
    Array<{ hooks: ClaudeHookHandler[] }>
  >
}

export type HttpHookPolicyProbe = 'allowed' | 'denied' | 'unknown'

export function buildClaudeHookSettings(handler: ClaudeHookHandler): ClaudeSettings {
  return {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    hooks: Object.fromEntries(
      CLAUDE_HOOK_EVENTS.map((event) => [event, [{ hooks: [handler] }]])
    ) as ClaudeSettings['hooks']
  }
}

export async function writeClaudeHookSettings(
  path: string,
  handler: ClaudeHookHandler
): Promise<void> {
  await writeFile(path, JSON.stringify(buildClaudeHookSettings(handler), null, 2), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  })
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function readSettings(path: string): Promise<Record<string, unknown> | null> {
  try {
    return recordOf(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

function managedSettingsPaths(): string[] {
  if (process.platform === 'win32') {
    return [join(process.env.ProgramData ?? 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json')]
  }
  if (process.platform === 'darwin') {
    return ['/Library/Application Support/ClaudeCode/managed-settings.json']
  }
  return ['/etc/claude-code/managed-settings.json']
}

function urlAllowed(pattern: string, endpoint: URL): boolean {
  const clean = pattern.trim()
  if (!clean) return false
  if (clean === '*') return true
  if (clean === endpoint.href || clean === endpoint.origin || clean === `${endpoint.origin}/*`) {
    return true
  }
  const escaped = clean.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  try {
    return new RegExp(`^${escaped}$`, 'i').test(endpoint.href)
  } catch {
    return false
  }
}

/**
 * 只做 best-effort 静态预检。明确拒绝才返回 denied；不可读的企业策略
 * 保持 unknown，最终连通性由真实 Hook delivery 确认。
 */
export async function probeHttpHookPolicy(
  endpoint: string,
  workspace: string
): Promise<{
  policy: HttpHookPolicyProbe
  reason?: 'managed-hooks-only' | 'http-hooks-not-allowed'
}> {
  const paths = [
    join(homedir(), '.claude', 'settings.json'),
    ...(workspace
      ? [
          join(workspace, '.claude', 'settings.json'),
          join(workspace, '.claude', 'settings.local.json')
        ]
      : []),
    ...managedSettingsPaths()
  ]
  const documents = (await Promise.all(paths.map(readSettings))).filter(
    (value): value is Record<string, unknown> => Boolean(value)
  )
  if (documents.some((document) => document.allowManagedHooksOnly === true)) {
    return { policy: 'denied', reason: 'managed-hooks-only' }
  }
  const endpointUrl = new URL(endpoint)
  let sawAllowlist = false
  for (const document of documents) {
    const allowlist = document.allowedHttpHookUrls
    if (!Array.isArray(allowlist)) continue
    sawAllowlist = true
    const patterns = allowlist.filter((value): value is string => typeof value === 'string')
    if (patterns.length === 0 || !patterns.some((pattern) => urlAllowed(pattern, endpointUrl))) {
      return { policy: 'denied', reason: 'http-hooks-not-allowed' }
    }
  }
  return { policy: sawAllowlist ? 'allowed' : 'unknown' }
}

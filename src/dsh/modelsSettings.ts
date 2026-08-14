import type {
  DshCredentialView,
  DshProvider,
  DshSettingsDescribe,
  DshSettingsNamespace
} from './rpc'

export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

export function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

export function hasPath(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return value !== undefined
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object' || !(key in current)) {
      return false
    }
    current = (current as Record<string, unknown>)[key]
  }
  return true
}

export interface JoinedProvider {
  entry: DshProvider
  configured: boolean
  removable: boolean
  apiKeyEnv?: string
  credential?: DshCredentialView
}

function apiKeyEnvOf(
  namespace: DshSettingsNamespace | undefined,
  path: readonly string[]
): string | undefined {
  if (!namespace) return undefined
  const profile = getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** Official Models page join: directory × describe × credentials. */
export function joinProviderRows(
  providers: readonly DshProvider[],
  describe: DshSettingsDescribe | null,
  credentials: Record<string, DshCredentialView>
): JoinedProvider[] {
  const namespaces = new Map(
    (describe?.namespaces ?? []).map((item) => [item.ns, item])
  )
  return providers.map((entry) => {
    const namespace = namespaces.get(entry.settingsNs)
    const configured =
      namespace !== undefined &&
      (entry.settingsPath.length === 0 ||
        getPath(namespace.value, entry.settingsPath) !== undefined)
    const removable =
      namespace !== undefined &&
      entry.settingsPath.length > 0 &&
      hasPath(namespace.user, entry.settingsPath) &&
      !hasPath(namespace.base, entry.settingsPath)
    const apiKeyEnv = apiKeyEnvOf(namespace, entry.settingsPath)
    return {
      entry,
      configured,
      removable,
      apiKeyEnv,
      credential: apiKeyEnv ? credentials[apiKeyEnv] : undefined
    }
  })
}

export function collectProviderKeyRefs(rows: readonly JoinedProvider[]): string[] {
  return [
    ...new Set(
      rows.flatMap((row) => (row.apiKeyEnv ? [row.apiKeyEnv] : []))
    )
  ]
}

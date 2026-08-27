import type { JoinUrl } from './remote-protocol'

interface ResolverPayload {
  v: 1
  nodeId: string
  region: string
  label: string
  relayOrigin: string
  dshOrigin: string
}

export interface ResolvedJoinUrl extends JoinUrl {
  nodeId?: string
  region?: string
  nodeLabel?: string
  dshOrigin?: string
}

export class RemoteNodeResolutionError extends Error {
  override readonly name = 'RemoteNodeResolutionError'
}

function canonicalTransportOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      return null
    }
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    if (url.protocol !== 'https:' && !loopback) return null
    return url.origin
  } catch {
    return null
  }
}

function parseResolverPayload(value: unknown): ResolverPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const input = value as Record<string, unknown>
  const relayOrigin = canonicalTransportOrigin(input.relayOrigin)
  const dshOrigin = canonicalTransportOrigin(input.dshOrigin)
  if (
    input.v !== 1 ||
    typeof input.nodeId !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(input.nodeId) ||
    typeof input.region !== 'string' ||
    typeof input.label !== 'string' ||
    !relayOrigin ||
    !dshOrigin
  ) {
    return null
  }
  return {
    v: 1,
    nodeId: input.nodeId,
    region: input.region,
    label: input.label,
    relayOrigin,
    dshOrigin
  }
}

/** Resolve a stable control-plane URL to its current direct Relay transport. */
export async function resolveRemoteJoin(
  join: JoinUrl,
  fetcher: typeof fetch = fetch
): Promise<ResolvedJoinUrl> {
  const controlUrl = new URL(join.origin)
  if (controlUrl.protocol === 'ws:' || controlUrl.protocol === 'wss:') {
    return join
  }

  let response: Response
  try {
    response = await fetcher(`${join.origin}/api/remote/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: join.roomId }),
      signal: AbortSignal.timeout(5_000)
    })
  } catch {
    throw new RemoteNodeResolutionError('resolver-unavailable')
  }

  if (response.status === 404 && response.headers.get('x-hrack-resolver') !== '1') {
    return join
  }
  if (!response.ok) {
    throw new RemoteNodeResolutionError(`resolver-http-${response.status}`)
  }
  const payload = parseResolverPayload(await response.json().catch(() => null))
  if (!payload) throw new RemoteNodeResolutionError('resolver-invalid-response')

  const relay = new URL(payload.relayOrigin)
  const wsProtocol = relay.protocol === 'https:' ? 'wss:' : 'ws:'
  return {
    ...join,
    wsUrl: `${wsProtocol}//${relay.host}${join.base}/v1/ws`,
    nodeId: payload.nodeId,
    region: payload.region,
    nodeLabel: payload.label,
    dshOrigin: payload.dshOrigin
  }
}

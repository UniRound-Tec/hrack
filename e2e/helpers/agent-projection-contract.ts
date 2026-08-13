import {
  createInitialAgentProjection,
  reduceAgentSession
} from '../../electron/agents/AgentEventReducer'
import { normalizeAdapterEvent } from '../../electron/agents/AgentEventNormalizer'
import type { AdapterEvent } from '../../electron/agents/adapters/types'
import type {
  AgentEvent,
  AgentEventSource,
  AgentSessionProjection,
  ObserverCapabilities
} from '../../shared/agent-events'

interface ProjectionContractOptions {
  adapterId: string
  source: AgentEventSource
  capabilities: ObserverCapabilities
  sessionId?: string
}

/** Exercise product facts through the same Adapter → Runtime → reducer seam. */
export function projectAdapterEvents(
  events: readonly AdapterEvent[],
  options: ProjectionContractOptions
): AgentSessionProjection {
  const sessionId = options.sessionId ?? 'adapter-contract-session'
  let projection = createInitialAgentProjection({
    sessionId,
    terminalId: 'adapter-contract-terminal',
    installationId: 'adapter-contract-installation',
    adapterId: options.adapterId,
    capabilities: options.capabilities,
    lastActivityAt: 1_000
  })

  for (const [index, rawEvent] of events.entries()) {
    const normalized = normalizeAdapterEvent(rawEvent)
    if (!normalized) {
      throw new Error(`Adapter contract rejected event ${index}: ${rawEvent.kind}`)
    }
    const event = {
      ...normalized,
      id: `adapter-contract-event-${index + 1}`,
      sessionId,
      adapterId: options.adapterId,
      installationId: 'adapter-contract-installation',
      seq: index + 1,
      occurredAt: 1_001 + index,
      source: options.source
    } as AgentEvent
    projection = reduceAgentSession(projection, event)
  }

  return projection
}

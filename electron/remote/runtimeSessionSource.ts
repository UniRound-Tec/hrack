import type { AgentSessionRuntime } from '../agents/AgentSessionRuntime'
import type { RemoteSessionSource } from './RemoteDesktopClient'
import { toRemoteSession } from './toRemoteSession'

export function runtimeSessionSource(
  runtime: AgentSessionRuntime
): RemoteSessionSource {
  return {
    list: () => runtime.listRecords().map(toRemoteSession),
    subscribe: (listener) =>
      runtime.subscribe((record, phase) => {
        if (phase === 'finalized') {
          listener({ kind: 'removed', sessionId: record.sessionId })
          return
        }
        listener({ kind: 'upsert', session: toRemoteSession(record) })
      })
  }
}

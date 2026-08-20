import type { RemoteSession } from '../../shared/remote-protocol'
import type { AgentSessionRecord } from '../agents/AgentSessionRuntime'

/** 把本机会话记录裁成远程安全子集。不复制 correlation 或可执行路径。 */
export function toRemoteSession(record: AgentSessionRecord): RemoteSession {
  const session: RemoteSession = {
    sessionId: record.sessionId,
    name: record.name,
    adapterId: record.adapterId,
    status: record.projection.status,
    statusConfidence: record.projection.statusConfidence,
    pendingAttentionCount: record.projection.pendingAttentionCount,
    activeToolCount: record.projection.activeToolCount,
    lastActivityAt: record.projection.lastActivityAt,
    workspace: record.workspace
  }
  if (typeof record.projection.detail === 'string') {
    session.detail = record.projection.detail
  }
  return session
}

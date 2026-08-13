import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ObserverCapabilities } from '../../../shared/agent-events'
import type {
  AdapterEvent,
  AgentObserverAdapter,
  ObserverHandle,
  ObserverPreparationContext,
  PreparedObserver,
  RunningAgentContext
} from './types'

/**
 * S1 验证夹具（PLAN-S1 §1.1, §3.3, §11 P4）。
 *
 * 仅在 `VIBING_FIXTURE_OBSERVER=1` 时启用；生产/开发默认走 lifecycle。
 * attach 后按固定节奏重放完整事件序列，覆盖
 * `working → needs-you → working → done → exited` 的六态走查，
 * 并证明临时目录（`<userData>/observer-runs/<sessionId>/`）的隔离与清理。
 */

const FIXTURE_EMIT_INTERVAL_MS = 450
const MAX_SCRIPT_EVENTS = 64

function buildFixtureScript(): AdapterEvent[] {
  return [
    { kind: 'turn.started', payload: { turnId: 'fixture-turn-1' } },
    {
      kind: 'thinking.started',
      payload: { turnId: 'fixture-turn-1' }
    },
    {
      kind: 'thinking.completed',
      payload: { turnId: 'fixture-turn-1' }
    },
    {
      kind: 'tool.started',
      payload: {
        callId: 'fixture-tool-1',
        turnId: 'fixture-turn-1',
        name: 'fixture-read',
        category: 'read'
      }
    },
    {
      kind: 'approval.requested',
      payload: {
        requestId: 'fixture-req-1',
        turnId: 'fixture-turn-1',
        callId: 'fixture-tool-1',
        category: 'file-change',
        summary: 'Fixture approval request'
      }
    },
    {
      kind: 'approval.resolved',
      payload: { requestId: 'fixture-req-1', decision: 'approved' }
    },
    {
      kind: 'tool.completed',
      payload: {
        callId: 'fixture-tool-1',
        turnId: 'fixture-turn-1',
        durationMs: 42
      }
    },
    {
      kind: 'usage.updated',
      payload: {
        inputTokens: 120,
        outputTokens: 80,
        cachedInputTokens: 10,
        contextTokens: 210,
        contextWindow: 200_000,
        scope: 'turn'
      }
    },
    {
      kind: 'turn.completed',
      payload: { turnId: 'fixture-turn-1', outcome: 'completed' }
    },
    { kind: 'session.exited', payload: { exitCode: 0 } }
  ]
}

export class FixtureObserverAdapter implements AgentObserverAdapter {
  readonly id = 'fixture'
  readonly source = 'fixture' as const

  readonly capabilities: ObserverCapabilities = {
    thinking: 'phase',
    tools: 'progress',
    approvals: 'structured',
    inputRequests: 'structured',
    usage: 'tokens-and-context',
    messages: 'summary'
  }

  supports(): boolean {
    return process.env['VIBING_FIXTURE_OBSERVER'] === '1'
  }

  async prepare(
    context: ObserverPreparationContext
  ): Promise<PreparedObserver> {
    // 证明每个会话使用独立、可清理的临时目录。
    await mkdir(context.runDir, { recursive: true })
    await writeFile(
      join(context.runDir, 'fixture.json'),
      JSON.stringify(
        {
          adapterId: this.id,
          sessionRunDir: context.runDir
        },
        null,
        2
      ),
      'utf8'
    )
    return {
      launch: {},
      capabilities: this.capabilities,
      attach: async (
        running: RunningAgentContext,
        emit: (event: AdapterEvent) => void
      ): Promise<ObserverHandle> => {
        // 多会话 UI 门禁需要 Session 稳定存活；仍走真实 Runtime/PTY，
        // 仅暂停 fixture 的自动退出脚本。
        if (process.env['VIBING_FIXTURE_OBSERVER_HOLD'] === '1') {
          return {
            capabilities: this.capabilities,
            dispose: async (): Promise<void> => {}
          }
        }
        const script = buildFixtureScript().slice(0, MAX_SCRIPT_EVENTS)
        let index = 0
        const timer = setInterval(() => {
          if (index >= script.length) {
            clearInterval(timer)
            return
          }
          const event = script[index++]
          emit({ ...event, nativeId: `fixture:${running.sessionId}:${index}` })
        }, FIXTURE_EMIT_INTERVAL_MS)
        return {
          capabilities: this.capabilities,
          dispose: async (): Promise<void> => {
            clearInterval(timer)
          }
        }
      },
      dispose: async (): Promise<void> => {
        /* 目录清理由 Runtime 统一负责 */
      }
    }
  }
}

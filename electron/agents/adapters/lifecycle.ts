import {
  NO_OBSERVER_CAPABILITIES
} from '../../../shared/agent-events'
import type {
  AgentObserverAdapter,
  ObserverHandle,
  PreparedObserver
} from './types'

/**
 * 无语义能力的默认 Adapter（PLAN-S1 §3.4）：任何安装的兜底。
 * 只保证会话生命周期可见（由 Runtime 经 PTY exit seam 归约），
 * 不产生任何 semantic event。
 */
export class LifecycleObserverAdapter implements AgentObserverAdapter {
  readonly id = 'lifecycle'
  readonly source = 'lifecycle' as const
  readonly capabilities = NO_OBSERVER_CAPABILITIES

  supports(): boolean {
    return true
  }

  async prepare(): Promise<PreparedObserver> {
    return {
      launch: {},
      capabilities: NO_OBSERVER_CAPABILITIES,
      attach: async (): Promise<ObserverHandle> => ({
        capabilities: NO_OBSERVER_CAPABILITIES,
        dispose: async (): Promise<void> => {
          /* lifecycle adapter 无可释放资源 */
        }
      }),
      dispose: async (): Promise<void> => {
        /* lifecycle adapter 无可释放资源 */
      }
    }
  }
}

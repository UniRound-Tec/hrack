import type { AgentObserverAdapter } from './adapters/types'
import { LifecycleObserverAdapter } from './adapters/lifecycle'

/**
 * adapterId → Adapter 注册表（PLAN-S1 §3.4）。
 * 注册表以 adapterId 为稳定键；扫描定义与 Observer Adapter 仍是两层数据。
 */
export class ObserverRegistry {
  private readonly adapters = new Map<string, AgentObserverAdapter>()

  constructor() {
    this.register(new LifecycleObserverAdapter())
  }

  register(adapter: AgentObserverAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  get(adapterId: string): AgentObserverAdapter | undefined {
    return this.adapters.get(adapterId)
  }

  /**
   * 为本次安装选择 Adapter：生产 Adapter 只按 CLI Definition 的稳定
   * adapterId 精确选择；fixture 是唯一允许的显式测试覆盖。
   */
  resolve(
    context: Parameters<AgentObserverAdapter['supports']>[0]
  ): AgentObserverAdapter {
    const fixture = this.adapters.get('fixture')
    if (fixture?.supports(context)) return fixture

    const exact = this.adapters.get(context.adapterId)
    if (exact?.supports(context)) return exact

    return this.adapters.get('lifecycle') ?? new LifecycleObserverAdapter()
  }
}

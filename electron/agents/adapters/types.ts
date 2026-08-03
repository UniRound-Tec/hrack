/**
 * Observer Adapter seam（PLAN-S1 §3.3）——内部接口，不跨 IPC。
 *
 * Claude 与 Codex 至少需要两种真实协议形态，因此这个 seam 不是为单一实现
 * 制造的假抽象：`prepare` 负责 spawn 前启用结构化信号的资源（临时 settings、
 * 环境变量、安全参数），`attach` 负责进程创建后连接 socket/server/hooks。
 */

import type {
  AgentEvent,
  AgentEventSource,
  ObserverCapabilities
} from '../../../shared/agent-events'
import type { CliInstallation } from '../../../shared/ipc-contract'

export interface ObserverPreparationContext {
  sessionId: string
  installation: CliInstallation
  /** 该安装所属 CLI Definition 的 adapterId（例如 'claude-code'）。 */
  adapterId: string
  platform: NodeJS.Platform
  /** 原始用户选择；Adapter 只可用于冲突检测与只读 policy probe。 */
  workspace: string
  args: readonly string[]
  /** 本次会话专属临时目录 `<userData>/observer-runs/<sessionId>/`。 */
  runDir: string
}

export interface RunningAgentContext {
  sessionId: string
  installationId: string
  adapterId: string
  ptyId: string
  runDir: string
  cols: number
  rows: number
}

/**
 * Adapter 输出的语义事件（不可信输入）。Runtime 负责 envelope、校验、
 * 清洗、seq 分配与去重；Adapter 不自行生成 id/seq/occurredAt。
 */
type AdapterEventOf<E extends AgentEvent = AgentEvent> = E extends AgentEvent
  ? Pick<E, 'kind' | 'payload'> & {
  /** 原生协议稳定 id；重复 delivery（hook 重放 / RPC reconnect）用它去重。 */
  nativeId?: string
  /** 有界诊断字段，不参与状态逻辑。 */
  nativeType?: string
    }
  : never

/** kind 与 payload 保持同一个可辨识联合分支，禁止错配事件。 */
export type AdapterEvent = AdapterEventOf

/**
 * LaunchAugmentation 只能表达受控变化。Adapter 不得自行 spawn 主 CLI，
 * 不得替换用户工作区，不得添加权限绕过参数，也不得修改用户全局配置。
 */
export interface LaunchAugmentation {
  env?: Record<string, string>
  unsetEnv?: string[]
  prependArgs?: string[]
  appendArgs?: string[]
}

export interface ObserverHandle {
  /** attach/reconnect 后本会话实际可用的能力。 */
  readonly capabilities?: ObserverCapabilities
  /** 事件源断开通知；返回函数取消订阅。 */
  onDisconnect?(listener: (reason: string) => void): () => void
  /** Adapter 自己掌握协议细节；Runtime 最多调用一次。 */
  reconnect?(): Promise<ObserverHandle>
  dispose(): Promise<void>
}

export interface PreparedObserver {
  readonly launch: LaunchAugmentation
  /** prepare 后按安装版本、runtime 与传输方式确定的实际能力。 */
  readonly capabilities?: ObserverCapabilities

  attach(
    context: RunningAgentContext,
    emit: (event: AdapterEvent) => void
  ): Promise<ObserverHandle>

  /** spawn 失败或用户取消时回收 prepare 阶段的前置资源。 */
  dispose(): Promise<void>
}

export interface AgentObserverAdapter {
  readonly id: string
  readonly source: AgentEventSource
  /** Adapter 的最大能力；实际会话能力由 PreparedObserver/Handle 收窄。 */
  readonly capabilities: ObserverCapabilities

  supports(context: ObserverPreparationContext): boolean
  prepare(context: ObserverPreparationContext): Promise<PreparedObserver>
}

/**
 * Observer Adapter seam（PLAN-S1 §3.3）——内部接口，不跨 IPC。
 *
 * Claude 与 OpenCode 已验证两种真实协议形态，因此这个 seam 不是为单一实现
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
  /**
   * 扫描/正式启动共同使用的运行环境。WSL 下至少包含登录 shell
   * 解析得到的 PATH，避免 Adapter 裸执行 NVM/Volta/asdf 包装器。
   */
  runtimeEnvironment?: Readonly<Record<string, string>>
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
 * Adapter 输出的语义事实（不可信输入）。Runtime 负责 envelope、校验、
 * 清洗、seq 分配与去重；Adapter 不自行生成 id/seq/occurredAt。
 * Tool/request 事实必须显式带 parent turn scope。有权威的 parent terminal
 * 时只发 parent 事实，子事实的覆盖由公共 reducer 完成。
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
 * LaunchAugmentation 只能表达本次启动的受控变化。Adapter 不得自行 spawn
 * 主 CLI、替换用户工作区或添加权限绕过参数。协议只提供用户级配置入口时，
 * prepare 可以维护带所有权标记、幂等、写前验证且失败可降级的集成块；
 * 必须逐字节保留块外用户配置，不能借此改变 Agent 权限或行为策略。
 */
export interface LaunchAugmentation {
  env?: Record<string, string>
  unsetEnv?: string[]
  prependArgs?: string[]
  appendArgs?: string[]
}

export interface ObserverControl {
  submitPrompt(text: string, agent?: string): Promise<void>
  snapshotMessages(): Promise<unknown>
  setTitle?(title: string): Promise<void>
  setAgent?(agent: 'plan' | 'build'): Promise<void>
  respondPermission?(
    nativePermissionId: string,
    response: 'once' | 'always' | 'reject'
  ): Promise<void>
  listQuestions?(): Promise<unknown>
  answerQuestion?(nativeQuestionId: string, answers: unknown): Promise<void>
  rejectQuestion?(nativeQuestionId: string): Promise<void>
}

export interface ObserverHandle {
  /** attach/reconnect 后本会话实际可用的能力。 */
  readonly capabilities?: ObserverCapabilities
  /** 事件源断开通知；返回函数取消订阅。 */
  onDisconnect?(listener: (reason: string) => void): () => void
  /** Adapter 自己掌握协议细节；Runtime 最多调用一次。 */
  reconnect?(): Promise<ObserverHandle>
  /** OpenCode 控制面写/读；其它 Adapter 不提供。 */
  control?: ObserverControl
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

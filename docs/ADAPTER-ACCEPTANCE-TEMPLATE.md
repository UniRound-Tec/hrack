# M6 Agent Observer Adapter 验收模板

> 状态：**v1，2026-08-04 冻结**。
>
> 用法：为每个新产品复制为 `PLAN-M6-<ADAPTER>.md`，填写产品事实和证据，不直接修改本模板来
> 迁就单一产品。Claude Code Hooks 与 OpenCode Server/SSE 是本模板的两条参考实现。

---

## 1. Adapter 身份与交付边界

| 字段 | 内容 |
|---|---|
| 产品 / `adapterId` | `<product>` / `<adapter-id>` |
| 计划支持版本 | `<verified versions>` |
| 主协议 / 回退协议 | `<JSONL / RPC / Hooks / Server / SSE / ACP>` |
| 首版平台 | `<Windows / WSL / macOS / Linux>` |
| 真实测试安装 | `<path, runtime, distro, version>` |
| 能力声明 | `<thinking, tools, approval, input, usage, turn, errors>` |
| 明确不做 | `<external sessions, remote control, hidden reasoning...>` |

首版完成只承诺表中明确列出的版本、平台与能力。未支持能力必须声明为 `none`，观察失败必须诚实
降级为 lifecycle-only，不得用 TUI 文本猜测权威语义。

## 2. v1 公共契约冻结规则

- Renderer 只消费 `AgentSessionProjection` / `AgentEvent`，不得知道产品协议、端口、hook 或 native id；
- Adapter 只通过 `prepare → launch augmentation → attach → dispose` seam 接入，不自行启动第二份主 CLI；
- `shared/agent-events.ts` 与 `electron/agents/adapters/types.ts` 的变更必须说明至少两个产品的共同事实；
- 产品专属 payload、状态和关联表留在 Adapter 私有目录；未知 native 字段不得塞进公共可选字段袋；
- Runtime 是 PTY、Session、finalize 与历史投影的唯一所有者；Adapter dispose 必须幂等；
- 扫描定义与 Observer 注册分层；精确 `adapterId` 未命中时使用 lifecycle Adapter。

## 3. P0 — 协议取证与 fixture

- [ ] 核对当前官方协议/源码/本机 `--help`，记录核验日期、版本和不稳定字段；
- [ ] 在每个首版 runtime 上验证启动参数、健康检查与事件入口，不凭扫描缓存假设运行时能力；
- [ ] 采集无 tool、tool、permission/input、error、exit 的真实事件结构；
- [ ] 原始记录立即脱敏，只提交合成 id 与最小结构 fixture；
- [ ] 未知事件、版本别名、缺字段和超限 payload 有明确忽略或降级规则；
- [ ] 记录协议安全边界：监听地址、认证、随机 token、文件权限、body/frame 上限。

证据：`<docs / fixtures / opt-in trace>`

## 4. P1 — Parser 与私有 Projector

- [ ] native fact 到 `AdapterEvent` 的映射表完整且不含 UI 文案；
- [ ] 重复、乱序、重连 replay 不重复统计 turn/tool/approval/usage；
- [ ] 并行 tools、多 pending approval/input、父子 agent/session 不会提前完成；
- [ ] 完成、错误与 process exit 分开；native session reset 不伪装成 PTY exit；
- [ ] thinking 只输出允许的 phase/低敏 summary，隐藏推理与助手正文不离开 Adapter；
- [ ] prompt、tool input/output、认证信息和工作区内容不进入事件、历史、日志或 IPC；
- [ ] 高频 progress 可合并，队列洪峰不触碰 PTY 背压链路。

## 5. P2 — Prepare、Transport 与降级

- [ ] 所有注入在 PTY spawn 前完成，只修改本次启动参数/env 和 per-session runDir；
- [ ] 不修改用户、项目或 managed 全局配置，不添加权限绕过参数；
- [ ] readiness/health probe 有界；连接失败、EOF、重连与对账不会形成永久循环；
- [ ] host 只监听 loopback；跨 WSL 通道在运行时实测并有明确优先级；
- [ ] WSL 不硬编码 distro、IP 或 `/mnt/c`，不因 interop 假阳性宣称已连接；
- [ ] WSL capability/version probe 与正式启动复用扫描得到的同一 `PATH`；NVM、Volta、asdf、mise 等 `#!/usr/bin/env` 包装器不得裸执行；
- [ ] 缺少扫描环境时有保守 wrapper-directory fallback，并用旧系统 Node + 新用户 Node 的 fixture 覆盖；
- [ ] transport 不可用时发 `observer.degraded`，CLI 仍正常启动并保留 lifecycle 能力；
- [ ] 降级原因进入公共 projection/detail，可由 UI 直接看到；不能只留在日志或静默显示正常 idle；
- [ ] 临时资源具备大小、权限、路径和 symlink/reparse point 防线。

## 6. P3 — 生命周期与幽灵 Session 门禁

- [ ] `prepare` 失败：临时资源清零，原 CLI lifecycle-only 启动；
- [ ] `attach` 失败：不 kill 可用 PTY，不留下 helper/socket/timer；
- [ ] PTY spawn 失败或秒退：不产生 Session/历史启动计数，prepared 资源回滚；
- [ ] 端口占用、helper crash、observer disconnect：有界恢复或明确降级；
- [ ] 用户关闭、CLI 自行退出、App quit、stop/exit 竞态都只 finalize 一次；
- [ ] renderer reload 只 `listActive` 恢复，不重新 spawn、注入或克隆终端；
- [ ] 迟到 native event 不复活墓碑 Session；退出事件与历史只写一次；
- [ ] 关闭后 PTY、route、poller/helper、socket/port、runDir 全部清理。

## 7. P4 — 统一投影与产品体验

- [ ] 启动欢迎页保持 idle，不把“进程存在”误显示为 working；
- [ ] prompt → thinking/tool → needs-you/error/done 的 detail 使用公共 i18n 契约；
- [ ] 完成/错误/退出覆盖旧 thinking/tool caption，最新内容不会退回空白单行；
- [ ] Sidebar、Home attention/history、all-time stats 与悬浮窗消费同一主进程 projection；
- [ ] 重命名、主窗导航、悬浮窗点击不会创建第二个 Session 或 PTY；
- [ ] Observer 降级对用户可见，但不把观察器故障显示成 Agent 执行错误。

## 8. P5 — 平台与真实会话矩阵

| 场景 | 首版必需 | 状态 | 证据 |
|---|---:|---|---|
| Windows host | `<yes/no>` | [ ] | `<test/trace>` |
| WSL default NAT | `<yes/no>` | [ ] | `<test/trace>` |
| WSL mirrored / custom mount | `<yes/no>` | [ ] | `<test/trace>` |
| macOS host | `<yes/no>` | [ ] | `<test/trace>` |
| Linux host | `<yes/no>` | [ ] | `<test/trace>` |
| 无 tool 普通问答 → done | yes | [ ] | `<trace>` |
| tool success / failure | yes | [ ] | `<trace>` |
| permission approve / deny | 有原生能力时 | [ ] | `<trace>` |
| input/question reply / reject | 有原生能力时 | [ ] | `<trace>` |
| error / retry / Ctrl+C / native exit | yes | [ ] | `<trace>` |
| 两个并发实例不串事件 | yes | [ ] | `<trace>` |

真实测试使用临时 workspace，只操作测试文件；需要账号、计费或平台机器的用例必须 opt-in，普通 E2E
不得依赖外部网络或用户生产配置。

## 9. P6 — 自动化与 Definition of Done

- [ ] Parser/Projector fixture 门禁通过；
- [ ] Runtime interface 级失败、竞态、洪峰与隐私门禁通过；
- [ ] 至少一个首版 host 完成真实“普通问答 + tool”多轮；
- [ ] 有 permission/input 能力时，至少有 fixture 覆盖 approve/deny 或 reply/reject；
- [ ] typecheck、build、目标 E2E 通过；普通终端与既有 Adapter 无回归；
- [ ] 注册表精确选择新 Adapter，不兼容版本诚实降级；
- [ ] 本计划回写实际版本、能力、降级原因、测试证据与未覆盖矩阵；
- [ ] 新增公共字段时附跨产品理由，否则保持 v1 seam 不变。

以上阻塞项全部满足即可宣布该 Adapter 首版完成。更多 host 真机、罕见网络模式、设置页 capability
展示和性能快路径可以列为非阻塞扩展，但必须明确记录，不能用“全平台支持”笼统代替证据。

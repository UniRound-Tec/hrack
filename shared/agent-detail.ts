/**
 * 平台无关的 Agent detail 翻译协议。
 *
 * 主进程只发送稳定的 `@agent:*` 标记，桌面端和手机端分别注入当前语言文案。
 */
export interface AgentDetailStrings {
  thinking: string
  responding: string
  liveThinking: (seconds: number | undefined, tokens: number | undefined) => string
  waitingApproval: (summary: string | undefined) => string
  waitingInput: (prompt: string | undefined) => string
  runningTool: (name: string | undefined) => string
  completed: (tokens: number | undefined) => string
  error: (message: string | undefined) => string
  observerDegraded: (reason: string | undefined) => string
  exited: (exitCode: number | undefined) => string
}

/** 把 projection.detail 中的协议标记渲染为当前语言的显示文本。 */
export function renderAgentDetail(
  detail: string | undefined,
  strings: AgentDetailStrings
): string | undefined {
  if (!detail || !detail.startsWith('@agent:')) return detail

  if (detail === '@agent:thinking') return strings.thinking
  if (detail === '@agent:responding') return strings.responding
  if (detail.startsWith('@agent:live-thinking')) {
    const [, duration, tokens] = detail.slice('@agent:live-thinking'.length).split(':')
    return strings.liveThinking(
      duration && /^\d+$/.test(duration) ? Number(duration) : undefined,
      tokens && /^\d+$/.test(tokens) ? Number(tokens) : undefined
    )
  }
  if (detail.startsWith('@agent:waiting-approval')) {
    const summary = detail.startsWith('@agent:waiting-approval:')
      ? detail.slice('@agent:waiting-approval:'.length)
      : undefined
    return strings.waitingApproval(summary)
  }
  if (detail.startsWith('@agent:waiting-input')) {
    const prompt = detail.startsWith('@agent:waiting-input:')
      ? detail.slice('@agent:waiting-input:'.length)
      : undefined
    return strings.waitingInput(prompt)
  }
  if (detail.startsWith('@agent:running-tool')) {
    const name = detail.startsWith('@agent:running-tool:')
      ? detail.slice('@agent:running-tool:'.length)
      : undefined
    return strings.runningTool(name)
  }
  if (detail.startsWith('@agent:completed')) {
    const value = detail.startsWith('@agent:completed:')
      ? detail.slice('@agent:completed:'.length)
      : ''
    return strings.completed(/^\d+$/.test(value) ? Number(value) : undefined)
  }
  if (detail.startsWith('@agent:error')) {
    const message = detail.startsWith('@agent:error:')
      ? detail.slice('@agent:error:'.length)
      : undefined
    return strings.error(message)
  }
  if (detail.startsWith('@agent:observer-degraded')) {
    const reason = detail.startsWith('@agent:observer-degraded:')
      ? detail.slice('@agent:observer-degraded:'.length)
      : undefined
    return strings.observerDegraded(reason)
  }
  if (detail.startsWith('@agent:exited')) {
    const code = detail.slice('@agent:exited:'.length)
    return strings.exited(code && /^\d+$/.test(code) ? Number(code) : undefined)
  }
  return detail
}

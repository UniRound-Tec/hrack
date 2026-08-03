import type { AppStrings } from './i18n'

/**
 * 把主进程 projection.detail 渲染为当前语言的显示文本。
 * 数据型 detail（tool 名、approval summary、错误消息）原样透传；
 * 固定短语以 `@agent:<key>` / `@agent:<key>:<param>` 标记由 renderer 翻译。
 */
export function renderAgentDetail(
  detail: string | undefined,
  strings: AppStrings
): string | undefined {
  if (!detail || !detail.startsWith('@agent:')) return detail

  if (detail === '@agent:thinking') return strings.agentDetail.thinking
  if (detail.startsWith('@agent:live-thinking')) {
    const [, duration, tokens] = detail.slice('@agent:live-thinking'.length).split(':')
    return strings.agentDetail.liveThinking(
      duration && /^\d+$/.test(duration) ? Number(duration) : undefined,
      tokens && /^\d+$/.test(tokens) ? Number(tokens) : undefined
    )
  }
  if (detail.startsWith('@agent:waiting-approval')) {
    const summary = detail.startsWith('@agent:waiting-approval:')
      ? detail.slice('@agent:waiting-approval:'.length)
      : undefined
    return strings.agentDetail.waitingApproval(summary)
  }
  if (detail.startsWith('@agent:waiting-input')) {
    const prompt = detail.startsWith('@agent:waiting-input:')
      ? detail.slice('@agent:waiting-input:'.length)
      : undefined
    return strings.agentDetail.waitingInput(prompt)
  }
  if (detail.startsWith('@agent:running-tool')) {
    const name = detail.startsWith('@agent:running-tool:')
      ? detail.slice('@agent:running-tool:'.length)
      : undefined
    return strings.agentDetail.runningTool(name)
  }
  if (detail.startsWith('@agent:completed')) {
    const value = detail.startsWith('@agent:completed:')
      ? detail.slice('@agent:completed:'.length)
      : ''
    return strings.agentDetail.completed(
      /^\d+$/.test(value) ? Number(value) : undefined
    )
  }
  if (detail.startsWith('@agent:error')) {
    const message = detail.startsWith('@agent:error:')
      ? detail.slice('@agent:error:'.length)
      : undefined
    return strings.agentDetail.error(message)
  }
  if (detail.startsWith('@agent:exited')) {
    const code = detail.slice('@agent:exited:'.length)
    const exitCode =
      code && /^\d+$/.test(code) ? Number(code) : undefined
    return strings.agentDetail.exited(exitCode)
  }
  return detail
}

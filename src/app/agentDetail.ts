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
  if (detail === '@agent:waiting-approval') {
    return strings.agentDetail.waitingApproval
  }
  if (detail === '@agent:waiting-input') {
    return strings.agentDetail.waitingInput
  }
  if (detail.startsWith('@agent:exited')) {
    const code = detail.slice('@agent:exited:'.length)
    const exitCode =
      code && /^\d+$/.test(code) ? Number(code) : undefined
    return strings.agentDetail.exited(exitCode)
  }
  return detail
}

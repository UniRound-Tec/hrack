import type { AppStrings } from './i18n'
import { renderAgentDetail as renderSharedAgentDetail } from '../../shared/agent-detail'

/**
 * 把主进程 projection.detail 渲染为当前语言的显示文本。
 * 数据型 detail（tool 名、approval summary、错误消息）原样透传；
 * 固定短语以 `@agent:<key>` / `@agent:<key>:<param>` 标记由 renderer 翻译。
 */
export function renderAgentDetail(
  detail: string | undefined,
  strings: AppStrings
): string | undefined {
  return renderSharedAgentDetail(detail, strings.agentDetail)
}

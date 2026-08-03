export interface RenderedActivityCaption {
  text: string
  outputTokens?: number
}

const ACTIVITY_LINE = /^\s*[✢✻✽✶*·]\s+[\p{L}][\p{L}\p{M}'’ -]{0,48}…(?:\s*\(([^)]{1,160})\))?\s*$/u
const TOKEN_MARKER = /↓\s*([\d,.]+(?:\.\d+)?\s*[kKmM]?)\s+tokens?\b/i
const DURATION_MARKER = /(?:^|·)\s*(\d{1,6})s\b/i
const MAX_SCAN_LINES = 12

function tokenCount(value: string): number | null {
  const normalized = value.replace(/[\s,]/g, '')
  const match = /^([\d.]+)([kKmM]?)$/.exec(normalized)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount < 0) return null
  const multiplier = match[2].toLowerCase() === 'k'
    ? 1_000
    : match[2].toLowerCase() === 'm'
      ? 1_000_000
      : 1
  const result = Math.round(amount * multiplier)
  return result <= 10_000_000_000 ? result : null
}

/**
 * 只解析 xterm 已完成 ANSI/光标重绘后的 Claude 活动状态行。随机动词和思考
 * 正文都不会跨 IPC；renderer 只上报耗时、token 数与固定 i18n 标记。
 */
export function parseRenderedActivityCaption(
  lines: readonly string[]
): RenderedActivityCaption | null {
  const start = Math.max(0, lines.length - MAX_SCAN_LINES)
  for (let index = lines.length - 1; index >= start; index--) {
    const activity = ACTIVITY_LINE.exec(lines[index])
    if (!activity) continue
    const metadata = activity[1] ?? ''
    const durationMatch = DURATION_MARKER.exec(metadata)
    const durationSeconds = durationMatch ? Number(durationMatch[1]) : undefined
    const tokenMatch = TOKEN_MARKER.exec(metadata)
    const outputTokens = tokenMatch ? tokenCount(tokenMatch[1]) : null
    const parts = [
      '@agent:live-thinking',
      durationSeconds === undefined ? '' : String(durationSeconds),
      outputTokens === null ? '' : String(outputTokens)
    ]
    return {
      text: parts.join(':'),
      outputTokens: outputTokens ?? undefined
    }
  }
  return null
}

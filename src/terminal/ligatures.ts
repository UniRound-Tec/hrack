import type { Terminal } from '@xterm/xterm'

export type LigatureRange = [start: number, end: number]

// Maple Mono 的 calt 主要作用于连续运算符。把整段交给浏览器字体整形：
// 字体中存在的组合会形成连字，不存在的组合仍按原字符逐格绘制。
const OPERATOR_RUN = /[!#%&*+\-./:<=>?@\\^_|~]{2,}/g
const BUILT_IN_TAG =
  /\[(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL|TODO|FIXME|NOTE|HACK|MARK|EROR|WARNING)\]/g
const ALTERNATE_TAG = /(?:TODO|FIXME)\)\)/gi

function collectMatches(text: string, expression: RegExp): LigatureRange[] {
  expression.lastIndex = 0
  const ranges: LigatureRange[] = []
  for (const match of text.matchAll(expression)) {
    const start = match.index
    if (start === undefined || match[0].length < 2) continue
    ranges.push([start, start + match[0].length])
  }
  return ranges
}

export function findLigatureRanges(text: string): LigatureRange[] {
  return [
    ...collectMatches(text, OPERATOR_RUN),
    ...collectMatches(text, BUILT_IN_TAG),
    ...collectMatches(text, ALTERNATE_TAG)
  ].sort((left, right) => left[0] - right[0] || right[1] - left[1])
}

export interface LigatureController {
  setEnabled(enabled: boolean): void
  isEnabled(): boolean
  dispose(): void
}

export function createLigatureController(
  term: Terminal,
  initiallyEnabled: boolean
): LigatureController {
  let joinerId: number | null = null

  const setEnabled = (enabled: boolean): void => {
    if (enabled === (joinerId !== null)) return
    if (enabled) {
      joinerId = term.registerCharacterJoiner(findLigatureRanges)
      return
    }
    term.deregisterCharacterJoiner(joinerId!)
    joinerId = null
  }

  setEnabled(initiallyEnabled)

  return {
    setEnabled,
    isEnabled: () => joinerId !== null,
    dispose: () => setEnabled(false)
  }
}

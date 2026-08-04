const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const CURSOR_HOME = '\x1b[H'
const FINAL_CURSOR_POSITION = /\x1b\[(\d+);(\d+)H\x1b\[\?25h$/
const DEC_PRIVATE_MODE = /\x1b\[\?([0-9;]+)[hl]/g

const DEFAULT_MAX_CANDIDATE_CHARS = 4 * 1024 * 1024
const MAX_HEADER_CHARS = 64

export interface ConptyResizeFilterOptions {
  maxCandidateChars?: number
}

export interface ConptyResizeFilterResult {
  /** 应继续发给 renderer xterm 的原始数据。 */
  forward: string
  /** 本次 push 中完整识别并抑制的 ConPTY resize 重画数量。 */
  suppressedRedraws: number
  /** 被抑制帧末尾可确定的 ConPTY 1-based 光标坐标。 */
  cursorSyncs: Array<{ row: number; column: number }>
}

/**
 * Resize 重画可以安全丢弃像素/文字，但不能丢弃应用在同一帧里只发送一次的
 * DECSET/DECRST。OpenTUI 会在首帧内开启 alternate screen、鼠标、焦点与粘贴
 * 模式；若这些序列随 ConPTY 重画一起被吞，画面仍可能靠后续帧出现，但 TUI
 * 永远收不到鼠标与相关输入。
 *
 * 光标显隐（?25h/l）属于重画事务本身，最终状态由帧尾与 cursorSync 单独维护，
 * 不需要转发。其余 private mode 按原顺序保留。
 */
function persistentModes(frame: string): string {
  let result = ''
  for (const match of frame.matchAll(DEC_PRIVATE_MODE)) {
    const modes = match[1].split(';')
    if (modes.every((mode) => mode === '25')) continue
    result += match[0]
  }
  return result
}

/**
 * 从显示链路中移除 ConPTY resize 后的整屏重画事务。
 *
 * ConPTY 的稳定帧：
 *   CSI ?25l  [可选 CSI 8;<rows>;<cols>t]  CSI H  <逐行重画>  CSI ?25h
 *
 * 只有 expectResize 后紧接着的数据严格匹配该帧头才会进入抑制状态。
 * 控制序列可跨任意 onData chunk；不匹配时原样放行，避免吞掉应用自己的输出。
 */
export class ConptyResizeFilter {
  private readonly maxCandidateChars: number
  private nextGeneration = 1
  private expectedGeneration: number | null = null
  private captureGeneration: number | null = null
  private candidate = ''
  private capturing = false

  constructor(options: ConptyResizeFilterOptions = {}) {
    this.maxCandidateChars =
      options.maxCandidateChars ?? DEFAULT_MAX_CANDIDATE_CHARS
  }

  expectResize(): number {
    const generation = this.nextGeneration++
    // ConPTY 会合并快速连续的 resize；只等待最新一代，不能累计欠账。
    this.expectedGeneration = generation
    return generation
  }

  /** 撤销最后一次尚未成功送达 PTY 的 resize 预期。 */
  cancelExpectedResize(generation: number): void {
    if (this.expectedGeneration !== generation) return
    if (this.capturing && this.captureGeneration !== null) {
      this.expectedGeneration = this.captureGeneration
    } else {
      this.expectedGeneration = null
    }
  }

  push(data: string): ConptyResizeFilterResult {
    if (data.length === 0) {
      return { forward: '', suppressedRedraws: 0, cursorSyncs: [] }
    }
    if (this.expectedGeneration === null && !this.capturing) {
      return { forward: data, suppressedRedraws: 0, cursorSyncs: [] }
    }

    this.candidate += data
    let forward = ''
    let suppressedRedraws = 0
    const cursorSyncs: Array<{ row: number; column: number }> = []

    while (this.candidate.length > 0) {
      if (this.candidate.length > this.maxCandidateChars) {
        forward += this.candidate
        this.reset()
        break
      }

      if (!this.capturing) {
        const header = this.classifyHeader()
        if (header === 'incomplete') break
        if (header === 'invalid') {
          // resize 后的第一个输出不是 ConPTY 重画，宁可放行也不误吞。
          forward += this.candidate
          this.reset()
          break
        }
        this.capturing = true
        this.captureGeneration = this.expectedGeneration
      }

      const end = this.candidate.indexOf(SHOW_CURSOR)
      if (end === -1) break

      const frameEnd = end + SHOW_CURSOR.length
      const frame = this.candidate.slice(0, frameEnd)
      forward += persistentModes(frame)
      const cursor = frame.match(FINAL_CURSOR_POSITION)
      if (cursor) {
        cursorSyncs.push({
          row: Number(cursor[1]),
          column: Number(cursor[2])
        })
      }
      this.candidate = this.candidate.slice(frameEnd)
      if (this.expectedGeneration === this.captureGeneration) {
        this.expectedGeneration = null
      }
      this.capturing = false
      this.captureGeneration = null
      suppressedRedraws++

      if (this.expectedGeneration === null) {
        forward += this.candidate
        this.candidate = ''
        break
      }
    }

    return { forward, suppressedRedraws, cursorSyncs }
  }

  private classifyHeader(): 'complete' | 'incomplete' | 'invalid' {
    if (this.candidate.length < HIDE_CURSOR.length) {
      return HIDE_CURSOR.startsWith(this.candidate) ? 'incomplete' : 'invalid'
    }
    if (!this.candidate.startsWith(HIDE_CURSOR)) return 'invalid'

    const rest = this.candidate.slice(HIDE_CURSOR.length)
    if (rest.startsWith(CURSOR_HOME)) return 'complete'
    if (CURSOR_HOME.startsWith(rest)) return 'incomplete'

    const windowSize = rest.match(/^(\x1b\[8;\d+;\d+t)/)
    if (windowSize) {
      const afterWindowSize = rest.slice(windowSize[1].length)
      if (afterWindowSize.startsWith(CURSOR_HOME)) return 'complete'
      return CURSOR_HOME.startsWith(afterWindowSize)
        ? 'incomplete'
        : 'invalid'
    }

    // 只接受 CSI 8;<rows>;<cols>t 的语法前缀；一旦偏离立即原样放行。
    const possibleWindowSize =
      /^\x1b(?:\[8(?:;\d*(?:;\d*(?:t)?)?)?)?$/.test(rest)
    if (possibleWindowSize && rest.length <= MAX_HEADER_CHARS) {
      return 'incomplete'
    }
    return 'invalid'
  }

  private reset(): void {
    this.expectedGeneration = null
    this.captureGeneration = null
    this.candidate = ''
    this.capturing = false
  }
}

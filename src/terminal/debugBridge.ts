import type { Terminal } from '@xterm/xterm'
import type {
  PtyFlowControlSnapshot,
  PtyHistorySnapshot
} from '../../shared/ipc-contract'

export interface TerminalSnapshot {
  cols: number
  rows: number
  bufferType: 'normal' | 'alternate'
  length: number
  baseY: number
  viewportY: number
  cursorX: number
  cursorY: number
  lastNonEmptyLine: number
}

export interface VibingDebugApi {
  snapshot(): TerminalSnapshot | null
  dumpBuffer(): string[]
  dumpLogicalBuffer(): string[]
  selectionText(): string
  dumpViewport(): string[]
  scrollLines(amount: number): void
  scrollToTop(): void
  scrollToBottom(): void
  selectText(text: string): boolean
  forceResize(): void
  setSize(cols: number, rows: number): void
  clearSeqLog(): ClearSeqLog
  resetClearSeqLog(): void
  dumpAuthoritativeHistory(): Promise<PtyHistorySnapshot | null>
  flowControl(): Promise<PtyFlowControlSnapshot | null>
  setPtyAckDelay(milliseconds: number): void
}

export interface VibingDebugTabsApi {
  list(): string[]
  forTab(tabId: string): VibingDebugApi
}

export interface ClearSeqLog {
  ed2: number
  ed3: number
  events: Array<{ at: number; kind: string; chunkLen: number }>
}

interface TerminalRegistration {
  term: Terminal
  forceResize: () => void
  dumpHistory: () => Promise<PtyHistorySnapshot | null>
  dumpFlowControl: () => Promise<PtyFlowControlSnapshot | null>
  setPtyAckDelay: (milliseconds: number) => void
  clearLog: ClearSeqLog
}

const registrations = new Map<string, TerminalRegistration>()
let activeTabId: string | null = null

function bufferToLines(term: Terminal, fromViewportOnly: boolean): string[] {
  const buffer = term.buffer.active
  const start = fromViewportOnly ? buffer.viewportY : 0
  const end = fromViewportOnly ? buffer.viewportY + term.rows : buffer.length
  const lines: string[] = []
  for (let row = start; row < end; row++) {
    const line = buffer.getLine(row)
    lines.push(line ? line.translateToString(true) : '')
  }
  return lines
}

function bufferToLogicalLines(term: Terminal): string[] {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row)
    if (!line) {
      lines.push('')
      continue
    }
    const text = line.translateToString(true)
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text
    } else {
      lines.push(text)
    }
  }
  return lines
}

function createApi(
  getRegistration: () => TerminalRegistration | undefined
): VibingDebugApi {
  return {
    snapshot() {
      const registration = getRegistration()
      if (!registration) return null
      const { term } = registration
      const buffer = term.buffer.active
      let lastNonEmptyLine = -1
      for (let row = buffer.length - 1; row >= 0; row--) {
        const line = buffer.getLine(row)
        if (line && line.translateToString(true).trim() !== '') {
          lastNonEmptyLine = row
          break
        }
      }
      return {
        cols: term.cols,
        rows: term.rows,
        bufferType: buffer.type,
        length: buffer.length,
        baseY: buffer.baseY,
        viewportY: buffer.viewportY,
        cursorX: buffer.cursorX,
        cursorY: buffer.cursorY,
        lastNonEmptyLine
      }
    },
    dumpBuffer() {
      const registration = getRegistration()
      return registration ? bufferToLines(registration.term, false) : []
    },
    dumpLogicalBuffer() {
      const registration = getRegistration()
      return registration ? bufferToLogicalLines(registration.term) : []
    },
    selectionText() {
      return getRegistration()?.term.getSelection() ?? ''
    },
    dumpViewport() {
      const registration = getRegistration()
      return registration ? bufferToLines(registration.term, true) : []
    },
    scrollLines(amount: number) {
      getRegistration()?.term.scrollLines(amount)
    },
    scrollToTop() {
      getRegistration()?.term.scrollToTop()
    },
    scrollToBottom() {
      getRegistration()?.term.scrollToBottom()
    },
    selectText(text: string) {
      const registration = getRegistration()
      if (!registration || text.length === 0) return false
      const { term } = registration
      const buffer = term.buffer.active
      for (let row = 0; row < buffer.length; row++) {
        const line = buffer.getLine(row)
        const column = line?.translateToString(false).indexOf(text) ?? -1
        if (column >= 0) {
          term.select(column, row, text.length)
          return term.getSelection() === text
        }
      }
      return false
    },
    forceResize() {
      getRegistration()?.forceResize()
    },
    setSize(cols: number, rows: number) {
      getRegistration()?.term.resize(cols, rows)
    },
    clearSeqLog() {
      const log = getRegistration()?.clearLog
      return log
        ? { ed2: log.ed2, ed3: log.ed3, events: [...log.events] }
        : { ed2: 0, ed3: 0, events: [] }
    },
    resetClearSeqLog() {
      const log = getRegistration()?.clearLog
      if (!log) return
      log.ed2 = 0
      log.ed3 = 0
      log.events.length = 0
    },
    dumpAuthoritativeHistory() {
      return getRegistration()?.dumpHistory() ?? Promise.resolve(null)
    },
    flowControl() {
      return getRegistration()?.dumpFlowControl() ?? Promise.resolve(null)
    },
    setPtyAckDelay(milliseconds: number) {
      getRegistration()?.setPtyAckDelay(milliseconds)
    }
  }
}

const activeApi = createApi(() =>
  activeTabId ? registrations.get(activeTabId) : undefined
)

const tabsApi: VibingDebugTabsApi = {
  list: () => [...registrations.keys()],
  forTab: (tabId) => {
    const registration = registrations.get(tabId)
    return createApi(() => registration)
  }
}

function shouldEnable(): boolean {
  try {
    return (
      Boolean(import.meta.env?.DEV) ||
      Boolean(
        (globalThis as Record<string, unknown>)['__VIBING_E2E__']
      )
    )
  } catch {
    return false
  }
}

function exposeDebugApis(): void {
  const debugWindow = window as unknown as Record<string, unknown>
  debugWindow['__vibingDebug'] = activeApi
  debugWindow['__vibingDebugTabs'] = tabsApi
}

function hideDebugApis(): void {
  const debugWindow = window as unknown as Record<string, unknown>
  delete debugWindow['__vibingDebug']
  delete debugWindow['__vibingDebugTabs']
}

export function recordPtyData(tabId: string, data: Uint8Array): void {
  const log = registrations.get(tabId)?.clearLog
  if (!log) return
  const text = new TextDecoder().decode(data)
  let kind = ''
  if (text.includes('\x1b[3J')) {
    log.ed3++
    kind += 'ED3(clear-scrollback) '
  }
  if (text.includes('\x1b[2J')) {
    log.ed2++
    kind += 'ED2(clear-screen) '
  }
  if (!kind) return
  log.events.push({
    at: performance.now(),
    kind: kind.trim(),
    chunkLen: data.length
  })
  if (log.events.length > 200) log.events.shift()
}

export function setActiveTerminalForDebug(tabId: string): void {
  if (!registrations.has(tabId)) return
  activeTabId = tabId
}

export function registerTerminalForDebug(
  tabId: string,
  term: Terminal,
  forceResize: () => void,
  dumpHistory: () => Promise<PtyHistorySnapshot | null>,
  dumpFlowControl: () => Promise<PtyFlowControlSnapshot | null>,
  setPtyAckDelay: (milliseconds: number) => void
): () => void {
  if (!shouldEnable()) return () => {}

  registrations.set(tabId, {
    term,
    forceResize,
    dumpHistory,
    dumpFlowControl,
    setPtyAckDelay,
    clearLog: { ed2: 0, ed3: 0, events: [] }
  })
  if (!activeTabId) activeTabId = tabId
  exposeDebugApis()

  return () => {
    const current = registrations.get(tabId)
    if (current?.term !== term) return
    registrations.delete(tabId)
    if (activeTabId === tabId) {
      activeTabId = registrations.keys().next().value ?? null
    }
    if (registrations.size === 0) hideDebugApis()
  }
}

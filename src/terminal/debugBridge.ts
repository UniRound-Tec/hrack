import type { Terminal } from '@xterm/xterm'
import type {
  RendererController,
  RendererEvent,
  RendererKind
} from './addons'
import { useSettingsStore } from '../state/settingsStore'
import type { ThemeId } from './themes'
import { findLigatureRanges, type LigatureRange } from './ligatures'
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
  showCursor: boolean
  lastNonEmptyLine: number
}

export interface HRackDebugApi {
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
  mouseTrackingMode(): Terminal['modes']['mouseTrackingMode']
  rendererKind(): RendererKind
  rendererEvents(): RendererEvent[]
  forceContextLoss(): boolean
  forceDomRenderer(): void
  writeRenderFixture(data: string): Promise<void>
  sendInput(data: string): Promise<void>
  setPtyRenderingSuspended(suspended: boolean): void
  setTheme(themeId: ThemeId): void
  setFont(fontFamily: string, fontSize: number): void
  setLigatures(enabled: boolean): void
  ligatureRanges(text: string): LigatureRange[]
  resetSettings(): void
  terminalAppearance(): {
    theme: Terminal['options']['theme']
    fontFamily: string
    fontSize: number
    ligatures: boolean
  }
}

export interface HRackDebugTabsApi {
  list(): string[]
  forTab(tabId: string): HRackDebugApi
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
  renderer: RendererController
  setPtyRenderingSuspended: (suspended: boolean) => void
  sendInput: (data: string) => Promise<void>
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

function scrollImmediately(term: Terminal, action: () => void): void {
  const smoothScrollDuration = term.options.smoothScrollDuration
  term.options.smoothScrollDuration = 0
  try {
    action()
  } finally {
    term.options.smoothScrollDuration = smoothScrollDuration
  }
}

function createApi(
  getRegistration: () => TerminalRegistration | undefined
): HRackDebugApi {
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
        showCursor: term.modes.showCursor,
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
      const term = getRegistration()?.term
      if (term) scrollImmediately(term, () => term.scrollLines(amount))
    },
    scrollToTop() {
      const term = getRegistration()?.term
      if (term) scrollImmediately(term, () => term.scrollToTop())
    },
    scrollToBottom() {
      const term = getRegistration()?.term
      if (term) scrollImmediately(term, () => term.scrollToBottom())
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
    },
    mouseTrackingMode() {
      return getRegistration()?.term.modes.mouseTrackingMode ?? 'none'
    },
    rendererKind() {
      return getRegistration()?.renderer.kind() ?? 'dom'
    },
    rendererEvents() {
      return getRegistration()?.renderer.events() ?? []
    },
    forceContextLoss() {
      return getRegistration()?.renderer.forceContextLoss() ?? false
    },
    forceDomRenderer() {
      getRegistration()?.renderer.deactivate('debug-forced')
    },
    writeRenderFixture(data: string) {
      const registration = getRegistration()
      if (!registration) return Promise.resolve()
      return new Promise<void>((resolve) => {
        registration.term.write(data, resolve)
      })
    },
    sendInput(data: string) {
      return getRegistration()?.sendInput(data) ?? Promise.resolve()
    },
    setPtyRenderingSuspended(suspended: boolean) {
      getRegistration()?.setPtyRenderingSuspended(suspended)
    },
    setTheme(themeId: ThemeId) {
      useSettingsStore.getState().setTerminalTheme(themeId)
    },
    setFont(fontFamily: string, fontSize: number) {
      useSettingsStore.getState().setFont(fontFamily, fontSize)
    },
    setLigatures(enabled: boolean) {
      useSettingsStore.getState().setLigatures(enabled)
    },
    ligatureRanges(text: string) {
      return findLigatureRanges(text)
    },
    resetSettings() {
      useSettingsStore.getState().reset()
    },
    terminalAppearance() {
      const term = getRegistration()?.term
      return {
        theme: term?.options.theme ?? {},
        fontFamily: term?.options.fontFamily ?? '',
        fontSize: term?.options.fontSize ?? 0,
        ligatures: useSettingsStore.getState().ligatures
      }
    }
  }
}

const activeApi = createApi(() =>
  activeTabId ? registrations.get(activeTabId) : undefined
)

const tabsApi: HRackDebugTabsApi = {
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
        (globalThis as Record<string, unknown>)['__HRACK_E2E__']
      )
    )
  } catch {
    return false
  }
}

function exposeDebugApis(): void {
  const debugWindow = window as unknown as Record<string, unknown>
  debugWindow['__hrackDebug'] = activeApi
  debugWindow['__hrackDebugTabs'] = tabsApi
}

function hideDebugApis(): void {
  const debugWindow = window as unknown as Record<string, unknown>
  delete debugWindow['__hrackDebug']
  delete debugWindow['__hrackDebugTabs']
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
  setPtyAckDelay: (milliseconds: number) => void,
  renderer: RendererController,
  setPtyRenderingSuspended: (suspended: boolean) => void,
  sendInput: (data: string) => Promise<void>
): () => void {
  if (!shouldEnable()) return () => {}

  registrations.set(tabId, {
    term,
    forceResize,
    dumpHistory,
    dumpFlowControl,
    setPtyAckDelay,
    renderer,
    setPtyRenderingSuspended,
    sendInput,
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

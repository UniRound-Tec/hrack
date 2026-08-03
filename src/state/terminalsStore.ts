import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { TerminalLaunchOptions } from './terminalLaunchRegistry'
import type { RecoverablePty } from '../../shared/ipc-contract'
import {
  removeTerminalLaunch,
  setTerminalLaunch
} from './terminalLaunchRegistry'

export interface TerminalEntry {
  id: string
  name: string
  cwd: string
  shellId: string
  exited: boolean
}

export interface AddTerminalOptions {
  shellId?: string
  cwd?: string
  launch?: TerminalLaunchOptions
}

export interface TerminalsState {
  terminals: TerminalEntry[]
  activeTerminalId: string | null
  addTerminal(options?: AddTerminalOptions): TerminalEntry
  restoreTerminals(terminals: readonly RecoverablePty[]): void
  closeTerminal(id: string): boolean
  activateTerminal(id: string): void
  setTitle(id: string, title: string): void
  markExited(id: string): void
}

/**
 * A factory keeps unit tests isolated while the exported singleton remains a
 * regular Zustand React store. `closeTerminal` returns true when the removed
 * entry was the final terminal so AppShell can route Home without closing.
 */
export function createTerminalsStore(
  options: {
    initialTerminal?: boolean
  } = {}
): UseBoundStore<StoreApi<TerminalsState>> {
  let nextTerminalNumber = 1
  const fallbackNames = new Map<string, string>()

  const createTerminal = (options: AddTerminalOptions = {}): TerminalEntry => {
    const fallbackName = `Terminal ${nextTerminalNumber++}`
    const terminal = {
      id: crypto.randomUUID(),
      name: fallbackName,
      cwd: options.cwd?.trim() ?? '',
      shellId: options.shellId?.trim() || 'system',
      exited: false
    }
    fallbackNames.set(terminal.id, fallbackName)
    setTerminalLaunch(terminal.id, options.launch)
    return terminal
  }

  const initialTerminal =
    options.initialTerminal === false ? null : createTerminal()

  return create<TerminalsState>((set, get) => ({
    terminals: initialTerminal ? [initialTerminal] : [],
    activeTerminalId: initialTerminal?.id ?? null,
    addTerminal: (options) => {
      const terminal = createTerminal(options)
      set((state) => ({
        terminals: [...state.terminals, terminal],
        activeTerminalId: terminal.id
      }))
      return terminal
    },
    restoreTerminals: (recoverable) => {
      if (recoverable.length === 0) return
      set((state) => {
        const existingIds = new Set(
          state.terminals.map((terminal) => terminal.id)
        )
        const restored: TerminalEntry[] = []
        for (const item of recoverable) {
          if (existingIds.has(item.terminalId)) continue
          const fallbackName =
            item.name.trim() || `Terminal ${nextTerminalNumber}`
          nextTerminalNumber++
          fallbackNames.set(item.terminalId, fallbackName)
          setTerminalLaunch(item.terminalId, {
            kind: 'attach',
            ptyId: item.ptyId,
            agent: item.kind === 'agent'
          })
          restored.push({
            id: item.terminalId,
            name: fallbackName,
            cwd: item.cwd.trim(),
            shellId: item.shellId.trim() || 'system',
            exited: item.exited
          })
        }
        if (restored.length === 0) return state
        const terminals = [...state.terminals, ...restored]
        return {
          terminals,
          activeTerminalId: state.activeTerminalId ?? terminals[0].id
        }
      })
    },
    closeTerminal: (id) => {
      const state = get()
      const closingIndex = state.terminals.findIndex(
        (terminal) => terminal.id === id
      )
      if (closingIndex < 0) return false
      fallbackNames.delete(id)
      removeTerminalLaunch(id)
      const terminals = state.terminals.filter((terminal) => terminal.id !== id)
      const activeTerminalId =
        terminals.length === 0
          ? null
          : state.activeTerminalId === id
            ? terminals[Math.min(closingIndex, terminals.length - 1)].id
            : state.activeTerminalId
      set({ terminals, activeTerminalId })
      return terminals.length === 0
    },
    activateTerminal: (id) =>
      set((state) =>
        state.terminals.some((terminal) => terminal.id === id)
          ? { activeTerminalId: id }
          : state
      ),
    setTitle: (id, title) => {
      const normalized = title.trim()
      set((state) => ({
        terminals: state.terminals.map((terminal) =>
          terminal.id === id
            ? {
                ...terminal,
                name: normalized || fallbackNames.get(id) || terminal.name
              }
            : terminal
        )
      }))
    },
    markExited: (id) =>
      set((state) => ({
        terminals: state.terminals.map((terminal) =>
          terminal.id === id ? { ...terminal, exited: true } : terminal
        )
      }))
  }))
}

// 产品 Store 先等待主进程恢复旧 PTY；只有确认无可恢复实例后
// AppShell 才创建首个默认终端。工厂默认仍保留初始终端，便于独立单测。
export const useTerminalsStore = createTerminalsStore({
  initialTerminal: false
})

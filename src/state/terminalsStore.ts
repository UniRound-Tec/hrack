import { create, type StoreApi, type UseBoundStore } from 'zustand'

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
}

export interface TerminalsState {
  terminals: TerminalEntry[]
  activeTerminalId: string
  addTerminal(options?: AddTerminalOptions): TerminalEntry
  closeTerminal(id: string): boolean
  activateTerminal(id: string): void
  setTitle(id: string, title: string): void
  markExited(id: string): void
}

/**
 * A factory keeps unit tests isolated while the exported singleton remains a
 * regular Zustand React store. P1 preserves the M3 final-tab return value;
 * P2 consumes it to route Home instead of closing the window.
 */
export function createTerminalsStore(): UseBoundStore<
  StoreApi<TerminalsState>
> {
  let nextTerminalNumber = 1
  const fallbackNames = new Map<string, string>()

  const createTerminal = (
    options: AddTerminalOptions = {}
  ): TerminalEntry => {
    const fallbackName = `Terminal ${nextTerminalNumber++}`
    const terminal = {
      id: crypto.randomUUID(),
      name: fallbackName,
      cwd: options.cwd?.trim() ?? '',
      shellId: options.shellId?.trim() || 'system',
      exited: false
    }
    fallbackNames.set(terminal.id, fallbackName)
    return terminal
  }

  const initialTerminal = createTerminal()

  return create<TerminalsState>((set, get) => ({
    terminals: [initialTerminal],
    activeTerminalId: initialTerminal.id,
    addTerminal: (options) => {
      const terminal = createTerminal(options)
      set((state) => ({
        terminals: [...state.terminals, terminal],
        activeTerminalId: terminal.id
      }))
      return terminal
    },
    closeTerminal: (id) => {
      const state = get()
      const closingIndex = state.terminals.findIndex(
        (terminal) => terminal.id === id
      )
      if (closingIndex < 0) return false
      if (state.terminals.length === 1) return true

      fallbackNames.delete(id)
      const terminals = state.terminals.filter(
        (terminal) => terminal.id !== id
      )
      const activeTerminalId =
        state.activeTerminalId === id
          ? terminals[Math.min(closingIndex, terminals.length - 1)].id
          : state.activeTerminalId
      set({ terminals, activeTerminalId })
      return false
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
                name:
                  normalized || fallbackNames.get(id) || terminal.name
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

export const useTerminalsStore = createTerminalsStore()

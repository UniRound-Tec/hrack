import { create } from 'zustand'

export interface TerminalTab {
  id: string
  title: string
  fallbackTitle: string
  exited: boolean
}

interface TabsState {
  tabs: TerminalTab[]
  activeTabId: string
  addTab(): void
  closeTab(id: string): boolean
  activateTab(id: string): void
  setTitle(id: string, title: string): void
  markExited(id: string): void
}

let nextTerminalNumber = 1

function createTerminalTab(): TerminalTab {
  const number = nextTerminalNumber++
  const fallbackTitle = `Terminal ${number}`
  return {
    id: crypto.randomUUID(),
    title: fallbackTitle,
    fallbackTitle,
    exited: false
  }
}

const initialTab = createTerminalTab()

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [initialTab],
  activeTabId: initialTab.id,
  addTab: () =>
    set((state) => {
      const tab = createTerminalTab()
      return {
        tabs: [...state.tabs, tab],
        activeTabId: tab.id
      }
    }),
  closeTab: (id) => {
    const state = get()
    const closingIndex = state.tabs.findIndex((tab) => tab.id === id)
    if (closingIndex < 0) return false
    if (state.tabs.length === 1) return true

    const tabs = state.tabs.filter((tab) => tab.id !== id)
    const activeTabId =
      state.activeTabId === id
        ? tabs[Math.min(closingIndex, tabs.length - 1)].id
        : state.activeTabId
    set({ tabs, activeTabId })
    return false
  },
  activateTab: (id) =>
    set((state) =>
      state.tabs.some((tab) => tab.id === id)
        ? { activeTabId: id }
        : state
    ),
  setTitle: (id, title) => {
    const normalized = title.trim()
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id
          ? { ...tab, title: normalized || tab.fallbackTitle }
          : tab
      )
    }))
  },
  markExited: (id) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id ? { ...tab, exited: true } : tab
      )
    }))
}))

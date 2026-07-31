import { useTabsStore } from '../state/tabsStore'

const handledEvents = new WeakSet<KeyboardEvent>()

function activateRelativeTab(delta: number): void {
  const state = useTabsStore.getState()
  if (state.tabs.length < 2) return
  const currentIndex = state.tabs.findIndex(
    (tab) => tab.id === state.activeTabId
  )
  const nextIndex =
    (currentIndex + delta + state.tabs.length) % state.tabs.length
  state.activateTab(state.tabs[nextIndex].id)
}

function closeActiveTab(): void {
  const state = useTabsStore.getState()
  if (state.closeTab(state.activeTabId)) window.close()
}

export function handleTabShortcut(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown') return false
  if (!event.ctrlKey || event.altKey || event.metaKey) return false
  if (handledEvents.has(event)) return true

  let handled = true
  if (event.shiftKey && event.code === 'KeyT') {
    useTabsStore.getState().addTab()
  } else if (event.shiftKey && event.code === 'KeyW') {
    closeActiveTab()
  } else if (event.code === 'Tab') {
    activateRelativeTab(event.shiftKey ? -1 : 1)
  } else {
    handled = false
  }

  if (handled) {
    handledEvents.add(event)
    event.preventDefault()
    event.stopPropagation()
  }
  return handled
}

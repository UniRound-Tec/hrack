import { useTerminalsStore } from '../state/terminalsStore'

const handledEvents = new WeakSet<KeyboardEvent>()

function activateRelativeTab(delta: number): void {
  const state = useTerminalsStore.getState()
  if (state.terminals.length < 2) return
  const currentIndex = state.terminals.findIndex(
    (terminal) => terminal.id === state.activeTerminalId
  )
  const nextIndex =
    (currentIndex + delta + state.terminals.length) %
    state.terminals.length
  state.activateTerminal(state.terminals[nextIndex].id)
}

function closeActiveTab(): void {
  const state = useTerminalsStore.getState()
  if (state.closeTerminal(state.activeTerminalId)) window.close()
}

export function handleTabShortcut(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown') return false
  if (!event.ctrlKey || event.altKey || event.metaKey) return false
  if (handledEvents.has(event)) return true

  let handled = true
  if (event.shiftKey && event.code === 'KeyT') {
    useTerminalsStore.getState().addTerminal()
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

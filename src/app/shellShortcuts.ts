export interface ShellShortcutActions {
  openNewSession(): void
  closeActiveTerminal(): boolean
  activateRelativeTerminal(delta: number): boolean
}

const handledEvents = new WeakSet<KeyboardEvent>()
let activeActions: ShellShortcutActions | null = null

export function registerShellShortcutActions(
  actions: ShellShortcutActions
): () => void {
  activeActions = actions
  return () => {
    if (activeActions === actions) activeActions = null
  }
}

/** Shared by the window listener and xterm's custom key event handler. */
export function handleShellShortcut(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown') return false
  if (!event.ctrlKey || event.altKey || event.metaKey) return false
  if (handledEvents.has(event)) return true

  let handled = false
  if (event.shiftKey && event.code === 'KeyT') {
    activeActions?.openNewSession()
    handled = activeActions !== null
  } else if (event.shiftKey && event.code === 'KeyW') {
    handled = activeActions?.closeActiveTerminal() ?? false
  } else if (event.code === 'Tab') {
    handled =
      activeActions?.activateRelativeTerminal(event.shiftKey ? -1 : 1) ??
      false
  }

  if (handled) {
    handledEvents.add(event)
    event.preventDefault()
    event.stopPropagation()
  }
  return handled
}

import { useEffect } from 'react'
import TerminalView from './terminal/TerminalView'
import { useTerminalsStore } from './state/terminalsStore'
import TabBar from './tabs/TabBar'
import { handleTabShortcut } from './tabs/tabShortcuts'
import TitleBar from './app/TitleBar'

export default function App() {
  const terminals = useTerminalsStore((state) => state.terminals)
  const activeTerminalId = useTerminalsStore(
    (state) => state.activeTerminalId
  )
  const addTerminal = useTerminalsStore((state) => state.addTerminal)

  useEffect(() => {
    const handleWindowShortcut = (event: KeyboardEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest('.xterm')) return
      handleTabShortcut(event)
    }
    window.addEventListener('keydown', handleWindowShortcut)
    return () => window.removeEventListener('keydown', handleWindowShortcut)
  }, [])

  return (
    <div className="app-shell flex h-full w-full flex-col">
      <TitleBar onNew={() => addTerminal()} />
      <TabBar />
      <div className="min-h-0 flex-1">
        {terminals.map((terminal) => (
          <div
            key={terminal.id}
            className="h-full w-full"
            style={{
              display:
                terminal.id === activeTerminalId ? 'block' : 'none'
            }}
          >
            <TerminalView
              tabId={terminal.id}
              active={terminal.id === activeTerminalId}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

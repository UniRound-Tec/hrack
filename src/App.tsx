import { useEffect } from 'react'
import TerminalView from './terminal/TerminalView'
import { useTabsStore } from './state/tabsStore'
import TabBar from './tabs/TabBar'
import { handleTabShortcut } from './tabs/tabShortcuts'
import TitleBar from './app/TitleBar'

export default function App() {
  const tabs = useTabsStore((state) => state.tabs)
  const activeTabId = useTabsStore((state) => state.activeTabId)
  const addTab = useTabsStore((state) => state.addTab)

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
      <TitleBar onNew={addTab} />
      <TabBar />
      <div className="min-h-0 flex-1">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="h-full w-full"
            style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
          >
            <TerminalView tabId={tab.id} active={tab.id === activeTabId} />
          </div>
        ))}
      </div>
    </div>
  )
}

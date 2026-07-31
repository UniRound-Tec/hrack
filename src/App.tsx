import { useEffect } from 'react'
import TerminalView from './terminal/TerminalView'
import { useTabsStore } from './state/tabsStore'
import TabBar from './tabs/TabBar'
import { handleTabShortcut } from './tabs/tabShortcuts'

export default function App() {
  const tabs = useTabsStore((state) => state.tabs)
  const activeTabId = useTabsStore((state) => state.activeTabId)

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
    <div className="flex h-full w-full flex-col bg-[#0b0e14]">
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

import { useState } from 'react'
import { detectLocale, translate } from '../i18n'
import { useTabsStore } from '../state/tabsStore'

export default function TabBar() {
  const [locale] = useState(detectLocale)
  const tabs = useTabsStore((state) => state.tabs)
  const activeTabId = useTabsStore((state) => state.activeTabId)
  const addTab = useTabsStore((state) => state.addTab)
  const closeTab = useTabsStore((state) => state.closeTab)
  const activateTab = useTabsStore((state) => state.activateTab)

  return (
    <div
      role="tablist"
      className="flex h-10 shrink-0 items-stretch border-b border-white/10 bg-[#11151d]"
    >
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              data-exited={tab.exited}
              data-testid="tab-item"
              onClick={() => activateTab(tab.id)}
              className={`flex min-w-32 max-w-56 items-center border-r border-white/10 text-sm ${
                active
                  ? 'bg-[#0b0e14] text-[#e6edf3]'
                  : 'bg-[#11151d] text-[#8b949e] hover:bg-[#171c26]'
              }`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate px-4 text-left"
                onClick={() => activateTab(tab.id)}
              >
                {tab.title}
                {tab.exited ? ` (${translate(locale, 'exited')})` : ''}
              </button>
              <button
                type="button"
                aria-label={`${translate(locale, 'closeTab')}: ${tab.title}`}
                title={`${translate(locale, 'closeTab')}: ${tab.title}`}
                data-testid="tab-close"
                onClick={(event) => {
                  event.stopPropagation()
                  if (closeTab(tab.id)) window.close()
                }}
                className="mx-1 h-7 w-7 shrink-0 rounded text-[#8b949e] hover:bg-white/10 hover:text-[#e6edf3]"
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        aria-label={translate(locale, 'newTab')}
        title={translate(locale, 'newTab')}
        data-testid="tab-new"
        onClick={addTab}
        className="w-10 shrink-0 text-lg text-[#8b949e] hover:bg-[#171c26] hover:text-[#e6edf3]"
      >
        +
      </button>
    </div>
  )
}

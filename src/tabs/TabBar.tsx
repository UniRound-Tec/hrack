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
      className="tab-bar flex h-10 shrink-0 items-stretch border-b"
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
              className={`tab-item flex min-w-32 max-w-56 items-center border-r text-sm ${
                active
                  ? 'tab-item-active'
                  : 'tab-item-inactive'
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
                className="tab-action mx-1 h-7 w-7 shrink-0 rounded"
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
        className="tab-new w-10 shrink-0 text-lg"
      >
        +
      </button>
    </div>
  )
}

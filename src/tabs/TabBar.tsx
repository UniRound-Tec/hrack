import { useState } from 'react'
import { detectLocale, translate } from '../i18n'
import { useTerminalsStore } from '../state/terminalsStore'

export default function TabBar() {
  const [locale] = useState(detectLocale)
  const terminals = useTerminalsStore((state) => state.terminals)
  const activeTerminalId = useTerminalsStore(
    (state) => state.activeTerminalId
  )
  const addTerminal = useTerminalsStore((state) => state.addTerminal)
  const closeTerminal = useTerminalsStore((state) => state.closeTerminal)
  const activateTerminal = useTerminalsStore(
    (state) => state.activateTerminal
  )

  return (
    <div
      role="tablist"
      className="tab-bar flex h-10 shrink-0 items-stretch border-b"
    >
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {terminals.map((terminal) => {
          const active = terminal.id === activeTerminalId
          return (
            <div
              key={terminal.id}
              role="tab"
              aria-selected={active}
              data-exited={terminal.exited}
              data-testid="tab-item"
              onClick={() => activateTerminal(terminal.id)}
              className={`tab-item flex min-w-32 max-w-56 items-center border-r text-sm ${
                active
                  ? 'tab-item-active'
                  : 'tab-item-inactive'
              }`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate px-4 text-left"
                onClick={() => activateTerminal(terminal.id)}
              >
                {terminal.name}
                {terminal.exited
                  ? ` (${translate(locale, 'exited')})`
                  : ''}
              </button>
              <button
                type="button"
                aria-label={`${translate(locale, 'closeTab')}: ${terminal.name}`}
                title={`${translate(locale, 'closeTab')}: ${terminal.name}`}
                data-testid="tab-close"
                onClick={(event) => {
                  event.stopPropagation()
                  if (closeTerminal(terminal.id)) window.close()
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
        onClick={() => addTerminal()}
        className="tab-new w-10 shrink-0 text-lg"
      >
        +
      </button>
    </div>
  )
}

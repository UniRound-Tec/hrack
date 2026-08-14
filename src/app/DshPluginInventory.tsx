import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import {
  listDshPluginInventory,
  type DshPluginFiberPhase,
  type DshPluginInventoryEntry
} from '../dsh/rpc'
import { useStrings, type AppStrings } from './i18n'

function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@')
    ? moduleName.slice(moduleName.indexOf('/') + 1)
    : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '')
}

function phaseLabel(phase: DshPluginFiberPhase, strings: AppStrings): string {
  if (phase === 'pending') return strings.dsh.pluginPending
  if (phase === 'loading') return strings.dsh.pluginLoadingPhase
  if (phase === 'active') return strings.dsh.pluginActive
  if (phase === 'failed') return strings.dsh.pluginFailed
  if (phase === 'unloading') return strings.dsh.pluginUnloading
  return strings.dsh.pluginUnobserved
}

export default function DshPluginInventory() {
  const strings = useStrings()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [entries, setEntries] = useState<DshPluginInventoryEntry[]>([])

  const load = (): void => {
    setStatus('loading')
    setError(null)
    void listDshPluginInventory().then(
      (next) => {
        setEntries(next)
        setStatus('ready')
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setStatus('error')
      }
    )
  }

  useEffect(() => {
    load()
  }, [])

  const normalized = query.trim().toLocaleLowerCase()
  const filtered = useMemo(
    () =>
      entries.filter((entry) => {
        if (!normalized) return true
        return [entry.moduleName, entry.entryId].some((value) =>
          value.toLocaleLowerCase().includes(normalized)
        )
      }),
    [entries, normalized]
  )

  useEffect(() => {
    if (expanded && !filtered.some((entry) => entry.entryId === expanded)) {
      setExpanded(null)
    }
  }, [expanded, filtered])

  if (status === 'loading') {
    return (
      <p className="font-pingfang text-[13px] text-text-faint">{strings.dsh.pluginListLoading}</p>
    )
  }
  if (status === 'error') {
    return (
      <div className="flex items-center gap-3">
        <p className="font-pingfang text-[13px] text-status-error">
          {strings.dsh.pluginListError}
          {error ? ` ${error}` : ''}
        </p>
        <button
          type="button"
          onClick={load}
          className="rounded-lg border border-border-default px-2.5 py-1 font-pingfang text-[12px]"
        >
          {strings.dsh.pluginListRetry}
        </button>
      </div>
    )
  }

  return (
    <div data-testid="dsh-plugin-inventory">
      <label className="mb-4 flex items-center gap-2 rounded-xl border border-border-subtle bg-input px-3 py-2">
        <Search className="size-4 text-text-faint" />
        <input
          type="search"
          value={query}
          placeholder={strings.dsh.pluginListSearch}
          aria-label={strings.dsh.pluginListSearch}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full bg-transparent font-pingfang text-[13px] text-text-primary outline-none"
        />
      </label>
      <div className="mb-3 flex items-baseline gap-2">
        <h3 className="font-pingfang text-[14px] font-medium text-text-primary">
          {strings.dsh.pluginCatalog}
        </h3>
        <span className="font-maple text-[12px] text-text-faint">{filtered.length}</span>
      </div>
      {entries.length === 0 && (
        <p className="font-pingfang text-[13px] text-text-faint">{strings.dsh.pluginListEmpty}</p>
      )}
      {entries.length > 0 && filtered.length === 0 && (
        <p className="font-pingfang text-[13px] text-text-faint">
          {strings.dsh.pluginListEmptySearch}
        </p>
      )}
      <ul className="grid gap-2 md:grid-cols-2">
        {filtered.map((entry) => {
          const title = moduleShortName(entry.moduleName)
          const open = expanded === entry.entryId
          const phase = phaseLabel(entry.fiberPhase, strings)
          const tag = entry.enabled ? strings.dsh.pluginEnabled : strings.dsh.pluginDisabled
          return (
            <li key={entry.entryId}>
              <button
                type="button"
                onClick={() => setExpanded(open ? null : entry.entryId)}
                className="flex w-full items-center justify-between gap-2 rounded-xl border border-border-subtle px-3 py-2.5 text-left hover:bg-surface-strong"
              >
                <span className="min-w-0 truncate font-pingfang text-[13px] text-text-primary" title={entry.moduleName}>
                  {title}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {entry.enabled && (
                    <span
                      className={`size-1.5 rounded-full ${
                        entry.fiberPhase === 'failed'
                          ? 'bg-status-error'
                          : 'bg-status-done-dot'
                      }`}
                      title={phase}
                    />
                  )}
                  <span
                    className={`rounded-full px-1.5 py-0.5 font-pingfang text-[11px] ${
                      entry.enabled
                        ? 'bg-control text-status-done'
                        : 'text-text-faint'
                    }`}
                  >
                    {tag}
                  </span>
                  <ChevronDown
                    className={`size-3 text-text-faint transition-transform ${open ? 'rotate-180' : ''}`}
                  />
                </span>
              </button>
              {open && (
                <div className="border-x border-b border-border-subtle px-3 py-2">
                  <code className="block break-all font-maple text-[11px] text-text-muted">
                    {entry.entryId}
                  </code>
                  <dl className="mt-2 space-y-1 font-pingfang text-[12px] text-text-secondary">
                    <div className="flex justify-between gap-3">
                      <dt>{strings.dsh.pluginConfigState}</dt>
                      <dd>{tag}</dd>
                    </div>
                    {entry.enabled && (
                      <div className="flex justify-between gap-3">
                        <dt>{strings.dsh.pluginCordis}</dt>
                        <dd>{phase}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

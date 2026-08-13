import { useEffect, useState } from 'react'
import type {
  DshHomeMode,
  DshRetentionPolicy,
  DshRuntimeConfig
} from '../../shared/dsh-ipc'
import { useStrings } from './i18n'

export default function DshHostSettings() {
  const strings = useStrings()
  const [config, setConfig] = useState<DshRuntimeConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.dshApi.getConfig().then(setConfig).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [])

  if (!config) {
    return (
      <section
        data-testid="dsh-host-settings"
        className="border-b border-border-subtle px-4 py-3"
      >
        <p className="font-pingfang text-[12px] text-text-faint">
          {strings.dsh.loading}
        </p>
      </section>
    )
  }

  const changeHome = async (mode: DshHomeMode): Promise<void> => {
    if (mode === config.homeMode || config.envOverride) return
    const ok = window.confirm(strings.dsh.homeSwitchConfirm)
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await window.dshApi.setHomeMode(mode)
      window.location.reload()
    } catch (cause) {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const changeRetention = async (policy: DshRetentionPolicy): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setConfig(await window.dshApi.setRetention(policy))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      data-testid="dsh-host-settings"
      className="relative z-[1101] shrink-0 border-b border-border-subtle px-4 py-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-pingfang text-[11px] font-medium text-text-secondary">
            {strings.dsh.homeLabel}
          </p>
          <p
            data-testid="dsh-home-path"
            className="mt-0.5 truncate font-maple text-[11px] text-text-faint"
          >
            {config.activeHome}
          </p>
          {config.envOverride && (
            <p className="mt-1 font-pingfang text-[11px] text-text-muted">
              {strings.dsh.homeEnvOverride}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {(['isolated', 'shared'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                data-testid={`dsh-home-${mode}`}
                disabled={busy || config.envOverride}
                onClick={() => void changeHome(mode)}
                className={`rounded-md px-2 py-1 font-pingfang text-[11px] ${
                  config.homeMode === mode
                    ? 'bg-surface-strong text-text-primary'
                    : 'text-text-faint hover:bg-surface-strong hover:text-text-secondary'
                } disabled:opacity-50`}
              >
                {mode === 'isolated'
                  ? strings.dsh.homeIsolated
                  : strings.dsh.homeShared}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="font-pingfang text-[11px] font-medium text-text-secondary">
            {strings.dsh.retentionLabel}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              data-testid="dsh-retention-kind"
              disabled={busy}
              value={config.retention.kind}
              onChange={(event) => {
                const kind = event.target.value
                if (kind === 'all') void changeRetention({ kind: 'all' })
                if (kind === 'days') void changeRetention({ kind: 'days', days: 30 })
                if (kind === 'count') void changeRetention({ kind: 'count', count: 50 })
              }}
              className="rounded-md border border-border-subtle bg-surface px-2 py-1 font-pingfang text-[11px] text-text-primary"
            >
              <option value="all">{strings.dsh.retentionAll}</option>
              <option value="days">{strings.dsh.retentionDays}</option>
              <option value="count">{strings.dsh.retentionCount}</option>
            </select>
            {config.retention.kind === 'days' && (
              <input
                data-testid="dsh-retention-days"
                type="number"
                min={1}
                max={3650}
                disabled={busy}
                value={config.retention.days}
                onChange={(event) =>
                  void changeRetention({
                    kind: 'days',
                    days: Number(event.target.value)
                  })
                }
                className="w-20 rounded-md border border-border-subtle bg-surface px-2 py-1 font-maple text-[11px] text-text-primary"
              />
            )}
            {config.retention.kind === 'count' && (
              <input
                data-testid="dsh-retention-count"
                type="number"
                min={1}
                max={5000}
                disabled={busy}
                value={config.retention.count}
                onChange={(event) =>
                  void changeRetention({
                    kind: 'count',
                    count: Number(event.target.value)
                  })
                }
                className="w-20 rounded-md border border-border-subtle bg-surface px-2 py-1 font-maple text-[11px] text-text-primary"
              />
            )}
          </div>
        </div>
      </div>
      {error && (
        <p
          data-testid="dsh-host-settings-error"
          className="mt-2 font-pingfang text-[11px] text-status-error"
        >
          {error}
        </p>
      )}
    </section>
  )
}

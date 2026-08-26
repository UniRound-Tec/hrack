import { useEffect, useMemo, useState } from 'react'
import {
  REMOTE_DESKTOP_IDLE_STATE,
  type RemoteDesktopState
} from '../../shared/ipc-contract'
import { parseJoinUrl } from '../../shared/remote-protocol'
import { useSettingsStore } from '../state/settingsStore'
import { useStrings } from './i18n'
import RemoteJoinQr from './RemoteJoinQr'

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB'] as const
  let value = bytes / 1_024
  let unitIndex = 0
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024
    unitIndex += 1
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

export default function RemoteSettingsSection() {
  const strings = useStrings()
  const joinUrl = useSettingsStore((state) => state.remoteJoinUrl)
  const setRemoteJoinUrl = useSettingsStore((state) => state.setRemoteJoinUrl)
  const [state, setState] = useState<RemoteDesktopState>(
    REMOTE_DESKTOP_IDLE_STATE
  )
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    void window.remoteApi.getState().then(setState)
    return window.remoteApi.onStateChange(setState)
  }, [])

  const parsed = useMemo(() => parseJoinUrl(joinUrl), [joinUrl])
  const canConnect = parsed.ok
  const busy = state.phase === 'connecting' || state.phase === 'revoking'
  const connected =
    state.phase === 'connecting' ||
    state.phase === 'waiting-phone' ||
    state.phase === 'peer-online' ||
    state.phase === 'revoking'

  const statusText = (() => {
    switch (state.phase) {
      case 'connecting':
        return strings.settings.remoteStatusConnecting
      case 'waiting-phone':
        return strings.settings.remoteStatusWaitingPhone
      case 'peer-online':
        return strings.settings.remoteStatusPeerOnline
      case 'revoking':
        return strings.settings.remoteStatusRevoking
      case 'error':
        return state.error
          ? strings.settings.remoteError(state.error)
          : strings.settings.remoteStatusIdle
      default:
        return strings.settings.remoteStatusIdle
    }
  })()
  const statusDotClass = (() => {
    switch (state.phase) {
      case 'waiting-phone':
      case 'peer-online':
        return 'bg-status-done'
      case 'connecting':
      case 'revoking':
        return 'animate-pulse bg-status-needs-you'
      case 'error':
        return 'bg-status-error'
      default:
        return 'bg-text-disabled'
    }
  })()

  const requestConnect = (): void => {
    if (!canConnect || busy) return
    setConfirming(true)
  }

  const confirmConnect = (): void => {
    setConfirming(false)
    void window.remoteApi.connect(joinUrl).then(setState)
  }

  return (
    <div data-testid="settings-remote">
      <div className="border-b border-border-faint py-3.5">
        <p className="font-pingfang text-[12px] font-medium text-text-secondary">
          {strings.settings.remoteUrl}
        </p>
        <p className="mt-0.5 font-pingfang text-[11px] text-text-faint">
          {strings.settings.remoteUrlHintBefore}
          <a
            data-testid="settings-remote-create-url"
            href="https://hrack.dev/"
            target="_blank"
            rel="noreferrer"
            className="cursor-target text-text-secondary underline decoration-border-strong underline-offset-2 transition-colors hover:text-text-primary"
          >
            hrack.dev
          </a>
          {strings.settings.remoteUrlHintAfter}
        </p>
        <input
          data-testid="settings-remote-url"
          type="url"
          value={joinUrl}
          disabled={connected}
          onChange={(event) => setRemoteJoinUrl(event.target.value)}
          className="mt-2 w-full rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-maple text-[12px] text-text-primary outline-none focus:border-border-strong disabled:opacity-60"
        />
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="settings-remote-connect"
            disabled={!canConnect || connected}
            onClick={requestConnect}
            className="cursor-target rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {strings.settings.remoteConnect}
          </button>
          <button
            type="button"
            data-testid="settings-remote-disconnect"
            disabled={!connected || busy}
            onClick={() => {
              void window.remoteApi.disconnect().then(setState)
            }}
            className="cursor-target rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {strings.settings.remoteDisconnect}
          </button>
        </div>
        <div
          data-testid="settings-remote-metrics"
          className="mt-3 grid grid-cols-[minmax(0,1.35fr)_minmax(90px,0.65fr)_minmax(160px,1fr)] overflow-hidden rounded-xl border border-border-faint bg-content"
        >
          <div className="min-w-0 px-3 py-2.5">
            <p className="font-pingfang text-[10px] text-text-faint">
              {strings.settings.remoteConnection}
            </p>
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              <span
                data-testid="settings-remote-indicator"
                aria-hidden="true"
                className={`size-1.5 shrink-0 rounded-full ${statusDotClass}`}
              />
              <p
                data-testid="settings-remote-status"
                data-remote-phase={state.phase}
                className={`truncate font-pingfang text-[11px] font-medium ${
                  state.phase === 'error'
                    ? 'text-status-error'
                    : 'text-text-secondary'
                }`}
              >
                {statusText}
              </p>
            </div>
          </div>
          <div className="border-l border-border-faint px-3 py-2.5">
            <p className="font-pingfang text-[10px] text-text-faint">
              {strings.settings.remoteLatency}
            </p>
            <p
              data-testid="settings-remote-latency"
              className="mt-1 font-maple text-[11px] font-medium text-text-secondary tabular-nums"
            >
              {state.latencyMs === null ? '—' : `${state.latencyMs} ms`}
            </p>
          </div>
          <div className="border-l border-border-faint px-3 py-2.5">
            <p className="font-pingfang text-[10px] text-text-faint">
              {strings.settings.remoteTraffic}
            </p>
            <p
              data-testid="settings-remote-traffic"
              className="mt-1 whitespace-nowrap font-maple text-[11px] font-medium text-text-secondary tabular-nums"
            >
              ↑ {formatBytes(state.uploadedBytes)} · ↓{' '}
              {formatBytes(state.downloadedBytes)}
            </p>
          </div>
        </div>
      </div>
      {parsed.ok && (
        <div className="border-b border-border-faint py-3.5 last:border-b-0">
          <p className="font-pingfang text-[12px] font-medium text-text-secondary">
            {strings.settings.remoteQr}
          </p>
          <p className="mt-0.5 font-pingfang text-[11px] text-text-faint">
            {strings.settings.remoteQrHint}
          </p>
          <div className="mt-2">
            <RemoteJoinQr url={parsed.value.href} />
          </div>
        </div>
      )}
      {confirming && parsed.ok && (
        <div
          data-testid="settings-remote-confirm"
          className="fixed inset-0 z-[80] flex items-center justify-center bg-backdrop-strong p-5"
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-[420px] rounded-2xl border border-border-default bg-surface p-4 shadow-2xl"
          >
            <h2 className="font-pingfang text-[14px] font-semibold text-text-primary">
              {strings.settings.remoteConfirmTitle}
            </h2>
            <p className="mt-2 font-pingfang text-[12px] text-text-secondary">
              {strings.settings.remoteConfirmBody(parsed.value.origin)}
            </p>
            <div className="mt-4 flex justify-end gap-1.5">
              <button
                type="button"
                data-testid="settings-remote-confirm-cancel"
                onClick={() => setConfirming(false)}
                className="rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-text-muted"
              >
                {strings.common.cancel}
              </button>
              <button
                type="button"
                data-testid="settings-remote-confirm-accept"
                onClick={confirmConnect}
                className="rounded-lg bg-button-primary px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-button-primary-fg"
              >
                {strings.common.confirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

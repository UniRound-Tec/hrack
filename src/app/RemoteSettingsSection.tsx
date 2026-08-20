import { useEffect, useMemo, useState } from 'react'
import type { RemoteDesktopState } from '../../shared/ipc-contract'
import { parseJoinUrl } from '../../shared/remote-protocol'
import { useSettingsStore } from '../state/settingsStore'
import { useStrings } from './i18n'
import RemoteJoinQr from './RemoteJoinQr'

const IDLE: RemoteDesktopState = {
  phase: 'idle',
  href: null,
  origin: null,
  error: null
}

export default function RemoteSettingsSection() {
  const strings = useStrings()
  const joinUrl = useSettingsStore((state) => state.remoteJoinUrl)
  const setRemoteJoinUrl = useSettingsStore((state) => state.setRemoteJoinUrl)
  const [state, setState] = useState<RemoteDesktopState>(IDLE)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    void window.remoteApi.getState().then(setState)
    return window.remoteApi.onStateChange(setState)
  }, [])

  const parsed = useMemo(() => parseJoinUrl(joinUrl), [joinUrl])
  const canConnect = parsed.ok
  const busy = state.phase === 'connecting'
  const connected =
    state.phase === 'connecting' ||
    state.phase === 'waiting-phone' ||
    state.phase === 'peer-online'

  const statusText = (() => {
    switch (state.phase) {
      case 'connecting':
        return strings.settings.remoteStatusConnecting
      case 'waiting-phone':
        return strings.settings.remoteStatusWaitingPhone
      case 'peer-online':
        return strings.settings.remoteStatusPeerOnline
      case 'error':
        return strings.settings.remoteError(state.error ?? 'error')
      default:
        return strings.settings.remoteStatusIdle
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
          {strings.settings.remoteUrlHint}
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
            disabled={!connected}
            onClick={() => {
              void window.remoteApi.disconnect().then(setState)
            }}
            className="cursor-target rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {strings.settings.remoteDisconnect}
          </button>
          <button
            type="button"
            data-testid="settings-remote-revoke"
            disabled={!connected}
            onClick={() => {
              void window.remoteApi.revoke().then(setState)
            }}
            className="cursor-target rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {strings.settings.remoteRevoke}
          </button>
        </div>
        <p
          data-testid="settings-remote-status"
          data-remote-phase={state.phase}
          className={`mt-2 font-pingfang text-[11px] ${
            state.phase === 'error' ? 'text-status-error' : 'text-text-faint'
          }`}
        >
          {statusText}
        </p>
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

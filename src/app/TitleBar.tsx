import { useEffect, useState } from 'react'
import {
  PanelRightClose,
  PanelRightOpen,
  Settings2,
  SquarePen
} from 'lucide-react'
import { useStrings } from './i18n'

interface TitleBarProps {
  onNew: () => void
  onSettings?: () => void
  settingsActive?: boolean
  onToggleCode?: () => void
  codeOpen?: boolean
}

export default function TitleBar({
  onNew,
  onSettings,
  settingsActive = false,
  onToggleCode,
  codeOpen = false
}: TitleBarProps) {
  const strings = useStrings()
  const [maximized, setMaximized] = useState(false)
  const [fullScreen, setFullScreen] = useState(false)
  const isMac = window.windowApi.platform === 'darwin'

  useEffect(() => {
    let active = true
    void window.windowApi
      .isMaximized()
      .then((value) => {
        if (active) setMaximized(value)
      })
      .catch(() => {})
    void window.windowApi
      .isFullScreen()
      .then((value) => {
        if (active) setFullScreen(value)
      })
      .catch(() => {})
    const unsubscribeMaximized =
      window.windowApi.onMaximizedChange(setMaximized)
    const unsubscribeFullScreen =
      window.windowApi.onFullScreenChange(setFullScreen)
    return () => {
      active = false
      unsubscribeMaximized()
      unsubscribeFullScreen()
    }
  }, [])

  return (
    <header
      data-testid="titlebar"
      className={`titlebar relative flex h-10 shrink-0 items-stretch select-none ${
        isMac
          ? `titlebar-macos ${fullScreen ? 'titlebar-macos-fullscreen' : ''}`
          : ''
      }`}
    >
      <nav className="app-no-drag titlebar-actions flex items-center gap-1 px-3 font-pingfang">
        <button
          type="button"
          data-testid="titlebar-new"
          onClick={onNew}
          className="titlebar-action cursor-target flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors"
        >
          <SquarePen className="size-3.5" strokeWidth={1.75} />
          {strings.titlebar.newSession}
        </button>
        <button
          type="button"
          data-testid="titlebar-settings"
          disabled={!onSettings}
          aria-pressed={settingsActive}
          onClick={onSettings}
          className={`titlebar-action cursor-target flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors ${
            settingsActive ? 'titlebar-action-active' : ''
          }`}
        >
          <Settings2 className="size-3.5" strokeWidth={1.75} />
          {strings.titlebar.settings}
        </button>
      </nav>

      {/* drag 区域不会向 renderer 派发 pointer event；双击语义由原生 WM 决定。 */}
      <div
        className="app-drag-region min-w-8 flex-1"
        data-testid="titlebar-drag-region"
      />

      {onToggleCode && (
        <div className="app-no-drag flex items-center px-1">
          <button
            type="button"
            data-testid="titlebar-code"
            aria-pressed={codeOpen}
            title={
              codeOpen
                ? strings.workspaceReader.hide
                : strings.workspaceReader.show
            }
            onClick={onToggleCode}
            className={`titlebar-action cursor-target flex items-center gap-1.5 rounded-md px-2 py-1 font-pingfang text-[11px] transition-colors ${
              codeOpen ? 'titlebar-action-active' : ''
            }`}
          >
            {codeOpen ? (
              <PanelRightClose className="size-3.5" strokeWidth={1.7} />
            ) : (
              <PanelRightOpen className="size-3.5" strokeWidth={1.7} />
            )}
            {strings.workspaceReader.code}
          </button>
        </div>
      )}

      {!isMac && (
        <div
          className="app-no-drag flex items-stretch"
          data-testid="window-controls"
        >
          <button
            type="button"
            data-testid="window-minimize"
            aria-label={strings.titlebar.minimize}
            title={strings.titlebar.minimize}
            onClick={() => void window.windowApi.minimize()}
            className="window-control"
          >
            <span className="window-control-minimize" />
          </button>
          <button
            type="button"
            data-testid="window-toggle-maximize"
            aria-label={
              maximized ? strings.titlebar.restore : strings.titlebar.maximize
            }
            title={
              maximized ? strings.titlebar.restore : strings.titlebar.maximize
            }
            onClick={() => void window.windowApi.toggleMaximize()}
            className="window-control"
          >
            <span
              className={
                maximized ? 'window-control-restore' : 'window-control-maximize'
              }
            />
          </button>
          <button
            type="button"
            data-testid="window-close"
            aria-label={strings.titlebar.close}
            title={strings.titlebar.close}
            onClick={() => void window.windowApi.close()}
            className="window-control window-control-close"
          >
            <span className="window-control-close-icon" />
          </button>
        </div>
      )}
    </header>
  )
}

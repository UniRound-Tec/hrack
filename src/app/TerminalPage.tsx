import TerminalView from '../terminal/TerminalView'
import TerminalBackgroundLayer from '../terminal/TerminalBackgroundLayer'
import { getTerminalTheme } from '../terminal/themes'
import { useSettingsStore } from '../state/settingsStore'
import type { TerminalEntry } from '../state/terminalsStore'
import WorkspaceReaderLayout from '../workspace-reader/WorkspaceReaderLayout'
import { getTerminalLaunch } from '../state/terminalLaunchRegistry'
import { useWorkspaceReaderStore } from '../workspace-reader/workspaceReaderStore'
import { hasTerminalBackground } from '../../shared/terminal-background'
import type { RemoteDriveState } from '../../shared/ipc-contract'
import { useStrings } from './i18n'

interface TerminalPageProps {
  terminal: TerminalEntry
  active: boolean
  remoteDrive: RemoteDriveState
  onInitialSpawn?: (terminalId: string, error: string | null) => void
  onExit?: (terminalId: string) => void
}

/** Keep every xterm/PTY mounted; page routing only changes CSS visibility. */
export default function TerminalPage({
  terminal,
  active,
  remoteDrive,
  onInitialSpawn,
  onExit
}: TerminalPageProps) {
  const strings = useStrings()
  const rounded = useSettingsStore((state) => state.terminalRounded)
  const terminalThemeId = useSettingsStore((state) => state.terminalThemeId)
  const backgroundName = useSettingsStore((state) => state.terminalBackgroundName)
  const backgroundRevision = useSettingsStore(
    (state) => state.terminalBackgroundRevision
  )
  const backgroundFit = useSettingsStore((state) => state.terminalBackgroundFit)
  const backgroundOpacity = useSettingsStore(
    (state) => state.terminalBackgroundOpacity
  )
  const background = getTerminalTheme(terminalThemeId).terminal.background
  const showBackground = hasTerminalBackground(
    backgroundName,
    backgroundRevision
  )
  const launch = getTerminalLaunch(terminal.id)
  const hasWorkspace =
    Boolean(terminal.cwd) &&
    (launch?.kind === 'agent' || (launch?.kind === 'attach' && launch.agent))
  const readerOpen = useWorkspaceReaderStore(
    (state) => state.sessions[terminal.id]?.open ?? false
  )
  const driven =
    remoteDrive.phase === 'driven' && remoteDrive.terminalId === terminal.id
  const terminalSurface = (
    <div
      className={`relative h-full w-full overflow-hidden ${
        showBackground ? 'terminal-has-background' : ''
      } ${
        rounded
          ? `pt-2 pl-3.5 ${hasWorkspace && readerOpen ? '' : 'pr-3.5'}`
          : ''
      }`}
    >
      {showBackground && (
        <TerminalBackgroundLayer
          testId="terminal-background-image"
          revision={backgroundRevision}
          fit={backgroundFit}
          opacity={backgroundOpacity}
        />
      )}
      <div className="relative h-full w-full">
        <TerminalView
          tabId={terminal.id}
          active={active}
          remoteDrive={driven ? remoteDrive : null}
          onInitialSpawn={onInitialSpawn}
          onExit={onExit}
        />
        {driven && (
          <div
            data-testid="terminal-remote-overlay"
            className="absolute inset-0 z-20 flex items-start justify-center bg-black/5 pt-3"
          >
            <div className="flex items-center gap-2 rounded-xl border border-border-default bg-surface/95 px-3 py-2 shadow-lg backdrop-blur">
              <span className="font-pingfang text-[12px] text-text-secondary">
                {strings.terminal.remoteDriven}
              </span>
              <button
                type="button"
                data-testid="terminal-remote-reclaim"
                onClick={() => {
                  void window.remoteApi.reclaim(remoteDrive.sessionId)
                }}
                className="cursor-target rounded-lg bg-brand px-2.5 py-1 font-pingfang text-[11px] font-semibold text-white hover:opacity-90"
              >
                {strings.terminal.remoteReclaim}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
  return (
    <div
      data-testid="terminal-page"
      data-terminal-id={terminal.id}
      className="absolute inset-0 h-full w-full select-text"
      style={{ display: active ? 'block' : 'none', background }}
    >
      {hasWorkspace ? (
        <WorkspaceReaderLayout terminalId={terminal.id} active={active}>
          {terminalSurface}
        </WorkspaceReaderLayout>
      ) : (
        terminalSurface
      )}
    </div>
  )
}

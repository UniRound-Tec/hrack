import TerminalView from '../terminal/TerminalView'
import { getTerminalTheme } from '../terminal/themes'
import { useSettingsStore } from '../state/settingsStore'
import type { TerminalEntry } from '../state/terminalsStore'
import WorkspaceReaderLayout from '../workspace-reader/WorkspaceReaderLayout'
import { getTerminalLaunch } from '../state/terminalLaunchRegistry'
import { useWorkspaceReaderStore } from '../workspace-reader/workspaceReaderStore'

interface TerminalPageProps {
  terminal: TerminalEntry
  active: boolean
  onInitialSpawn?: (terminalId: string, error: string | null) => void
}

/** Keep every xterm/PTY mounted; page routing only changes CSS visibility. */
export default function TerminalPage({
  terminal,
  active,
  onInitialSpawn
}: TerminalPageProps) {
  const rounded = useSettingsStore((state) => state.terminalRounded)
  const terminalThemeId = useSettingsStore((state) => state.terminalThemeId)
  const background = getTerminalTheme(terminalThemeId).terminal.background
  const launch = getTerminalLaunch(terminal.id)
  const hasWorkspace =
    Boolean(terminal.cwd) &&
    (launch?.kind === 'agent' || (launch?.kind === 'attach' && launch.agent))
  const readerOpen = useWorkspaceReaderStore(
    (state) => state.sessions[terminal.id]?.open ?? false
  )
  const terminalSurface = (
    <div
      className={
        rounded
          ? `h-full w-full pt-2 pl-3.5 ${hasWorkspace && readerOpen ? '' : 'pr-3.5'}`
          : 'h-full w-full'
      }
    >
      <TerminalView
        tabId={terminal.id}
        active={active}
        onInitialSpawn={onInitialSpawn}
      />
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

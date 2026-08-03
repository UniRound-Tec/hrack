import TerminalView from '../terminal/TerminalView'
import { getTerminalTheme } from '../terminal/themes'
import { useSettingsStore } from '../state/settingsStore'
import type { TerminalEntry } from '../state/terminalsStore'

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

  return (
    <div
      data-testid="terminal-page"
      data-terminal-id={terminal.id}
      className="absolute inset-0 h-full w-full select-text"
      style={{ display: active ? 'block' : 'none', background }}
    >
      {/* 圆角开：留白让字符躲开内容区 20px 圆角的裁切；留白区域由外层的终端底色填充 */}
      <div className={rounded ? 'h-full w-full pt-2 pr-3.5 pl-3.5' : 'h-full w-full'}>
        <TerminalView
          tabId={terminal.id}
          active={active}
          onInitialSpawn={onInitialSpawn}
        />
      </div>
    </div>
  )
}

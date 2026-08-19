import { getTerminalTheme } from './themes'
import { useSettingsStore } from '../state/settingsStore'
import { hasTerminalBackground } from '../../shared/terminal-background'
import TerminalBackgroundLayer from './TerminalBackgroundLayer'
import { useStrings } from '../app/i18n'

export default function TerminalBackgroundPreview() {
  const strings = useStrings()
  const name = useSettingsStore((state) => state.terminalBackgroundName)
  const revision = useSettingsStore((state) => state.terminalBackgroundRevision)
  const fit = useSettingsStore((state) => state.terminalBackgroundFit)
  const opacity = useSettingsStore((state) => state.terminalBackgroundOpacity)
  const themeId = useSettingsStore((state) => state.terminalThemeId)
  const theme = getTerminalTheme(themeId).terminal
  const show = hasTerminalBackground(name, revision)

  return (
    <div
      data-testid="settings-terminal-background-preview"
      role="img"
      aria-label={strings.settings.terminalBackgroundPreview}
      className="relative h-[72px] w-[128px] shrink-0 overflow-hidden rounded-md border border-border-default"
      style={{ background: theme.background }}
    >
      {show && (
        <TerminalBackgroundLayer
          revision={revision}
          fit={fit}
          opacity={opacity}
        />
      )}
      <p
        className="relative px-1.5 py-1 font-maple text-[8px] leading-3"
        style={{ color: theme.foreground }}
      >
        {'PS C:\\>'}
      </p>
    </div>
  )
}

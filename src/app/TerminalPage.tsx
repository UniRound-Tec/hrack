import TerminalView from '../terminal/TerminalView'
import type { TerminalEntry } from '../state/terminalsStore'

interface TerminalPageProps {
  terminal: TerminalEntry
  active: boolean
}

/** Keep every xterm/PTY mounted; page routing only changes CSS visibility. */
export default function TerminalPage({
  terminal,
  active
}: TerminalPageProps) {
  return (
    <div
      data-testid="terminal-page"
      data-terminal-id={terminal.id}
      className="absolute inset-0 h-full w-full"
      style={{ display: active ? 'block' : 'none' }}
    >
      <TerminalView tabId={terminal.id} active={active} />
    </div>
  )
}

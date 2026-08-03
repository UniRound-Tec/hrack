import { useCallback, useEffect, useRef, useState } from 'react'
import { useStrings } from '../app/i18n'
import { useSettingsStore } from '../state/settingsStore'
import { useTerminalsStore } from '../state/terminalsStore'
import { useSessionsStore } from '../state/sessionsStore'
import { useXterm } from './useXterm'

/** xterm 宿主容器：一个占满父级的 div，内部由 xterm 独占渲染。 */
interface TerminalViewProps {
  tabId: string
  active: boolean
}

export default function TerminalView({ tabId, active }: TerminalViewProps) {
  const ref = useRef<HTMLDivElement>(null)
  const hideCopiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const language = useSettingsStore((state) => state.language)
  const strings = useStrings()
  const [copiedVisible, setCopiedVisible] = useState(false)
  const setTitle = useTerminalsStore((state) => state.setTitle)
  const markExited = useTerminalsStore((state) => state.markExited)

  const showCopied = useCallback(() => {
    if (hideCopiedTimer.current) clearTimeout(hideCopiedTimer.current)
    setCopiedVisible(true)
    hideCopiedTimer.current = setTimeout(() => {
      hideCopiedTimer.current = null
      setCopiedVisible(false)
    }, 1600)
  }, [])

  useEffect(() => {
    document.documentElement.lang = language
    return () => {
      if (hideCopiedTimer.current) clearTimeout(hideCopiedTimer.current)
    }
  }, [language])

  useXterm(
    ref,
    tabId,
    active,
    showCopied,
    (title) => setTitle(tabId, title),
    (code, respawned) => {
      if (!respawned) markExited(tabId)
      const sessionIds = useSessionsStore
        .getState()
        .sessions.filter((session) => session.terminalId === tabId)
        .map((session) => session.sessionId)
      for (const sessionId of sessionIds) {
        useSessionsStore.getState().markExited(sessionId, code)
        // M5.c：会话退出写历史事件（detail 带 exit code）；respawn 不算会话结束。
        if (!respawned) {
          const session = useSessionsStore.getState().sessions.find(
            (entry) => entry.sessionId === sessionId
          )
          void window.statsApi.recordEvent({
            kind: 'session_exit',
            adapterId: session?.adapterId ?? 'unknown',
            title: session?.name ?? 'Session',
            detail:
              code === undefined ? 'exit' : `exit code ${code}`
          })
        }
      }
    }
  )

  return (
    <div className="relative h-full w-full" data-tab-id={tabId}>
      <div ref={ref} className="h-full w-full" />
      {copiedVisible && (
        <div
          role="status"
          aria-live="polite"
          data-testid="copy-toast"
          className="copy-toast pointer-events-none absolute right-4 bottom-4 z-10 rounded-md border px-3 py-2 text-sm shadow-lg"
        >
          {strings.terminal.copied}
        </div>
      )}
    </div>
  )
}

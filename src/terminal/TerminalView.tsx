import { useCallback, useEffect, useRef, useState } from 'react'
import { useStrings } from '../app/i18n'
import { useSettingsStore } from '../state/settingsStore'
import { useTerminalsStore } from '../state/terminalsStore'
import { useXterm } from './useXterm'

/** xterm 宿主容器：一个占满父级的 div，内部由 xterm 独占渲染。 */
interface TerminalViewProps {
  tabId: string
  active: boolean
  onInitialSpawn?: (terminalId: string, error: string | null) => void
}

export default function TerminalView({ tabId, active, onInitialSpawn }: TerminalViewProps) {
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
      // S1：AI 会话的退出事实由主进程 AgentSessionRuntime 归约并推送投影，
      // renderer 不再是语义事实来源，不再重复写 markExited / session_exit。
    },
    (error) => onInitialSpawn?.(tabId, error)
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

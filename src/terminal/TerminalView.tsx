import { useCallback, useEffect, useRef, useState } from 'react'
import { detectLocale, translate } from '../i18n'
import { useXterm } from './useXterm'

/** xterm 宿主容器：一个占满父级的 div，内部由 xterm 独占渲染。 */
export default function TerminalView() {
  const ref = useRef<HTMLDivElement>(null)
  const hideCopiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [locale] = useState(detectLocale)
  const [copiedVisible, setCopiedVisible] = useState(false)

  const showCopied = useCallback(() => {
    if (hideCopiedTimer.current) clearTimeout(hideCopiedTimer.current)
    setCopiedVisible(true)
    hideCopiedTimer.current = setTimeout(() => {
      hideCopiedTimer.current = null
      setCopiedVisible(false)
    }, 1600)
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale
    return () => {
      if (hideCopiedTimer.current) clearTimeout(hideCopiedTimer.current)
    }
  }, [locale])

  useXterm(ref, showCopied)

  return (
    <div className="relative h-full w-full">
      <div ref={ref} className="h-full w-full" />
      {copiedVisible && (
        <div
          role="status"
          aria-live="polite"
          data-testid="copy-toast"
          className="copy-toast pointer-events-none absolute right-4 bottom-4 z-10 rounded-md border border-white/10 bg-[#202733]/95 px-3 py-2 text-sm text-[#e6edf3] shadow-lg"
        >
          {translate(locale, 'copied')}
        </div>
      )}
    </div>
  )
}

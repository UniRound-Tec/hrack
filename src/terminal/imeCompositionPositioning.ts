import type { IDisposable, Terminal } from '@xterm/xterm'

/**
 * Aligns browser IME pre-edit with a TUI-rendered caret when the TUI hides the
 * real VT cursor and parks it at the right margin.
 *
 * Pi renders its composer caret as one isolated inverse-video cell. xterm
 * cannot know that this cell is the input position, so its built-in IME helper
 * follows the hidden right-margin cursor instead.
 */
export function installImeCompositionPositioning(
  term: Terminal,
  container: HTMLElement
): IDisposable {
  const textarea = container.querySelector<HTMLTextAreaElement>(
    '.xterm-helper-textarea'
  )
  const composition = container.querySelector<HTMLElement>('.composition-view')
  const screen = container.querySelector<HTMLElement>('.xterm-screen')
  if (!textarea || !composition || !screen) {
    return { dispose: () => {} }
  }

  let active = false
  let deferredSync: number | null = null

  const isHiddenAndParked = (): boolean =>
    !term.modes.showCursor && term.buffer.active.cursorX >= term.cols - 1

  const findRenderedCaret = (): { x: number; y: number } | null => {
    const buffer = term.buffer.active
    for (let y = term.rows - 1; y >= 0; y--) {
      const line = buffer.getLine(buffer.viewportY + y)
      if (!line) continue
      for (let x = term.cols - 1; x >= 0; x--) {
        const cell = line.getCell(x)
        if (!cell?.isInverse()) continue
        const previousIsInverse = x > 0 && Boolean(line.getCell(x - 1)?.isInverse())
        const nextIsInverse =
          x + 1 < term.cols && Boolean(line.getCell(x + 1)?.isInverse())
        if (!previousIsInverse && !nextIsInverse) return { x, y }
      }
    }
    return null
  }

  const sync = (): void => {
    if (!active) return
    if (!isHiddenAndParked()) {
      active = false
      return
    }
    const caret = findRenderedCaret()
    if (!caret) return

    const cellWidth = screen.clientWidth / term.cols
    const cellHeight = screen.clientHeight / term.rows
    const left = caret.x * cellWidth
    const top = caret.y * cellHeight
    composition.style.left = `${left}px`
    composition.style.top = `${top}px`
    composition.style.height = `${cellHeight}px`
    composition.style.lineHeight = `${cellHeight}px`
    composition.style.maxWidth = `${screen.clientWidth - left}px`
    textarea.style.left = `${left}px`
    textarea.style.top = `${top}px`
    textarea.style.width = `${Math.max(composition.getBoundingClientRect().width, 1)}px`
    textarea.style.height = `${Math.max(cellHeight, 1)}px`
    textarea.style.lineHeight = `${cellHeight}px`
  }

  const onCompositionStart = (): void => {
    active = isHiddenAndParked() && findRenderedCaret() !== null
    sync()
    scheduleDeferredSync()
  }
  const scheduleDeferredSync = (): void => {
    if (deferredSync !== null) window.clearTimeout(deferredSync)
    deferredSync = window.setTimeout(() => {
      deferredSync = null
      sync()
    }, 0)
  }
  const onCompositionUpdate = (): void => {
    sync()
    scheduleDeferredSync()
  }
  const onCompositionEnd = (): void => {
    active = false
    if (deferredSync !== null) window.clearTimeout(deferredSync)
    deferredSync = null
  }

  textarea.addEventListener('compositionstart', onCompositionStart)
  textarea.addEventListener('compositionupdate', onCompositionUpdate)
  textarea.addEventListener('compositionend', onCompositionEnd)
  textarea.addEventListener('blur', onCompositionEnd)
  const renderDisposable = term.onRender(sync)

  return {
    dispose: () => {
      active = false
      if (deferredSync !== null) window.clearTimeout(deferredSync)
      deferredSync = null
      renderDisposable.dispose()
      textarea.removeEventListener('compositionstart', onCompositionStart)
      textarea.removeEventListener('compositionupdate', onCompositionUpdate)
      textarea.removeEventListener('compositionend', onCompositionEnd)
      textarea.removeEventListener('blur', onCompositionEnd)
    }
  }
}
